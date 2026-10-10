# DataRequests

A plugin for [Dragory's Modmail Bot](https://github.com/Dragory/modmailbot) that lets staff export, send and delete a user's modmail data.

## Install

Tested with Modmail 3.11.0. In the bot's `config.ini`, make a new line and add:

```ini
plugins[] = npm:FM-17/DataRequests
```

Restart the bot. It installs the plugin from GitHub on start-up.

To run a local copy instead (for development), put this folder next to the bot and use a path relative to the bot's folder:

```ini
plugins[] = ../DataRequests
```

## Commands

All commands work like the bot's other inbox server commands: they only run on the inbox server and only for members allowed by `inboxServerPermission`. The bot always replies in the channel where the command was run.

`<userId>` can be an id or a mention. It is optional: when a command is run in a ticket thread without one, it uses the ticket's user.

- `!getuserdata [userId]`: posts a `.txt` file with the user's modmail threads. It has the same content as `!loglink -s`: only messages to and from the user, no mod chatter. Open and suspended threads are included.
- `!senduserdata [userId]`: sends that same file to the user by DM and shows you the message and file that were sent, like `!reply` does. It is not logged in the thread.
- `!deleteuserdata [userId]`: reports what would be deleted and deletes nothing. Run `!deleteuserdata [userId] --confirm` to delete.
  - Deleted: all of the user's threads, their messages, their notes, and the files on disk that belong to those threads (saved log files, and local attachments when `attachmentStorage = local`).
  - Open and suspended threads, including the one the request came in on, are not kept. Confirming first messages the user that their data is being deleted, including this conversation, which will be closed, then closes the thread and deletes the data. If the command was run inside that thread, it says so and waits 20 seconds before closing, so you can read the message sent to the user. The report before confirming says which threads will be closed. If the command was run inside such a thread, its channel is deleted and the final report goes to the bot console instead.
  - Kept: the block record, so a blocked user stays blocked.

## Configuration

All options are optional and go in the bot's `config.ini`.

| Option | Description |
| ------ | ----------- |
| `dataRequestsRoleId` | Role id (repeat as `dataRequestsRoleId[] = ...` for several) that members need to use the commands |
| `dataRequestsChannelId` | Channel id (or several) the commands are restricted to |
| `dataRequestsLogChannelId` | Channel that gets a one-line log of each action, e.g. `Data request: User <@id> data requested.` |

When both a role and a channel are set, both must match. Commands that fail these checks are silently ignored.

## Limits

- Attachments stored on Discord (`attachmentStorage = discord`) or linked from Discord's CDN (`original`) cannot be removed by the plugin.
- The "Modmail thread #N with ... was closed" messages the bot posted in `logChannelId` are not deleted. They still show the user's name and id, but the log links in them stop working once the thread's data is deleted.
- Embed summaries of user messages (shown in the bot's web log view) are not included in the exported data.
