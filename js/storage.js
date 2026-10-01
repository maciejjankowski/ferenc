// Minimal IndexedDB key/value wrapper. Stores: samples (raw file bytes), kv (project autosave, settings).

const DB_NAME = 'ferenc';
const DB_VERSION = 1;
const STORES = ['samples', 'kv'];

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  put: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  clear: store => tx(store, 'readwrite', s => s.clear()),
  all: store => tx(store, 'readonly', s => s.getAll()),
};

/** Wrap a call so a missing/blocked IndexedDB never breaks the app. */
export async function safe(promise, fallback = null) {
  try { return await promise; } catch (e) { console.warn('[storage]', e); return fallback; }
}
