const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { setup, notFound } = require("./helpers");

const USER = "111";
const closedThread = (id, extra = {}) => ({ id, user_id: USER, status: 2, thread_number: 1, channel_id: `c-${id}`, ...extra });
const lastReply = env => env.replies[env.replies.length - 1].content;

const withEnv = (options, fn) => async () => {
  const env = setup(options);
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
};

// --- exported data messages ---

test("deleteuserdata removes export records once Discord says the message is gone", withEnv({
  tables: { data_request_exports: [
    { id: 1, user_id: USER, channel_id: "a", message_id: "m1" },
    { id: 2, user_id: USER, channel_id: "a", message_id: "m2" },
  ] },
  bot: { deleteMessage: async (channel, id) => { if (id === "m2") throw notFound(10008); } },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(env.knex.tables.data_request_exports.length, 0);
  assert.match(lastReply(env), /Removed 2 exported data messages/);
}));

test("deleteuserdata keeps the record of an export it could not delete", withEnv({
  tables: { data_request_exports: [{ id: 1, user_id: USER, channel_id: "a", message_id: "m1" }] },
  bot: { deleteMessage: async () => { throw new Error("Missing Permissions"); } },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(env.knex.tables.data_request_exports.length, 1);
  assert.match(lastReply(env), /could not be deleted and stay recorded/);
  assert.match(lastReply(env), /--confirm again to retry/);
}));

test("deleteuserdata reports an export as failed when Discord deleted it but its record could not be removed", withEnv({
  tables: { data_request_exports: [{ id: 1, user_id: USER, channel_id: "a", message_id: "m1" }] },
  knexOptions: { failDeletes: ["data_request_exports"] },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(env.knex.tables.data_request_exports.length, 1);
  assert.match(lastReply(env), /1 exported data message could not be deleted and stay recorded/);
}));

test("deleteuserdata only touches the exports of the requested user", withEnv({
  tables: { data_request_exports: [
    { id: 1, user_id: USER, channel_id: "a", message_id: "m1" },
    { id: 2, user_id: "222", channel_id: "a", message_id: "m2" },
  ] },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.deepEqual(env.knex.tables.data_request_exports.map(r => r.user_id), ["222"]);
}));

test("deleteuserdata dry run lists exports and deletes nothing", withEnv({
  tables: { data_request_exports: [{ id: 1, user_id: USER, channel_id: "a", message_id: "m1" }] },
}, async env => {
  await env.run("deleteuserdata", {}, { user_id: USER });

  assert.equal(env.knex.tables.data_request_exports.length, 1);
  assert.match(lastReply(env), /Also deletes 1 exported data message/);
}));

test("deleteuserdata warns when the exports table cannot be read (nothing else to delete)", withEnv({
  knexOptions: { failReads: ["data_request_exports"] },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.match(lastReply(env), /There is no modmail data or notes to delete/);
  assert.match(lastReply(env), /Could not check for exported data messages/);
}));

test("deleteuserdata warns when the exports table cannot be read (dry run and confirm)", withEnv({
  tables: { threads: [closedThread("t1")] },
  knexOptions: { failReads: ["data_request_exports"] },
}, async env => {
  await env.run("deleteuserdata", {}, { user_id: USER });
  assert.match(lastReply(env), /Could not check for exported data messages/);

  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });
  assert.match(lastReply(env), /Deleted 1 thread/);
  assert.match(lastReply(env), /Could not check for exported data messages/);
}));

test("getuserdata records the export it posted", withEnv({
  tables: { threads: [closedThread("t1")] },
  threadsById: { t1: { id: "t1", getThreadMessages: async () => [] } },
}, async env => {
  await env.run("getuserdata", {}, { user_id: USER });

  assert.deepEqual(
    env.knex.tables.data_request_exports.map(r => [r.user_id, r.channel_id, r.message_id]),
    [[USER, "ops-channel", "msg1"]],
  );
}));

test("senduserdata records only the operator's copy, not the DM", withEnv({
  tables: { threads: [closedThread("t1")] },
  threadsById: { t1: { id: "t1", getThreadMessages: async () => [] } },
}, async env => {
  await env.run("senduserdata", {}, { user_id: USER });

  assert.deepEqual(env.knex.tables.data_request_exports.map(r => r.channel_id), ["ops-channel"]);
}));

test("getuserdata tells the operator when the export could not be tracked", withEnv({
  tables: { threads: [closedThread("t1")] },
  threadsById: { t1: { id: "t1", getThreadMessages: async () => [] } },
  knexOptions: { failHasTable: true },
}, async env => {
  await env.run("getuserdata", {}, { user_id: USER });

  assert.match(lastReply(env), /could not be tracked/);
}));

