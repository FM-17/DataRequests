---
status: partially superseded by ADR-0004
---

# Deletion keeps open threads and the block record

`!deleteuserdata` removed closed threads, their messages and the user's notes, but not open or suspended threads or the block record. Users normally ask for deletion through a live thread, and removing its rows would break the conversation while its Discord channel stays behind.

Superseded for open threads by [ADR-0004](./0004-deletion-closes-request-thread.md). The block record is still kept.
