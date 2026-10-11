const createExportTracking = require("./lib/export-tracking");
const createUserData = require("./lib/user-data");
const createUserDataDeletion = require("./lib/user-data-deletion");

const USER_DATA_MESSAGE = "The requested user data can be found below:";

const toList = value => (value == null ? [] : [].concat(value).map(String));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

module.exports = function({ bot, knex, config, commands, threads, formats, wait }) {
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
  const userDeletion = createUserDataDeletion({ threads, userData, exportTracking, wait });

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

    const deletion = await userDeletion.run(userId, {
      channelId: msg.channel.id,
      say: text => msg.channel.createMessage(text),
    });
    const { counts: final, files, exports: exportOutcome, failedCloses } = deletion;
    const closed = deletion.openThreadCount - failedCloses.length;

    // Each problem is worded once for the reply and once for the log channel
    const problem = {};
    if (failedCloses.length) {
      const list = failedCloses.map(t => `#${t.thread_number} (<#${t.channel_id}>)`).join(", ");
      problem.closes = {
        reply: ` ${plural(failedCloses.length, "open thread")} could not be closed cleanly (their data was still deleted): ${list}. `
          + `Their channels are still open, so delete them yourself. See the bot console.`,
        log: `${plural(failedCloses.length, "thread")} could not be closed cleanly`,
      };
    }
    if (exportOutcome.failed) {
      problem.exportsFailed = {
        reply: ` ${plural(exportOutcome.failed, "exported data message")} could not be deleted and stay recorded: `
          + `run ${config.prefix}deleteuserdata ${userId} --confirm again to retry, see the bot console.`,
        log: `${plural(exportOutcome.failed, "export message")} could not be deleted`,
      };
    }
    if (exportOutcome.unchecked) {
      problem.exportsUnchecked = {
        reply: `\n${exportTracking.UNCHECKED_WARNING}`,
        log: "exported data messages could not be checked",
      };
    }
    if (! deletion.notified) problem.notNotified = { reply: " **The user could not be notified by DM.**" };
    if (files.failed) {
      problem.filesFailed = {
        reply: ` ${plural(files.failed, "file")} could not be deleted, see the bot console.`,
        log: `${plural(files.failed, "file")} could not be deleted`,
      };
    }
    if (files.skipped) {
      problem.filesSkipped = {
        reply: ` ${plural(files.skipped, "file record")} could not be used, so those files were not deleted. Check and delete them yourself, see the bot console.`,
        log: `${plural(files.skipped, "file")} skipped`,
      };
    }

    const replyOf = key => (problem[key] ? problem[key].reply : "");
    const text = `Deleted ${plural(final.threadCount, "thread")}, ${plural(final.messageCount, "message")}, `
      + `${plural(final.noteCount, "note")} and ${plural(files.deleted, "file")} for <@${userId}>.${keptText}`
      + (closed ? ` Closed ${plural(closed, "open thread")}.` : "")
      + replyOf("closes")
      + (exportOutcome.removed ? ` Removed ${plural(exportOutcome.removed, "exported data message")} from Discord.` : "")
      + replyOf("exportsFailed")
      + replyOf("exportsUnchecked")
      + replyOf("notNotified")
      + replyOf("filesFailed")
      + replyOf("filesSkipped");

    // If the command was run in a thread that has now been closed, its channel is gone
    await msg.channel.createMessage(text).catch(() => console.log(`[DataRequests] ${text}`));
    const logged = ["filesFailed", "filesSkipped", "exportsFailed", "exportsUnchecked", "closes"]
      .filter(key => problem[key])
      .map(key => problem[key].log);
    await logAction(`Data deletion: User <@${userId}> data deleted${logged.length ? ` (${logged.join(", ")})` : "."}`);
  });
};
