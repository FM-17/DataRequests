const fs = require("fs");
const path = require("path");

// Values of the bot's THREAD_STATUS constants (src/data/constants.js)
const THREAD_STATUS_CLOSED = 2;

// Matches the bot's local attachment URLs: .../attachments/<attachmentId>/<filename>
// (Discord CDN URLs have two numeric segments, so they don't match.)
const LOCAL_ATTACHMENT_URL = /\/attachments\/(\d+)\/[^/]+$/;

const isInside = (dir, filePath) => {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel !== "" && ! rel.startsWith("..") && ! path.isAbsolute(rel);
};

// Returns undefined when the text can't be parsed, so callers can tell that apart from an empty value
const safeParse = (value, label) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn(`[DataRequests] Skipping unparseable ${label}: ${err.message}`);
    return undefined;
  }
};

const toInt = value => parseInt(value, 10) || 0;

/**
 * Answers "what does the bot hold about this user", and removes it.
 * All rules about which files on disk may be deleted live here.
 */
module.exports = function({ knex, config }) {
  // All of the user's threads, whatever their status. `db` is knex or a transaction.
  const userThreads = (db, userId) => db("threads").where("user_id", userId);
  const userThreadIds = (db, userId) => userThreads(db, userId).select("id");

  const getAttachmentDir = () => config.attachmentDir
    || path.resolve(path.dirname(require.main.filename), "..", "attachments");

  // Log files only exist with logStorage = "attachment". The bot writes them to logOptions.attachmentDirectory
  // (default "logs", relative to the working directory). `config.logDir` is only for legacy migration.
  const getLogDir = () => path.resolve(
    process.cwd(),
    (config.logOptions && config.logOptions.attachmentDirectory) || "logs",
  );

  const deleteFile = async filePath => {
    try {
      await fs.promises.unlink(filePath);
      return "deleted";
    } catch (err) {
      if (err.code === "ENOENT") return "missing";
      console.error(`[DataRequests] Could not delete ${filePath}: ${err.message}`);
      return "failed";
    }
  };

  return {
    // IDs of all the user's threads, oldest first
    async threadIds(userId) {
      const rows = await userThreads(knex, userId).orderBy("created_at", "ASC").select("id");
      return rows.map(row => row.id);
    },

    async counts(userId) {
      return {
        threadCount: toInt((await userThreads(knex, userId).count({ c: "*" }).first()).c),
        messageCount: toInt((await knex("thread_messages")
          .whereIn("thread_id", userThreadIds(knex, userId))
          .count({ c: "*" })
          .first()).c),
        noteCount: toInt((await knex("notes").where("user_id", userId).count({ c: "*" }).first()).c),
      };
    },

    // The user's threads that are not closed: id, thread_number, channel_id
    openThreads(userId) {
      return userThreads(knex, userId)
        .whereNot("status", THREAD_STATUS_CLOSED)
        .select("id", "thread_number", "channel_id");
    },

    async hasBlockRecord(userId) {
      return !! await knex("blocked_users").where("user_id", userId).first();
    },

    // Files on disk that belong to the user's threads: saved log files and local attachments.
    // `skipped` counts files that may exist but were left alone (unreadable records or unsafe paths).
    async findFiles(userId) {
      const files = [];
      let skipped = 0;

      const threadRows = await userThreads(knex, userId).select("log_storage_data");
      for (const row of threadRows) {
        const data = safeParse(row.log_storage_data, "log_storage_data");
        if (data === undefined) {
          skipped++;
        } else if (data && typeof data.fullPath === "string") {
          if (isInside(getLogDir(), data.fullPath)) {
            files.push(data.fullPath);
          } else {
            skipped++;
            console.warn(`[DataRequests] Not deleting log file outside the log directory: ${data.fullPath}`);
          }
        }
      }

      if (config.attachmentStorage === "local") {
        const messageRows = await knex("thread_messages")
          .whereIn("thread_id", userThreadIds(knex, userId))
          .whereNotNull("attachments")
          .select("attachments");

        for (const row of messageRows) {
          const urls = safeParse(row.attachments, "attachments");
          if (! Array.isArray(urls)) {
            skipped++;
            continue;
          }
          for (const url of urls) {
            if (typeof url !== "string") continue;
            const match = url.split(/[?#]/)[0].match(LOCAL_ATTACHMENT_URL);
            if (! match) continue;
            const filePath = path.join(getAttachmentDir(), match[1]);
            if (isInside(getAttachmentDir(), filePath)) {
              files.push(filePath);
            } else {
              skipped++;
              console.warn(`[DataRequests] Not deleting attachment outside the attachment directory: ${filePath}`);
            }
          }
        }
      }

      return { files, skipped };
    },

    // Deletes files returned by findFiles
    async removeFiles(files) {
      const result = { deleted: 0, missing: 0, failed: 0 };
      for (const file of files) result[await deleteFile(file)]++;
      return result;
    },

    // Deletes the user's messages, threads and notes. The block record is kept.
    removeRows(userId) {
      return knex.transaction(async trx => {
        await trx("thread_messages").whereIn("thread_id", userThreadIds(trx, userId)).delete();
        await userThreads(trx, userId).delete();
        await trx("notes").where("user_id", userId).delete();
      });
    },
  };
};
