// IndexedDB wrapper with per-user encryption at rest.
//
// All patient data (transcript text, titles, form values, audio) is stored as
// AES-GCM ciphertext under the logged-in user's key. The only readable fields
// are the record id, createdAt, mimeType, and `owner` — an opaque hash that
// namespaces records per user without storing usernames.
//
// Every function here requires an unlocked session and throws when locked.

import { getSession } from './auth.js';
import { encryptJSON, decryptJSON, encryptBlob, decryptBlob } from './crypto-store.js';

const DB_NAME = 'whisper-local';
const DB_VERSION = 5;

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
        store.createIndex('owner', 'owner');
      } else {
        const store = req.transaction.objectStore('transcripts');
        if (!store.indexNames.contains('owner')) store.createIndex('owner', 'owner');
      }
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // v4: local correction memory + medical dictionaries (encrypted per user).
      if (!db.objectStoreNames.contains('correctionRules')) {
        const store = db.createObjectStore('correctionRules', { keyPath: 'id' });
        store.createIndex('owner', 'owner');
      }
      if (!db.objectStoreNames.contains('dictionaries')) {
        const store = db.createObjectStore('dictionaries', { keyPath: 'id' });
        store.createIndex('owner', 'owner');
      }
      // v5: crash-safe recording sessions + encrypted chunk store.
      if (!db.objectStoreNames.contains('recordingSessions')) {
        const store = db.createObjectStore('recordingSessions', { keyPath: 'id' });
        store.createIndex('owner', 'owner');
        store.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('recordingChunks')) {
        const store = db.createObjectStore('recordingChunks', { keyPath: ['sessionId', 'index'] });
        store.createIndex('sessionId', 'sessionId');
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

// --- Transcripts ---
// Decrypted shape (in memory): { id, createdAt, title, text, language, recordingId?, form? }
// Stored shape: { id, owner, createdAt, iv, ciphertext }

async function decryptTranscriptRow(row) {
  const payload = await decryptJSON(row.iv, row.ciphertext);
  return { id: row.id, createdAt: row.createdAt, ...payload };
}

export async function listTranscripts() {
  const { userId } = getSession();
  const db = await openDb();
  const rows = await tx(db, 'transcripts', 'readonly', (store) => store.getAll());
  const items = [];
  for (const row of rows) {
    if (row.owner !== userId || !row.ciphertext) continue;
    try {
      items.push(await decryptTranscriptRow(row));
    } catch (e) {
      console.warn('Skipping undecryptable transcript', row.id, e);
    }
  }
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return items;
}

export async function getTranscript(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'transcripts', 'readonly', (store) => store.get(id));
  if (!row || row.owner !== userId || !row.ciphertext) return null;
  return decryptTranscriptRow(row);
}

export async function saveTranscript(entry) {
  const { userId } = getSession();
  const db = await openDb();
  const { id, createdAt, owner, iv: _iv, ciphertext: _ct, ...payload } = entry;
  const { iv, ciphertext } = await encryptJSON(payload);
  await tx(db, 'transcripts', 'readwrite', (store) => store.put({ id, owner: userId, createdAt, iv, ciphertext }));
  return entry;
}

export async function updateTranscript(id, patch) {
  const existing = await getTranscript(id);
  if (!existing) throw new Error('Transcript not found');
  const updated = { ...existing, ...patch, id };
  await saveTranscript(updated);
  return updated;
}

export async function deleteTranscript(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'transcripts', 'readonly', (store) => store.get(id));
  if (!row) return;
  if (row.owner !== userId) throw new Error('Transcript belongs to another user');
  let recordingId = null;
  let recordingSessionId = null;
  try {
    const payload = await decryptJSON(row.iv, row.ciphertext);
    recordingId = payload.recordingId || null;
    recordingSessionId = payload.recordingSessionId || null;
  } catch (_) { /* corrupt record: still delete the row itself */ }
  await tx(db, 'transcripts', 'readwrite', (store) => store.delete(id));
  if (recordingId) await deleteRecording(recordingId);
  if (recordingSessionId) await deleteRecordingSession(recordingSessionId);
}

export async function listDraftTranscripts() {
  const items = await listTranscripts();
  return items.filter((t) => t.status === 'draft');
}

// --- Recordings ---
// Stored shape: { id, owner, mimeType, iv, ciphertext }

export async function saveRecording(id, blob, mimeType) {
  const { userId } = getSession();
  const db = await openDb();
  const type = mimeType || blob.type || 'audio/webm';
  const { iv, ciphertext } = await encryptBlob(blob);
  await tx(db, 'recordings', 'readwrite', (store) => store.put({ id, owner: userId, mimeType: type, iv, ciphertext }));
  return id;
}

