// IndexedDB wrapper: transcripts (metadata + text), recordings (audio blobs),
// and settings (form template).

const DB_NAME = 'whisper-local';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('transcripts')) {
        const store = db.createObjectStore('transcripts', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => {
      if (result && typeof result.then === 'undefined' && 'result' in result) {
        resolve(result.result);
      } else {
        resolve(result);
      }
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export async function listTranscripts() {
  const db = await openDb();
  const items = await tx(db, 'transcripts', 'readonly', (store) => store.getAll());
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return items;
}

export async function getTranscript(id) {
  const db = await openDb();
  return tx(db, 'transcripts', 'readonly', (store) => store.get(id));
}

export async function saveTranscript(entry) {
  const db = await openDb();
  await tx(db, 'transcripts', 'readwrite', (store) => store.put(entry));
  return entry;
}

export async function updateTranscript(id, patch) {
  const db = await openDb();
  const existing = await tx(db, 'transcripts', 'readonly', (store) => store.get(id));
  if (!existing) throw new Error('Transcript not found');
  const updated = { ...existing, ...patch, id };
  await tx(db, 'transcripts', 'readwrite', (store) => store.put(updated));
  return updated;
}

export async function deleteTranscript(id) {
  const db = await openDb();
  const existing = await tx(db, 'transcripts', 'readonly', (store) => store.get(id));
  await tx(db, 'transcripts', 'readwrite', (store) => store.delete(id));
  if (existing && existing.recordingId) {
    await deleteRecording(existing.recordingId);
  }
}

export async function saveRecording(id, blob, mimeType) {
  const db = await openDb();
  await tx(db, 'recordings', 'readwrite', (store) => store.put({ id, blob, mimeType: mimeType || blob.type || 'audio/webm' }));
  return id;
}

export async function getRecording(id) {
  const db = await openDb();
  return tx(db, 'recordings', 'readonly', (store) => store.get(id));
}

export async function deleteRecording(id) {
  const db = await openDb();
  await tx(db, 'recordings', 'readwrite', (store) => store.delete(id));
}

// --- Form template (clinician-editable field list) ---

export async function getFormTemplate() {
  const db = await openDb();
  const entry = await tx(db, 'settings', 'readonly', (store) => store.get('formTemplate'));
  return entry ? entry.fields : null;
}

export async function saveFormTemplate(fields) {
  const db = await openDb();
  await tx(db, 'settings', 'readwrite', (store) => store.put({ key: 'formTemplate', fields }));
  return fields;
}
