// Export message tracking (see docs/adr/0005-track-and-delete-export-messages.md)
// Remembers the Discord messages the bot posted containing a user's data, and deletes them later.

// Where the plugin remembers those messages
const EXPORTS_TABLE = "data_request_exports";

// Discord says the message or its channel no longer exists: the export is already gone
const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_UNKNOWN_MESSAGE = 10008;
const isAlreadyGone = err => err && (
  err.code === DISCORD_UNKNOWN_CHANNEL
  || err.code === DISCORD_UNKNOWN_MESSAGE
  || (err.res && err.res.statusCode === 404)
);

const UNCHECKED_WARNING = "⚠ Could not check for exported data messages, so any the bot posted in the server "
  + "will not be deleted. Delete them yourself.";

module.exports = function createExportTracking({ bot, knex, config }) {
  // The plugin's own table, created on first load. It never touches the bot's tables.
  const ready = (async () => {
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

  const record = async (userId, channelId, message) => {
    try {
      if (! await ready || ! message || ! message.id || ! channelId) return false;
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

  // `unchecked` is true when the table could not be read, so callers can warn instead of treating it as "no exports"
  const list = async userId => {
    try {
      if (! await ready) return { rows: [], unchecked: true };
      const rows = await knex(EXPORTS_TABLE).where("user_id", userId).select("id", "channel_id", "message_id");
      return { rows, unchecked: false };
    } catch (err) {
      console.error(`[DataRequests] Could not read ${EXPORTS_TABLE}: ${err.message}`);
      return { rows: [], unchecked: true };
    }
  };

  return {
    UNCHECKED_WARNING,

    // Tracks an export message posted in `channel`. When it can't be tracked, tells the operator
    // in the same channel to delete it by hand. Returns whether it was tracked.
    async track(channel, userId, message) {
      const tracked = await record(userId, channel.id, message);
      if (! tracked) {
        await channel.createMessage(
          `⚠ This export could not be tracked, so ${config.prefix}deleteuserdata will not remove it. Delete the message yourself when it is no longer needed.`,
        ).catch(() => {});
      }
      return tracked;
    },

    // How many exports are tracked for the user, and whether the table could not be read
    async count(userId) {
      const { rows, unchecked } = await list(userId);
      return { count: rows.length, unchecked };
    },

    // Deletes the user's tracked exports (read fresh now). A record is removed only once Discord confirms
    // the message is gone, so failures stay recorded and a later run retries them.
    async deleteAll(userId) {
      const { rows, unchecked } = await list(userId);
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
      return { removed, failed, unchecked };
    },
  };
};
