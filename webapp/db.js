/* db.js — IndexedDB persistence for user-added items and their photos.
   Everything stays in the browser; nothing is uploaded to any server. */

'use strict';

const DBX = (() => {
  const DB_NAME = 'wardrobe';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    async getAllItems() { return reqP((await store('items', 'readonly')).getAll()); },
    async putItem(item) { return reqP((await store('items', 'readwrite')).put(item)); },
    async deleteItem(id) { return reqP((await store('items', 'readwrite')).delete(id)); },
    async putPhoto(key, blob) { return reqP((await store('photos', 'readwrite')).put({ key, blob })); },
    async getPhoto(key) {
      const rec = await reqP((await store('photos', 'readonly')).get(key));
      return rec ? rec.blob : null;
    },
    async deletePhotos(keys) {
      const s = await store('photos', 'readwrite');
      await Promise.all(keys.map(k => reqP(s.delete(k))));
    },
    async listPhotos(prefix) {
      const all = await reqP((await store('photos', 'readonly')).getAll());
      return all.filter(r => r.key.startsWith(prefix));
    },
  };
})();

if (typeof window !== 'undefined') window.DBX = DBX;
