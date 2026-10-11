// Deleting a user's data (see docs/adr/0004): tell the user and close their open threads,
// then delete the rows, the tracked exports and the files. Reports what happened as one outcome.

const USER_DELETION_NOTICE = "Your data has been deleted at your request. "
  + "This includes this conversation, which will now be closed. "
  + "You can send a new message at any time to start a new conversation.";

const PROCESSING_NOTICE = "Processing request...";

// When the command is run inside a thread that is about to be closed, wait so the operator can read the thread
const CLOSE_DELAY_SECONDS = 20;
const sleepSeconds = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000));

module.exports = function createUserDataDeletion({ threads, userData, exportTracking, wait = sleepSeconds }) {
  return {
    /**
     * Deletes everything about the user except the block record.
     * `channelId` is the channel the command was run in. If that is one of the threads being closed,
     * `say(text)` posts a notice there, the user is told the request is being processed, and the
     * deletion notice to the user and the closing wait until the delay is over.
     *
     * Returns: {
     *   counts: { threadCount, messageCount, noteCount }, hasBlockRecord,
     *   openThreadCount, failedCloses: [thread rows], notified,
     *   files: { deleted, failed, skipped },
     *   exports: { removed, failed, unchecked },
     * }
     */
    async run(userId, { channelId, say }) {
      const exportsBefore = await exportTracking.count(userId);
      const openThreads = await userData.openThreads(userId);
      const hasBlockRecord = await userData.hasBlockRecord(userId);

      // Closing saves the thread's log, so the files to delete are only collected afterwards.
      // This may delete the channel the command was run in.
      let notified = true;
      const failedCloses = [];
      for (const row of openThreads) {
        const thread = await threads.findById(row.id);
        if (! thread) continue;

        // In the thread the command was run in, the operator needs time to read the thread first. Tell the user
        // we're working on it, and send the deletion notice only once the wait is over, so they have no time
        // to reply to a thread that is about to disappear.
        if (row.channel_id === channelId) {
          await thread.sendSystemMessageToUser(PROCESSING_NOTICE).catch(() => {});
          await Promise.resolve(say(`This thread will be closed and deleted in ${CLOSE_DELAY_SECONDS} seconds.`)).catch(() => {});
          await wait(CLOSE_DELAY_SECONDS);
        }

        try {
          await thread.sendSystemMessageToUser(USER_DELETION_NOTICE);
        } catch (err) {
          notified = false;
          console.error(`[DataRequests] Could not notify user ${userId}: ${err.message}`);
        }

        try {
          await thread.close(true);
        } catch (err) {
          failedCloses.push(row);
          console.error(`[DataRequests] Could not close thread ${row.id}: ${err.message}`);
        }
      }

      const counts = await userData.counts(userId);
      const { files, skipped } = await userData.findFiles(userId);

      await userData.removeRows(userId);

      // Reads the exports again: the plugin may have recorded more since the count above
      const exportResult = await exportTracking.deleteAll(userId);

      const { deleted, failed } = await userData.removeFiles(files);

      return {
        counts,
        hasBlockRecord,
        openThreadCount: openThreads.length,
        failedCloses,
        notified,
        files: { deleted, failed, skipped },
        exports: {
          removed: exportResult.removed,
          failed: exportResult.failed,
          unchecked: exportsBefore.unchecked || exportResult.unchecked,
        },
      };
    },
  };
};
