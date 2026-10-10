# The log channel only records that actions happened

The bot always replies in the channel where the command was run, including the exported data file. `dataRequestsLogChannelId` only receives one-line entries such as "Data request: User <@id> data requested.", "Data sent: ..." and "Data deletion: ...", never user data, so a wide-readership audit channel can't leak what an export contains.
