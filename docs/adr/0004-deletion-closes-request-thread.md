# Deletion closes the request thread and keeps only the block record

Confirming `!deleteuserdata` tells the user their data, including this conversation, is being deleted, closes their open and suspended threads, and then deletes everything about them. Keeping the live thread (ADR-0002) left the user's messages behind after a deletion request, which defeated the point. The user can message the bot again to start a fresh conversation.

The block record is still kept, because deleting it would silently unblock the user.

The "thread was closed" messages the bot posted in its log channel are left alone: the bot doesn't track them, so removing them would mean reading the log channel's history, and once the thread's data is deleted the log links in them no longer lead anywhere.

## Considered Options

- **Keep the request thread** (ADR-0002): the conversation keeps working, but the user's data is not actually gone.
- **Delete the rows and leave the channel**: leaves an orphaned inbox channel, and the next DM starts a new thread beside it.
- **Also delete the log channel messages**: tried and removed. It needs a history scan of the log channel for little benefit, since the linked content is already deleted.

## Consequences

If the command was run inside the thread being closed, the bot first tells the user "Processing request...", tells the operator the thread will be closed and deleted in 20 seconds, and waits so the operator can read the thread. Only then does it send the user the deletion notice, so the user can't reply to a thread that is about to go. Then its channel is deleted, so the final report can't be posted there and goes to the bot console instead.
