# Modmail data requests

Lets staff fulfil a user's request to receive or delete the data the modmail bot holds about them.

## Language

**Data request**:
A user asking, usually through a modmail thread, for their data to be exported, sent to them, or deleted.
_Avoid_: GDPR request, DSR

**Request thread**:
The open or suspended modmail thread a data request arrives in. Deleting the user's data tells the user and closes this thread.
_Avoid_: Active ticket, current case

**Export message**:
A message the bot posted in the server containing a user's data, from `!getuserdata` or `!senduserdata` (the operator's copy). Deleting the user's data deletes these too. The copy DMed to the user is theirs and is never deleted.
_Avoid_: Data dump, attachment

**Block record**:
The bot's record that a user is blocked from modmail, which deletion keeps so the block stays in force.
_Avoid_: Ban, blacklist entry
