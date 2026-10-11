const fs = require("fs");
const path = require("path");

// Values of the bot's THREAD_STATUS constants (src/data/constants.js)
const THREAD_STATUS_CLOSED = 2;

// Matches the bot's local attachment URLs: .../attachments/<attachmentId>/<filename>
// (Discord CDN URLs have two numeric segments, so they don't match.)
const LOCAL_ATTACHMENT_URL = /\/attachments\/(\d+)\/[^/]+$/;

const USER_DELETION_NOTICE = "Your data has been deleted at your request. "
  + "This includes this conversation, which will now be closed. "
  + "You can send a new message at any time to start a new conversation.";

// When the command is run inside a thread that is about to be closed, wait so the operator can read the notice
const CLOSE_DELAY_SECONDS = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const USER_DATA_MESSAGE = "The requested user data can be found below:";

// Where the plugin remembers the Discord messages it posted containing a user's exported data
const EXPORTS_TABLE = "data_request_exports";

// Discord says the message or its channel no longer exists: the export is already gone
const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_UNKNOWN_MESSAGE = 10008;
const isAlreadyGone = err => err && (
  err.code === DISCORD_UNKNOWN_CHANNEL
  || err.code === DISCORD_UNKNOWN_MESSAGE
  || (err.res && err.res.statusCode === 404)
);

const isInside = (dir, filePath) => {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel !== "" && ! rel.startsWith("..") && ! path.isAbsolute(rel);
};

const safeParse = (value, label) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn(`[DataRequests] Skipping unparseable ${label}: ${err.message}`);
    return null;
  }
};

const toList = value => (value == null ? [] : [].concat(value).map(String));
const toInt = value => parseInt(value, 10) || 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