export async function getRecording(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'recordings', 'readonly', (store) => store.get(id));
  if (!row || row.owner !== userId || !row.ciphertext) return null;
  try {
    const blob = await decryptBlob(row.iv, row.ciphertext, row.mimeType);
    return { id: row.id, blob, mimeType: row.mimeType };
  } catch (e) {
    console.warn('Could not decrypt recording', id, e);
    return null;
  }
}

export async function deleteRecording(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'recordings', 'readonly', (store) => store.get(id));
  if (!row) return;
  if (row.owner && row.owner !== userId) throw new Error('Recording belongs to another user');
  await tx(db, 'recordings', 'readwrite', (store) => store.delete(id));
}

// --- Form template (clinician-editable field list, per user) ---
// Stored shape: { key: 'formTemplate:<userId>', iv, ciphertext }

function templateKey(userId) {
  return 'formTemplate:' + userId;
}

export async function getFormTemplate() {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'settings', 'readonly', (store) => store.get(templateKey(userId)));
  if (!row || !row.ciphertext) return null;
  try {
    return await decryptJSON(row.iv, row.ciphertext);
  } catch (e) {
    console.warn('Could not decrypt form template', e);
    return null;
  }
}

export async function saveFormTemplate(fields) {
  const { userId } = getSession();
  const db = await openDb();
  const { iv, ciphertext } = await encryptJSON(fields);
  await tx(db, 'settings', 'readwrite', (store) => store.put({ key: templateKey(userId), iv, ciphertext }));
  return fields;
}

// --- Form template library (built-in + custom templates, per user) ---
// Stored shape: { key: 'formTemplateLibrary:<userId>', iv, ciphertext }
// Decrypted: { activeTemplateId, custom: [{ id, name, category, fields, ... }] }

function templateLibraryKey(userId) {
  return 'formTemplateLibrary:' + userId;
}

export async function getFormTemplateLibrary() {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'settings', 'readonly', (store) => store.get(templateLibraryKey(userId)));
  if (!row || !row.ciphertext) return null;
  try {
    return await decryptJSON(row.iv, row.ciphertext);
  } catch (e) {
    console.warn('Could not decrypt form template library', e);
    return null;
  }
}

export async function saveFormTemplateLibrary(state) {
  const { userId } = getSession();
  const db = await openDb();
  const { iv, ciphertext } = await encryptJSON(state);
  await tx(db, 'settings', 'readwrite', (store) => store.put({ key: templateLibraryKey(userId), iv, ciphertext }));
  return state;
}

// --- Legacy migration ---
// Records written before the login feature have no `owner` field and are
// plaintext. On the first login after the upgrade, they are encrypted under
// that user and the plaintext is overwritten, so no unencrypted patient data
// remains in the browser. Returns the number of migrated items.

export async function migrateLegacyData() {
  const { userId } = getSession();
  const db = await openDb();
  let migrated = 0;

  const transcriptRows = await tx(db, 'transcripts', 'readonly', (store) => store.getAll());
  for (const row of transcriptRows) {
    if (row.owner) continue;
    const { id, createdAt, ...payload } = row;
    const { iv, ciphertext } = await encryptJSON(payload);
    await tx(db, 'transcripts', 'readwrite', (store) => store.put({ id, owner: userId, createdAt, iv, ciphertext }));
    migrated++;
  }

  const recordingRows = await tx(db, 'recordings', 'readonly', (store) => store.getAll());
  for (const row of recordingRows) {
    if (row.owner || !row.blob) continue;
    const type = row.mimeType || row.blob.type || 'audio/webm';
    const { iv, ciphertext } = await encryptBlob(row.blob);
    await tx(db, 'recordings', 'readwrite', (store) => store.put({ id: row.id, owner: userId, mimeType: type, iv, ciphertext }));
    migrated++;
  }

  const legacyTemplate = await tx(db, 'settings', 'readonly', (store) => store.get('formTemplate'));
  if (legacyTemplate && Array.isArray(legacyTemplate.fields)) {
    await saveFormTemplate(legacyTemplate.fields);
    await tx(db, 'settings', 'readwrite', (store) => store.delete('formTemplate'));
    migrated++;
  }

  return migrated;
}

// --- Correction rules (local correction memory, per user) ---
// Stored shape: { id, owner, iv, ciphertext }
// Decrypted payload: { id, scope, specialty?, from, to, mode, note, createdAt }

export async function listCorrectionRules() {
  const { userId } = getSession();
  const db = await openDb();
  const rows = await tx(db, 'correctionRules', 'readonly', (store) => store.getAll());
  const items = [];
  for (const row of rows) {
    if (row.owner !== userId || !row.ciphertext) continue;
    try {
      items.push({ id: row.id, ...(await decryptJSON(row.iv, row.ciphertext)) });
    } catch (e) {
      console.warn('Skipping undecryptable correction rule', row.id, e);
    }
  }
  items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return items;
}

