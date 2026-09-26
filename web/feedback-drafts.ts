type Draft = Record<string, any>;
function open() { return new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('codex-mobile-feedback', 1); req.onupgradeneeded = () => req.result.createObjectStore('drafts'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
export async function feedbackDraft(key: string, value?: Draft | null): Promise<Draft | undefined> {
  const db = await open();
  try { return await new Promise((resolve, reject) => { const tx = db.transaction('drafts', value === undefined ? 'readonly' : 'readwrite'); const store = tx.objectStore('drafts'); const request = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key); tx.oncomplete = () => resolve(value === undefined ? request.result : undefined); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
