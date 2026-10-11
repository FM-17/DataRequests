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

  // The user's data as the text of a `loglink -s` style log: only messages to and from the user, no mod chatter
  const buildUserData = async userId => {
    const rows = await userThreads(knex, userId).orderBy("created_at", "ASC").select("id");

    const logs = [];
    for (const row of rows) {
      const thread = await threads.findById(row.id);
      const threadMessages = await thread.getThreadMessages();
      const result = await formats.formatters.formatLog(thread, threadMessages, { simple: true });
      logs.push(result.content);
    }

    return { threadCount: rows.length, text: logs.join("\n\n") };
  };

  // !getuserdata [userId]
  addCommand("getuserdata", [], async (msg, userId) => {
    const { threadCount, text } = await buildUserData(userId);

    if (threadCount === 0) {
      await msg.channel.createMessage(`No modmail data found for <@${userId}>`);
      return;
    }

    await msg.channel.createMessage(
      `Modmail data for <@${userId}> (${plural(threadCount, "thread")}):`,
      { file: text, name: `userdata-${userId}.txt` },
    );
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

    try {
      const dmChannel = await bot.getDMChannel(userId);
      await dmChannel.createMessage(USER_DATA_MESSAGE, dataFile());
    } catch (err) {
      throw new Error("Could not DM the user. They may have blocked the bot or closed their DMs.");
    }

    // Show the operator what was sent, like !reply does
    await msg.channel.createMessage(`**Sent to <@${userId}>:** ${USER_DATA_MESSAGE}`, dataFile());
    await logAction(`Data sent: User <@${userId}> data sent.`);
  });

  const getAttachmentDir = () => config.attachmentDir
    || path.resolve(path.dirname(require.main.filename), "..", "attachments");

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
      const data = typeof row.log_storage_data === "string" ? JSON.parse(row.log_storage_data) : row.log_storage_data;
      if (data && data.fullPath) files.push(data.fullPath);
    }

    if (config.attachmentStorage === "local") {
      const messageRows = await knex("thread_messages")
        .whereIn("thread_id", userThreadIds(knex, userId))
        .whereNotNull("attachments")
        .select("attachments");

      for (const row of messageRows) {
        for (const url of JSON.parse(row.attachments)) {
          const match = url.split(/[?#]/)[0].match(LOCAL_ATTACHMENT_URL);
          if (match) files.push(path.join(getAttachmentDir(), match[1]));
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
    if (counts.threadCount === 0 && counts.noteCount === 0) {
      await msg.channel.createMessage(`There is no modmail data or notes to delete for <@${userId}>`);
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

    const results = [];
    for (const file of files) results.push(await deleteFile(file));
    const deletedFiles = results.filter(r => r === "deleted").length;
    const failedFiles = results.filter(r => r === "failed").length;

    let text = `Deleted ${plural(finalCounts.threadCount, "thread")}, ${plural(finalCounts.messageCount, "message")}, `
      + `${plural(finalCounts.noteCount, "note")} and ${plural(deletedFiles, "file")} for <@${userId}>.${keptText}`;
    const closed = openThreads.length - failedCloses;
    if (closed) text += ` Closed ${plural(closed, "open thread")}.`;
    if (failedCloses) text += ` ${plural(failedCloses, "open thread")} could not be closed cleanly (their data was still deleted), see the bot console.`;
    if (! notified) text += " **The user could not be notified by DM.**";
    if (failedFiles) text += ` ${plural(failedFiles, "file")} could not be deleted, see the bot console.`;

    // If the command was run in a thread that has now been closed, its channel is gone
    await msg.channel.createMessage(text).catch(() => console.log(`[DataRequests] ${text}`));
    const problems = [];
    if (failedFiles) problems.push(`${plural(failedFiles, "file")} could not be deleted`);
    if (failedCloses) problems.push(`${plural(failedCloses, "thread")} could not be closed cleanly`);
    await logAction(`Data deletion: User <@${userId}> data deleted${problems.length ? ` (${problems.join(", ")})` : "."}`);
  });
};
