# DataRequests

A plugin for [Dragory's Modmail Bot](https://github.com/Dragory/modmailbot) that lets staff export, send and delete a user's modmail data upon the user's request.

## Install

Tested with Modmail 3.11.0. In the bot's `config.ini`, make a new line and add:

```ini
plugins[] = npm:FM-17/DataRequests
```

Restart the bot. It installs the plugin from GitHub on start-up.

## Commands

`<userId>` can be an id or a mention. It is optional: when a command is run in a ticket thread without one, it uses the ticket's user.

- `!getuserdata [userId]`: posts a `.txt` file with the user's modmail threads. It has the same content as `!loglink -s`: only messages to and from the user.
- `!senduserdata [userId]`: sends that same file to the user by DM. 
- `!deleteuserdata [userId]`: reports what would be deleted and deletes nothing. Run `!deleteuserdata [userId] --confirm` to delete.
  - Deleted: all of the user's threads, their messages, their notes, and the files on disk that belong to those threads (saved log files, and local attachments when `attachmentStorage = local`).
  - Open and suspended threads, including the one the request came in on, are not kept. Confirming messages the user that their data is being deleted, including this conversation, which will be closed, then closes the thread and deletes the data.
  - Kept: the block record, so a blocked user stays blocked.

## Configuration

All options are optional and go in the bot's `config.ini`.


| Option                     | Description                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataRequestsRoleId`       | Role id (repeat as `dataRequestsRoleId[] = ...` for several) that members need to use the commands                                                                                                 |
| `dataRequestsChannelId`    | Channel id (or several) the commands are restricted to. Populating this config prevents the bot from functioning in threads. Ideal if you'd prefer data requests to be handled by a specific team. |
| `dataRequestsLogChannelId` | Channel that gets a log of each action, e.g. `Data request: User <@id> data requested.`                                                                                                            |


When both a role and a channel are set, both must match.

## Limits

- Attachments stored on Discord (`attachmentStorage = discord`) or linked from Discord's CDN (`original`) cannot be removed by the plugin.
- The "Modmail thread #N with ... was closed" messages the bot posted in `logChannelId` are not deleted. They still show the user's name and id, but the log links in them stop working once the thread's data is deleted.

## Tools Used

- AI tooling was leveraged for the development of this plugin. 
- [mattpocock/skills](https://github.com/mattpocock/skills) `grill-with-docs`: questions each design decision one at a time before coding, records the answers as the ADRs in `docs/adr/` and the terms in `GLOSSARY.md`. Helps track reasoning alongside code.

