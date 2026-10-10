# Confirm deletion by re-running with `--confirm`

`!deleteuserdata` only reports what it would delete; running it again with `--confirm` deletes. This needs no in-memory state, so nothing is lost on restart and there is nothing to leak, and staff can take as long as they like between the two steps.

## Considered Options

- **Reaction prompt**: needs the `guildMessageReactions` intent, which the bot doesn't enable. Operators would have to add `extraIntents`, which we want to avoid.
- **Reply listener ("reply yes")**: needs a pending listener per prompt. Without a timeout, a stray "yes" from the same moderator in a busy request thread could trigger a deletion hours later.
