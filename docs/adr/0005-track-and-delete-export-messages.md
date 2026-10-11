# Exported data messages are tracked and deleted with the user's data

`!getuserdata` and `!senduserdata` post the user's data to Discord, so deleting it from the database would leave those copies behind. The plugin records each such message (the channel and message id, never the data) in its own table, `data_request_exports`, created on first load, and `!deleteuserdata --confirm` deletes them. Only the copies posted in the server are tracked. The copy DMed to the user by `!senduserdata` is theirs: it is neither recorded nor deleted.

Deliberately simple, to keep it hard to get wrong:

- A record is removed only after Discord confirms the message is gone. "Unknown message" or "unknown channel" counts as gone.
- A failed delete keeps its record, is reported in the reply and the log channel, and is retried the next time `!deleteuserdata --confirm` is run for that user. There are no timers or background retries.
- If an export can't be recorded, the operator is told straight away to delete it by hand.
- Exports made before this was added are not tracked.
- Copies a person has saved or downloaded are out of reach.
