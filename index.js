const createExportTracking = require("./lib/export-tracking");
const createUserData = require("./lib/user-data");

const USER_DELETION_NOTICE = "Your data has been deleted at your request. "
  + "This includes this conversation, which will now be closed. "
  + "You can send a new message at any time to start a new conversation.";

// When the command is run inside a thread that is about to be closed, wait so the operator can read the notice
const CLOSE_DELAY_SECONDS = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const USER_DATA_MESSAGE = "The requested user data can be found below:";

const toList = value => (value == null ? [] : [].concat(value).map(String));
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

  const exportTracking = createExportTracking({ bot, knex, config });
  const userData = createUserData({ knex, config });

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
    const threadIds = await userData.threadIds(userId);

    const logs = [];
    for (const threadId of threadIds) {
      const thread = await threads.findById(threadId);
      if (! thread) {
        console.warn(`[DataRequests] Thread ${threadId} not found, skipping`);
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
    await exportTracking.track(msg.channel, userId, sent);
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
    await exportTracking.track(msg.channel, userId, echo);
    await logAction(`Data sent: User <@${userId}> data sent.`);
  });

  // !deleteuserdata [userId] [--confirm]
  // Without --confirm, only reports what would be deleted
  addCommand("deleteuserdata", [{ name: "confirm", isSwitch: true }], async (msg, userId, args) => {
    const counts = await userData.counts(userId);
    const exportCount = await exportTracking.count(userId);

    if (counts.threadCount === 0 && counts.noteCount === 0 && exportCount.count === 0) {
      let text = `There is no modmail data or notes to delete for <@${userId}>`;
      if (exportCount.unchecked) text += `\n${exportTracking.UNCHECKED_WARNING}`;
      await msg.channel.createMessage(text);
      return;
    }

    const openThreads = await userData.openThreads(userId);
    const hasBlockRecord = await userData.hasBlockRecord(userId);

    const keptText = hasBlockRecord ? " The block record is kept." : "";

    if (! args.confirm) {
      let text = `Would delete ${plural(counts.threadCount, "thread")}, ${plural(counts.messageCount, "message")} `
        + `and ${plural(counts.noteCount, "note")} for <@${userId}>.${keptText}`;

      if (exportCount.count) {
        text += `\nAlso deletes ${plural(exportCount.count, "exported data message")} this bot posted in the server.`;
      }
      if (exportCount.unchecked) text += `\n${exportTracking.UNCHECKED_WARNING}`;

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
    const failedCloseThreads = [];
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
        failedCloseThreads.push(row);
        console.error(`[DataRequests] Could not close thread ${row.id}: ${err.message}`);
      }
    }

    const finalCounts = await userData.counts(userId);
    const { files, skipped: skippedFiles } = await userData.findFiles(userId);

    await userData.removeRows(userId);

    // Reads the exports again: the plugin may have recorded more since the count above
    const exportResult = await exportTracking.deleteAll(userId);
    const exportsUnchecked = exportCount.unchecked || exportResult.unchecked;

    const { deleted: deletedFiles, failed: failedFiles } = await userData.removeFiles(files);

    let text = `Deleted ${plural(finalCounts.threadCount, "thread")}, ${plural(finalCounts.messageCount, "message")}, `
      + `${plural(finalCounts.noteCount, "note")} and ${plural(deletedFiles, "file")} for <@${userId}>.${keptText}`;
    const failedCloses = failedCloseThreads.length;
    const closed = openThreads.length - failedCloses;
    if (closed) text += ` Closed ${plural(closed, "open thread")}.`;
    if (failedCloses) {
      const list = failedCloseThreads.map(t => `#${t.thread_number} (<#${t.channel_id}>)`).join(", ");
      text += ` ${plural(failedCloses, "open thread")} could not be closed cleanly (their data was still deleted): ${list}. `
        + `Their channels are still open, so delete them yourself. See the bot console.`;
    }
    if (exportResult.removed) text += ` Removed ${plural(exportResult.removed, "exported data message")} from Discord.`;
    if (exportResult.failed) {
      text += ` ${plural(exportResult.failed, "exported data message")} could not be deleted and stay recorded: `
        + `run ${config.prefix}deleteuserdata ${userId} --confirm again to retry, see the bot console.`;
    }
    if (exportsUnchecked) text += `\n${exportTracking.UNCHECKED_WARNING}`;
    if (! notified) text += " **The user could not be notified by DM.**";
    if (failedFiles) text += ` ${plural(failedFiles, "file")} could not be deleted, see the bot console.`;
    if (skippedFiles) text += ` ${plural(skippedFiles, "file record")} could not be used, so those files were not deleted. Check and delete them yourself, see the bot console.`;

    // If the command was run in a thread that has now been closed, its channel is gone
    await msg.channel.createMessage(text).catch(() => console.log(`[DataRequests] ${text}`));
    const problems = [];
    if (failedFiles) problems.push(`${plural(failedFiles, "file")} could not be deleted`);
    if (skippedFiles) problems.push(`${plural(skippedFiles, "file")} skipped`);
    if (exportResult.failed) problems.push(`${plural(exportResult.failed, "export message")} could not be deleted`);
    if (exportsUnchecked) problems.push("exported data messages could not be checked");
    if (failedCloses) problems.push(`${plural(failedCloses, "thread")} could not be closed cleanly`);
    await logAction(`Data deletion: User <@${userId}> data deleted${problems.length ? ` (${problems.join(", ")})` : "."}`);
  });
};