export async function saveCorrectionRule(rule) {
  const { userId } = getSession();
  const db = await openDb();
  const id = rule.id || crypto.randomUUID();
  const { id: _id, owner: _o, iv: _iv, ciphertext: _ct, ...payload } = rule;
  const { iv, ciphertext } = await encryptJSON({ ...payload, id });
  await tx(db, 'correctionRules', 'readwrite', (store) => store.put({ id, owner: userId, iv, ciphertext }));
  return { id, ...payload };
}

export async function deleteCorrectionRule(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'correctionRules', 'readonly', (store) => store.get(id));
  if (!row) return;
  if (row.owner !== userId) throw new Error('Rule belongs to another user');
  await tx(db, 'correctionRules', 'readwrite', (store) => store.delete(id));
}

// --- Medical dictionary entries (per user) ---
// Stored shape: { id, owner, iv, ciphertext }
// Decrypted payload: { id, term, category, expansion?, specialty?, source }

export async function listDictionaryEntries() {
  const { userId } = getSession();
  const db = await openDb();
  const rows = await tx(db, 'dictionaries', 'readonly', (store) => store.getAll());
  const items = [];
  for (const row of rows) {
    if (row.owner !== userId || !row.ciphertext) continue;
    try {
      items.push({ id: row.id, ...(await decryptJSON(row.iv, row.ciphertext)) });
    } catch (e) {
      console.warn('Skipping undecryptable dictionary entry', row.id, e);
    }
  }
  return items;
}

export async function saveDictionaryEntry(entry) {
  const { userId } = getSession();
  const db = await openDb();
  const id = entry.id || crypto.randomUUID();
  const { id: _id, owner: _o, iv: _iv, ciphertext: _ct, ...payload } = entry;
  const { iv, ciphertext } = await encryptJSON({ ...payload, id });
  await tx(db, 'dictionaries', 'readwrite', (store) => store.put({ id, owner: userId, iv, ciphertext }));
  return { id, ...payload };
}

export async function deleteDictionaryEntry(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'dictionaries', 'readonly', (store) => store.get(id));
  if (!row) return;
  if (row.owner !== userId) throw new Error('Entry belongs to another user');
  await tx(db, 'dictionaries', 'readwrite', (store) => store.delete(id));
}

// --- Recording sessions (crash-safe incremental recording) ---
// Session row: { id, owner, mimeType, startedAt, status, chunkCount, lastChunkAt }
// Chunk row: { sessionId, index, iv, ciphertext }

export async function saveRecordingSession(session) {
  const { userId } = getSession();
  const db = await openDb();
  const row = { ...session, owner: userId };
  await tx(db, 'recordingSessions', 'readwrite', (store) => store.put(row));
  return row;
}

export async function getRecordingSession(id) {
  const { userId } = getSession();
  const db = await openDb();
  const row = await tx(db, 'recordingSessions', 'readonly', (store) => store.get(id));
  if (!row || row.owner !== userId) return null;
  return row;
}

export async function updateRecordingSession(id, patch) {
  const existing = await getRecordingSession(id);
  if (!existing) throw new Error('Recording session not found');
  return saveRecordingSession({ ...existing, ...patch, id });
}

export async function listRecordingSessions({ status } = {}) {
  const { userId } = getSession();
  const db = await openDb();
  const rows = await tx(db, 'recordingSessions', 'readonly', (store) => store.getAll());
  return rows
    .filter((r) => r.owner === userId && (!status || r.status === status))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

export async function saveRecordingChunk(sessionId, index, iv, ciphertext) {
  const session = await getRecordingSession(sessionId);
  if (!session) throw new Error('Recording session not found');
  const db = await openDb();
  await tx(db, 'recordingChunks', 'readwrite', (store) => store.put({ sessionId, index, iv, ciphertext }));
}

export async function getRecordingChunks(sessionId, startIndex = 0, count = Infinity) {
  const session = await getRecordingSession(sessionId);
  if (!session) throw new Error('Recording session not found');
  const db = await openDb();
  const rows = await tx(db, 'recordingChunks', 'readonly', (store) => {
    const idx = store.index('sessionId');
    return idx.getAll(sessionId);
  });
  rows.sort((a, b) => a.index - b.index);
  const end = count === Infinity ? rows.length : startIndex + count;
  return rows.filter((r) => r.index >= startIndex && r.index < end);
}

export async function deleteRecordingSession(sessionId) {
  const session = await getRecordingSession(sessionId);
  if (!session) return;
  const db = await openDb();
  const chunks = await tx(db, 'recordingChunks', 'readonly', (store) => {
    const idx = store.index('sessionId');
    return idx.getAll(sessionId);
  });
  await new Promise((resolve, reject) => {
    const t = db.transaction(['recordingSessions', 'recordingChunks'], 'readwrite');
    t.objectStore('recordingSessions').delete(sessionId);
    const chunkStore = t.objectStore('recordingChunks');
    for (const c of chunks) chunkStore.delete([c.sessionId, c.index]);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}