module.exports = function({ bot, knex, config, commands, threads, formats }) {
  const roleIds = toList(config.dataRequestsRoleId);
  const channelIds = toList(config.dataRequestsChannelId);
  const logChannelId = config.dataRequestsLogChannelId;

  /**
   * Extra gates on top of the bot's own inbox server + inboxServerPermission checks.
   * Every configured gate must pass. Failing is silent, like the bot's built-in prefilters.
   */
  const isAllowed = msg => {
    if (channelIds.length && ! channelIds.includes(msg.channel.id)) return false;
    if (roleIds.length && ! (msg.member && msg.member.roles.some(roleId => roleIds.includes(roleId)))) return false;
    return true;
  };

  const logAction = async text => {
    if (! logChannelId) return;
    try {
      await bot.createMessage(logChannelId, text);
    } catch (err) {
      console.error(`[DataRequests] Could not post to log channel: ${err.message}`);
    }
  };

  // Sends a message with a file, turning Discord's upload-size rejection into a clear error
  const sendFile = async (channel, content, file) => {
    try {
      return await channel.createMessage(content, file);
    } catch (err) {
      if (err.code === 40005 || /too large/i.test(err.message || "")) {
        const tooLarge = new Error("The data file is too large for Discord to upload. Ask the bot host to export it from the database.");
        tooLarge.isTooLarge = true;
        throw tooLarge;
      }
      throw err;
    }
  };

  // The plugin's own table, created on first load. It never touches the bot's tables.
  const exportsReady = (async () => {
    try {
      if (! await knex.schema.hasTable(EXPORTS_TABLE)) {
        await knex.schema.createTable(EXPORTS_TABLE, table => {
          table.increments("id");
          table.string("user_id", 20).notNullable().index();
          table.string("channel_id", 20).notNullable();
          table.string("message_id", 20).notNullable();
          table.string("created_at", 32).notNullable();
        });
      }
      return true;
    } catch (err) {
      console.error(`[DataRequests] Could not prepare the ${EXPORTS_TABLE} table, exports will not be tracked: ${err.message}`);
      return false;
    }
  })();

  // Remembers an exported-data message so deleteuserdata can remove it. Returns whether it was recorded.
  const recordExport = async (userId, channelId, message) => {
    try {
      if (! await exportsReady || ! message || ! message.id || ! channelId) return false;
      await knex(EXPORTS_TABLE).insert({
        user_id: userId,
        channel_id: String(channelId),
        message_id: String(message.id),
        created_at: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      console.error(`[DataRequests] Could not record export message: ${err.message}`);
      return false;
    }
  };

  // Posts a follow-up when an export could not be tracked, so the operator knows to delete it by hand
  const warnIfUntracked = async (channel, recorded) => {
    if (recorded) return;
    await channel.createMessage(
      `⚠ This export could not be tracked, so ${config.prefix}deleteuserdata will not remove it. Delete the message yourself when it is no longer needed.`,
    ).catch(() => {});
  };

  // Rows for the user's exports. `ok` is false when the table could not be read, so callers can warn
  // instead of treating it as "no exports".
  const listExports = async userId => {
    try {
      if (! await exportsReady) return { rows: [], ok: false };
      const rows = await knex(EXPORTS_TABLE).where("user_id", userId).select("id", "channel_id", "message_id");
      return { rows, ok: true };
    } catch (err) {
      console.error(`[DataRequests] Could not read ${EXPORTS_TABLE}: ${err.message}`);
      return { rows: [], ok: false };
    }
  };

  const EXPORTS_UNCHECKED_WARNING = "⚠ Could not check for exported data messages, so any the bot posted in the server "
    + "will not be deleted. Delete them yourself.";

  // Deletes each exported message. Rows are removed only once the message is confirmed gone,
  // so failures stay recorded and a later !deleteuserdata run retries them.
  const deleteExports = async rows => {
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await bot.deleteMessage(row.channel_id, row.message_id);
      } catch (err) {
        if (! isAlreadyGone(err)) {
          failed++;
          console.error(`[DataRequests] Could not delete export message ${row.message_id}: ${err.message}`);
          continue;
        }
      }

      try {
        await knex(EXPORTS_TABLE).where("id", row.id).delete();
        removed++;
      } catch (err) {
        failed++;
        console.error(`[DataRequests] Deleted export message ${row.message_id} but could not remove its record: ${err.message}`);
      }
    }
    return { removed, failed };
  };

  // All commands take an optional user id. In a modmail thread it defaults to the thread's user.
  const addCommand = (name, options, run) => {
    commands.addInboxServerCommand(name, "[userId:userId]", async (msg, args, thread) => {
      if (! isAllowed(msg)) return;

      try {
        const userId = args.userId || (thread && thread.user_id);
        if (! userId) {
          await msg.channel.createMessage(`⚠ Specify a user id, or run ${config.prefix}${name} in a modmail thread`);
          return;
        }

        await run(msg, userId, args);
      } catch (err) {
        console.error(`[DataRequests] ${name} failed:`, err);
        msg.channel.createMessage(`⚠ ${name} failed: ${err.message}`).catch(() => {});
      }
    }, { options });
  };

  // All of the user's threads, whatever their status. `db` is knex or a transaction.
  const userThreads = (db, userId) => db("threads").where("user_id", userId);
  const userThreadIds = (db, userId) => userThreads(db, userId).select("id");

  // The user is allowed to see staff replies, but not who sent the anonymous ones.
  // The log already prints "(Anonymous) <role>:" for these, so only the sender name needs a neutral value.
  // Works on the in-memory copies fetched for this export only, nothing is written back to the database.
  const ANONYMOUS_STAFF_NAME = "Staff";
  const hideAnonymousStaff = message => {
    try {
      if (! message) return;
      if (message.is_anonymous) message.user_name = ANONYMOUS_STAFF_NAME;
      // Edited/deleted reply entries quote the original reply, which carries the sender's name
      const original = message.metadata && message.metadata.originalThreadMessage;
      if (original && original.is_anonymous) original.user_name = ANONYMOUS_STAFF_NAME;
    } catch (err) {
      console.warn(`[DataRequests] Could not anonymize a message: ${err.message}`);
    }
  };

  // The user's data as the text of a `loglink -s` style log: only messages to and from the user, no mod chatter
  const buildUserData = async userId => {
    const rows = await userThreads(knex, userId).orderBy("created_at", "ASC").select("id");

    const logs = [];
    for (const row of rows) {
      const thread = await threads.findById(row.id);
      if (! thread) {
        console.warn(`[DataRequests] Thread ${row.id} not found, skipping`);
        continue;
      }
      const threadMessages = await thread.getThreadMessages();
      threadMessages.forEach(hideAnonymousStaff);
      const result = await formats.formatters.formatLog(thread, threadMessages, { simple: true });
      logs.push(result.content);
    }

    return { threadCount: logs.length, text: logs.join("\n\n") };
  };

  // !getuserdata [userId]
  addCommand("getuserdata", [], async (msg, userId) => {
    const { threadCount, text } = await buildUserData(userId);

    if (threadCount === 0) {
      await msg.channel.createMessage(`No modmail data found for <@${userId}>`);
      return;
    }

    const sent = await sendFile(
      msg.channel,
      `Modmail data for <@${userId}> (${plural(threadCount, "thread")}):`,
      { file: text, name: `userdata-${userId}.txt` },
    );
    await warnIfUntracked(msg.channel, await recordExport(userId, msg.channel.id, sent));
    await logAction(`Data request: User <@${userId}> data requested.`);
  });

  // !senduserdata [userId]
  // Same file as !getuserdata, sent to the user by DM
  addCommand("senduserdata", [], async (msg, userId) => {
    const { threadCount, text } = await buildUserData(userId);

    if (threadCount === 0) {
      await msg.channel.createMessage(`No modmail data found for <@${userId}>`);
      return;
    }

    const dataFile = () => ({ file: text, name: `userdata-${userId}.txt` });

    let dmChannel;
    try {
      dmChannel = await bot.getDMChannel(userId);
    } catch (err) {
      throw new Error("Could not DM the user. They may have blocked the bot or closed their DMs.");
    }
    try {
      await sendFile(dmChannel, USER_DATA_MESSAGE, dataFile());
    } catch (err) {
      if (err.isTooLarge) throw err;
      throw new Error(`Could not DM the user (${err.message}). They may have blocked the bot or closed their DMs.`);
    }

    // Show the operator what was sent, like !reply does
    // Only the operator's copy is tracked. The DM copy belongs to the user and is never deleted by the plugin.
    const echo = await sendFile(msg.channel, `**Sent to <@${userId}>:** ${USER_DATA_MESSAGE}`, dataFile());
    await warnIfUntracked(msg.channel, await recordExport(userId, msg.channel.id, echo));
    await logAction(`Data sent: User <@${userId}> data sent.`);
  });

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

  // Files on disk that belong to the user's threads: saved log files and local attachments
  const findFilesToDelete = async userId => {
    const files = [];

    const threadRows = await userThreads(knex, userId).select("log_storage_data");
    for (const row of threadRows) {
      const data = safeParse(row.log_storage_data, "log_storage_data");
      if (data && typeof data.fullPath === "string") {
        if (isInside(getLogDir(), data.fullPath)) {
          files.push(data.fullPath);
        } else {
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
        if (! Array.isArray(urls)) continue;
        for (const url of urls) {
          if (typeof url !== "string") continue;
          const match = url.split(/[?#]/)[0].match(LOCAL_ATTACHMENT_URL);
          if (! match) continue;
          const filePath = path.join(getAttachmentDir(), match[1]);
          if (isInside(getAttachmentDir(), filePath)) files.push(filePath);
        }
      }
    }

    return files;
  };

  const countUserData = async userId => ({
    threadCount: toInt((await userThreads(knex, userId).count({ c: "*" }).first()).c),
    messageCount: toInt((await knex("thread_messages")
      .whereIn("thread_id", userThreadIds(knex, userId))
      .count({ c: "*" })
      .first()).c),
    noteCount: toInt((await knex("notes").where("user_id", userId).count({ c: "*" }).first()).c),
  });

  // !deleteuserdata [userId] [--confirm]
  // Without --confirm, only reports what would be deleted
  addCommand("deleteuserdata", [{ name: "confirm", isSwitch: true }], async (msg, userId, args) => {
    const counts = await countUserData(userId);
    const { rows: exportRows, ok: exportsChecked } = await listExports(userId);

    if (counts.threadCount === 0 && counts.noteCount === 0 && exportRows.length === 0) {
      let text = `There is no modmail data or notes to delete for <@${userId}>`;
      if (! exportsChecked) text += `\n${EXPORTS_UNCHECKED_WARNING}`;
      await msg.channel.createMessage(text);
      return;
    }

    const openThreads = await userThreads(knex, userId)
      .whereNot("status", THREAD_STATUS_CLOSED)
      .select("id", "thread_number", "channel_id");
    const blockRecord = await knex("blocked_users").where("user_id", userId).first();

    const keptText = blockRecord ? " The block record is kept." : "";

    if (! args.confirm) {
      let text = `Would delete ${plural(counts.threadCount, "thread")}, ${plural(counts.messageCount, "message")} `
        + `and ${plural(counts.noteCount, "note")} for <@${userId}>.${keptText}`;

      if (exportRows.length) {
        text += `\nAlso deletes ${plural(exportRows.length, "exported data message")} this bot posted in the server.`;
      }
      if (! exportsChecked) text += `\n${EXPORTS_UNCHECKED_WARNING}`;

      if (openThreads.length) {
        const list = openThreads
          .map(t => `#${t.thread_number}${t.channel_id === msg.channel.id ? " (this thread)" : ""}`)
          .join(", ");
        text += `\n**Confirming will first message the user that their data is being deleted, including their open `
          + `${openThreads.length === 1 ? "conversation" : "conversations"}, and then close ${list}.**`;
      }

      text += `\nTo proceed, run \`${config.prefix}deleteuserdata ${userId} --confirm\``;
      await msg.channel.createMessage(text);
      return;
    }

    // Tell the user and close their open threads first. Closing saves the thread's log, so the files
    // to delete are only collected afterwards. This may delete the channel this command was run in.
    let notified = true;
    let failedCloses = 0;
    for (const row of openThreads) {
      const thread = await threads.findById(row.id);
      if (! thread) continue;

      try {
        await thread.sendSystemMessageToUser(USER_DELETION_NOTICE);
      } catch (err) {
        notified = false;
        console.error(`[DataRequests] Could not notify user ${userId}: ${err.message}`);
      }

      if (row.channel_id === msg.channel.id) {
        await msg.channel.createMessage(`This thread will be closed and deleted in ${CLOSE_DELAY_SECONDS} seconds.`).catch(() => {});
        await sleep(CLOSE_DELAY_SECONDS * 1000);
      }

      try {
        await thread.close(true);
      } catch (err) {
        failedCloses++;
        console.error(`[DataRequests] Could not close thread ${row.id}: ${err.message}`);
      }
    }

    const finalCounts = await countUserData(userId);
    const files = await findFilesToDelete(userId);

    await knex.transaction(async trx => {
      await trx("thread_messages").whereIn("thread_id", userThreadIds(trx, userId)).delete();
      await userThreads(trx, userId).delete();
      await trx("notes").where("user_id", userId).delete();
    });

    // Re-read the rows: the plugin may have recorded more since the dry run
    const { rows: latestExportRows, ok: exportsStillChecked } = await listExports(userId);
    const exportResult = await deleteExports(latestExportRows);
    const exportsUnchecked = ! exportsChecked || ! exportsStillChecked;

    const results = [];
    for (const file of files) results.push(await deleteFile(file));
    const deletedFiles = results.filter(r => r === "deleted").length;
    const failedFiles = results.filter(r => r === "failed").length;

    let text = `Deleted ${plural(finalCounts.threadCount, "thread")}, ${plural(finalCounts.messageCount, "message")}, `
      + `${plural(finalCounts.noteCount, "note")} and ${plural(deletedFiles, "file")} for <@${userId}>.${keptText}`;
    const closed = openThreads.length - failedCloses;
    if (closed) text += ` Closed ${plural(closed, "open thread")}.`;
    if (failedCloses) text += ` ${plural(failedCloses, "open thread")} could not be closed cleanly (their data was still deleted), see the bot console.`;
    if (exportResult.removed) text += ` Removed ${plural(exportResult.removed, "exported data message")} from Discord.`;
    if (exportResult.failed) {
      text += ` ${plural(exportResult.failed, "exported data message")} could not be deleted and stay recorded: `
        + `run ${config.prefix}deleteuserdata ${userId} --confirm again to retry, see the bot console.`;
    }
    if (exportsUnchecked) text += `\n${EXPORTS_UNCHECKED_WARNING}`;
    if (! notified) text += " **The user could not be notified by DM.**";
    if (failedFiles) text += ` ${plural(failedFiles, "file")} could not be deleted, see the bot console.`;

    // If the command was run in a thread that has now been closed, its channel is gone
    await msg.channel.createMessage(text).catch(() => console.log(`[DataRequests] ${text}`));
    const problems = [];
    if (failedFiles) problems.push(`${plural(failedFiles, "file")} could not be deleted`);
    if (exportResult.failed) problems.push(`${plural(exportResult.failed, "export message")} could not be deleted`);
    if (exportsUnchecked) problems.push("exported data messages could not be checked");
    if (failedCloses) problems.push(`${plural(failedCloses, "thread")} could not be closed cleanly`);
    await logAction(`Data deletion: User <@${userId}> data deleted${problems.length ? ` (${problems.join(", ")})` : "."}`);
  });
};
