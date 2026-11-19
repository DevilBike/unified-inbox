// Small IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'unified-inbox';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('accounts')) db.createObjectStore('accounts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'key' });
        s.createIndex('byView', ['accountId', 'view']);
      }
      if (!db.objectStoreNames.contains('cleanupLog')) {
        const s = db.createObjectStore('cleanupLog', { autoIncrement: true });
        s.createIndex('byRun', 'runId');
      }
      if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'email' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => req2p(s.get(k))),
  set: (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); }),
};

export const accounts = {
  all: () => tx('accounts', 'readonly', (s) => req2p(s.getAll())),
  put: (a) => tx('accounts', 'readwrite', (s) => { s.put(a); }),
  remove: (id) => tx('accounts', 'readwrite', (s) => { s.delete(id); }),
};

export const messages = {
  putMany: (list) => tx('messages', 'readwrite', (s) => { for (const m of list) s.put(m); }),
  forView: (accountId, view) => tx('messages', 'readonly', (s) => req2p(s.index('byView').getAll([accountId, view]))),
  removeMany: (keys) => tx('messages', 'readwrite', (s) => { for (const k of keys) s.delete(k); }),
  clearView: (accountId, view) => tx('messages', 'readwrite', async (s) => {
    const keys = await req2p(s.index('byView').getAllKeys([accountId, view]));
    for (const k of keys) s.delete(k);
  }),
  clearAll: () => tx('messages', 'readwrite', (s) => { s.clear(); }),
};

export const cleanupLog = {
  add: (entries) => tx('cleanupLog', 'readwrite', (s) => { for (const e of entries) s.add(e); }),
  forRun: (runId) => tx('cleanupLog', 'readonly', (s) => req2p(s.index('byRun').getAll(runId))),
  deleteRun: (runId) => tx('cleanupLog', 'readwrite', async (s) => {
    const keys = await req2p(s.index('byRun').getAllKeys(runId));
    for (const k of keys) s.delete(k);
  }),
};

export const contacts = {
  putMany: (list) => tx('contacts', 'readwrite', (s) => { for (const c of list) if (c.email) s.put(c); }),
  all: () => tx('contacts', 'readonly', (s) => req2p(s.getAll())),
};

export async function wipeEverything() {
  const db = await open();
  db.close();
  dbPromise = null;
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = resolve; r.onerror = () => reject(r.error); r.onblocked = resolve; });
}
