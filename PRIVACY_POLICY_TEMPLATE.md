# Modmail privacy policy

## Bot overview
Modmail is a ticketing system that lets users contact server staff through the bot instead of messaging staff members individually or pinging them publicly in the server.

The bot's source code is available at: https://github.com/Dragory/modmailbot

This deployment can send a user a copy of their modmail data, or delete it, when the user asks. The plugin that does this is available at: https://github.com/FM-17/DataRequests

## Stored personal data
The bot stores full transcripts of modmail threads. These transcripts include:
* User ID, username, nickname, and display name of the contacting or contacted user
* User ID, username, nickname, and display name of any moderators participating in the thread
* The content of messages in the thread, and files sent in the thread when the bot saves attachments locally

In addition, the bot stores:
* User ID and username of users blocked from contacting the bot
* User ID of the author and target user of notes saved in the bot, and the text of those notes

## How data is used and shared
The bot uses this data to deliver modmail conversations, to let staff read and reply to them, and to keep a transcript after a thread is closed. Notes are kept so staff have context about a user. The block list is used to stop a blocked user from contacting the bot. Records of posted copies are used only to find and delete those copies later.

The data is visible to staff who operate this modmail. It is sent through Discord, which processes it under Discord's own terms. It is not sold, not used for advertising, and not used to train machine learning or AI models. It is not shared with any other third party.

## Data retention
* Thread transcripts are stored until staff delete them, including when a user asks for deletion
* Notes, including the user IDs and text tied to them, are stored until the note is deleted or the user's data is deleted on request
* User IDs tied to snippets are stored until the snippet is deleted
* A block record is kept for as long as the user is blocked, including after a deletion request

## Data access and deletion requests
To request a copy of your data, or for your data to be deleted, message this bot or send an email to <>

A copy contains the messages to and from you in your modmail threads. Staff can send that file to you by direct message. The same file may also be posted in the staff server so the request can be carried out.

When staff confirm a deletion, the bot tells you that your data is being deleted, including the open conversation, and then:
* Deletes all of your modmail threads and their messages, including open and suspended threads
* Deletes notes about you
* Deletes log files and locally saved attachments for those threads
* Deletes copies of your data that the bot posted in the staff server, and the records of those copies

The following are not deleted:
* The copy already sent to you by direct message. That file is yours.
* Your block record, if you are blocked, so the block stays in effect
* A one-line staff log that a copy was requested, sent, or deleted. It contains your user ID and not the transcript.
* Attachments that were only stored on Discord's CDN, rather than saved locally by the bot. Staff will not have access to these after transcripts have been deleted.
