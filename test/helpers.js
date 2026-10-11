const fs = require("fs");
const os = require("os");
const path = require("path");

const plugin = require("../index");

// A tiny in-memory stand-in for knex. It supports only the calls the plugin makes.
function createFakeKnex(initialTables = {}, { failReads = [], failDeletes = [], failHasTable = false } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initialTables)) tables[name] = rows.map(r => ({ ...r }));
  let nextId = 1000;

  const builder = tableName => {
    const filters = [];
    let mode = "select";
    let wantFirst = false;
    let columns = null;

    const matches = row => filters.every(f => f(row));
    const run = () => {
      if (failReads.includes(tableName) && mode !== "delete") throw new Error(`cannot read ${tableName}`);
      if (failDeletes.includes(tableName) && mode === "delete") throw new Error(`cannot delete from ${tableName}`);
      const rows = tables[tableName] || [];
      const found = rows.filter(matches);
      if (mode === "delete") {
        tables[tableName] = rows.filter(r => ! matches(r));
        return found.length;
      }
      if (mode === "count") return wantFirst ? { c: found.length } : [{ c: found.length }];
      if (wantFirst) return found[0];
      if (columns) return found.map(r => Object.fromEntries(columns.map(c => [c, r[c]])));
      return found;
    };

    const api = {
      where(col, val) { filters.push(r => r[col] === val); return api; },
      whereNot(col, val) { filters.push(r => r[col] !== val); return api; },
      whereNotNull(col) { filters.push(r => r[col] != null); return api; },
      whereIn(col, source) {
        const values = Array.isArray(source) ? source : source.__run().map(r => Object.values(r)[0]);
        filters.push(r => values.includes(r[col]));
        return api;
      },
      orderBy() { return api; },
      select(...cols) { columns = cols; return api; },
      count() { mode = "count"; return api; },
      first() { wantFirst = true; return api; },
      delete() { mode = "delete"; return api; },
      insert(row) {
        tables[tableName] = tables[tableName] || [];
        tables[tableName].push({ id: nextId++, ...row });
        return Promise.resolve([1]);
      },
      __run: run,
      then(resolve, reject) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return api;
  };

  const knex = tableName => builder(tableName);
  knex.schema = {
    hasTable: async name => {
      if (failHasTable) throw new Error("cannot check tables");
      return Object.prototype.hasOwnProperty.call(tables, name);
    },
    createTable: async name => { tables[name] = []; },
  };
  knex.transaction = async cb => cb(knex);
  knex.tables = tables;
  return knex;
}

const notFound = code => Object.assign(new Error("Unknown"), { code });

// Loads the plugin against fakes and returns the registered commands plus everything to inspect
function setup({ tables = {}, knexOptions, config = {}, bot = {}, threadsById = {}, format } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "datarequests-"));
  const logDir = path.join(dir, "logs");
  const attachmentDir = path.join(dir, "attachments");
  fs.mkdirSync(logDir);
  fs.mkdirSync(attachmentDir);

  const knex = createFakeKnex(tables, knexOptions);
  const handlers = {};
  const sentFormats = [];

  const fullBot = {
    createMessage: async () => ({}),
    deleteMessage: async () => {},
    getDMChannel: async () => ({ createMessage: async () => ({ id: "dm1" }) }),
    ...bot,
  };

  plugin({
    bot: fullBot,
    knex,
    config: {
      prefix: "!",
      attachmentStorage: "local",
      attachmentDir,
      logOptions: { attachmentDirectory: logDir },
      ...config,
    },
    commands: { addInboxServerCommand: (name, sig, handler) => { handlers[name] = handler; } },
    threads: { findById: async id => threadsById[id] || null },
    formats: {
      formatters: {
        formatLog: format || (async (thread, messages) => {
          sentFormats.push(messages);
          return { content: `log of ${thread.id}` };
        }),
      },
    },
  });

  const replies = [];
  const channel = {
    id: "ops-channel",
    createMessage: async (content, file) => {
      replies.push({ content, file });
      return { id: `msg${replies.length}` };
    },
  };
  const msg = { channel, member: { roles: [] } };

  return {
    knex, handlers, replies, msg, dir, logDir, attachmentDir, sentFormats,
    run: (name, args = {}, thread) => handlers[name](msg, args, thread),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { setup, notFound };
