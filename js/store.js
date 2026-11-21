// Storage. Settings, rules and the cleanup history live in your user folder on this PC
// (through the local app); the browser only keeps a cache of message lists.
import { api } from './api.js';
const DB_NAME = 'unified-inbox-cache';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'key' });
        s.createIndex('byView', ['accountId', 'view']);
      }
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
  get: async (k) => (await api(`kv/${k}`)).value,
  set: (k, v) => api(`kv/${k}`, { method: 'PUT', body: { value: v } }),
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
  add: (runId, entries) => api(`log/${runId}`, { method: 'POST', body: { entries } }),
  forRun: async (runId) => (await api(`log/${runId}`)).entries,
  deleteRun: (runId) => api(`log/${runId}`, { method: 'DELETE' }),
};