test("getuserdata explains when the file is too large for Discord", withEnv({
  tables: { threads: [closedThread("t1")] },
  threadsById: { t1: { id: "t1", getThreadMessages: async () => [] } },
}, async env => {
  const original = env.msg.channel.createMessage;
  env.msg.channel.createMessage = async (content, file) => {
    if (file) throw Object.assign(new Error("Request entity too large"), { code: 40005 });
    return original(content);
  };
  await env.run("getuserdata", {}, { user_id: USER });

  assert.match(lastReply(env), /too large/);
}));

// --- anonymous replies ---

test("exported data hides who sent anonymous replies", withEnv({
  tables: { threads: [closedThread("t1")] },
}, async env => {
  const anonymous = {
    is_anonymous: true,
    user_name: "Real Mod",
    metadata: { originalThreadMessage: { is_anonymous: true, user_name: "Real Mod" } },
  };
  const named = { is_anonymous: false, user_name: "Other Mod" };
  const user = { is_anonymous: false, user_name: "The User" };

  const env2 = setup({
    tables: { threads: [closedThread("t1")] },
    threadsById: { t1: { id: "t1", getThreadMessages: async () => [anonymous, named, user] } },
  });
  try {
    await env2.run("getuserdata", {}, { user_id: USER });
    assert.equal(anonymous.user_name, "Staff");
    assert.equal(anonymous.metadata.originalThreadMessage.user_name, "Staff");
    assert.equal(named.user_name, "Other Mod");
    assert.equal(user.user_name, "The User");
  } finally {
    env2.cleanup();
  }
}));

test("a thread that cannot be found is left out of the export", withEnv({
  tables: { threads: [closedThread("t1"), closedThread("t2")] },
  threadsById: { t2: { id: "t2", getThreadMessages: async () => [] } },
}, async env => {
  await env.run("getuserdata", {}, { user_id: USER });

  assert.match(env.replies[0].content, /\(1 thread\)/);
}));

// --- files left on disk ---

test("deleteuserdata deletes files inside the log and attachment folders", withEnv({}, async env => {
  const logFile = path.join(env.logDir, "t1.txt");
  fs.writeFileSync(logFile, "log");
  fs.writeFileSync(path.join(env.attachmentDir, "123"), "file");
  env.knex.tables.threads = [closedThread("t1", { log_storage_data: JSON.stringify({ fullPath: logFile }) })];
  env.knex.tables.thread_messages = [
    { thread_id: "t1", attachments: JSON.stringify(["http://bot/attachments/123/pic.png"]) },
  ];

  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.existsSync(path.join(env.attachmentDir, "123")), false);
  assert.match(lastReply(env), /and 2 files/);
  assert.doesNotMatch(lastReply(env), /could not be used/);
}));

test("deleteuserdata never deletes a log file outside the log folder, and says so", withEnv({}, async env => {
  const outside = path.join(env.dir, "precious.txt");
  fs.writeFileSync(outside, "keep");
  env.knex.tables.threads = [closedThread("t1", { log_storage_data: JSON.stringify({ fullPath: outside }) })];

  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(fs.existsSync(outside), true);
  assert.match(lastReply(env), /1 file record could not be used/);
}));

test("deleteuserdata reports file records it cannot read", withEnv({}, async env => {
  env.knex.tables.threads = [closedThread("t1", { log_storage_data: "{not json" })];
  env.knex.tables.thread_messages = [{ thread_id: "t1", attachments: "also not json" }];

  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.match(lastReply(env), /Deleted 1 thread/);
  assert.match(lastReply(env), /2 file records could not be used/);
}));

test("deleteuserdata does not complain about threads that have no log file", withEnv({
  tables: { threads: [closedThread("t1", { log_storage_data: null })] },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.doesNotMatch(lastReply(env), /could not be used/);
}));

// --- closing threads ---

test("deleteuserdata names the threads that could not be closed and still deletes the data", withEnv({
  tables: { threads: [{ id: "t1", user_id: USER, status: 1, thread_number: 7, channel_id: "chan7" }] },
  threadsById: { t1: { sendSystemMessageToUser: async () => {}, close: async () => { throw new Error("boom"); } } },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.equal(env.knex.tables.threads.length, 0);
  assert.match(lastReply(env), /1 open thread could not be closed cleanly/);
  assert.match(lastReply(env), /#7 \(<#chan7>\)/);
  assert.doesNotMatch(lastReply(env), /Closed 1 open thread/);
}));

test("deleteuserdata reports threads it closed", withEnv({
  tables: { threads: [{ id: "t1", user_id: USER, status: 1, thread_number: 7, channel_id: "chan7" }] },
  threadsById: { t1: { sendSystemMessageToUser: async () => {}, close: async () => {} } },
}, async env => {
  await env.run("deleteuserdata", { confirm: true }, { user_id: USER });

  assert.match(lastReply(env), /Closed 1 open thread/);
}));
