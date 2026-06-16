// Crash-safe recording: persist MediaRecorder chunks to IndexedDB as they arrive.

import * as db from './db.js';
import { encryptBlob, decryptBlob } from './crypto-store.js';

export const CHUNK_TIMESLICE_MS = 5000;
export const SEGMENT_MINUTES = 5;
export const CHUNKS_PER_SEGMENT = (SEGMENT_MINUTES * 60) / (CHUNK_TIMESLICE_MS / 1000);

const appendQueues = new Map();

function queueAppend(sessionId, fn) {
  const prev = appendQueues.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn);
  appendQueues.set(sessionId, next.finally(() => {
    if (appendQueues.get(sessionId) === next) appendQueues.delete(sessionId);
  }));
  return next;
}

export async function createSession(mimeType) {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.saveRecordingSession({
    id,
    mimeType: mimeType || 'audio/webm',
    startedAt,
    status: 'active',
    chunkCount: 0,
    lastChunkAt: null,
  });
  return id;
}

export async function appendChunk(sessionId, index, blob) {
  return queueAppend(sessionId, async () => {
    const { iv, ciphertext } = await encryptBlob(blob);
    await db.saveRecordingChunk(sessionId, index, iv, ciphertext);
    const session = await db.getRecordingSession(sessionId);
    if (!session) throw new Error('Recording session not found');
    await db.updateRecordingSession(sessionId, {
      chunkCount: Math.max(session.chunkCount || 0, index + 1),
      lastChunkAt: new Date().toISOString(),
    });
  });
}

export async function getActiveSession() {
  const sessions = await db.listRecordingSessions({ status: 'active' });
  return sessions[0] || null;
}

export async function completeSession(sessionId) {
  await db.updateRecordingSession(sessionId, { status: 'complete' });
}

export async function abandonSession(sessionId) {
  await db.deleteRecordingSession(sessionId);
}

export async function getSession(sessionId) {
  return db.getRecordingSession(sessionId);
}

async function decryptChunks(rows, mimeType) {
  const blobs = [];
  for (const row of rows) {
    const blob = await decryptBlob(row.iv, row.ciphertext, mimeType);
    blobs.push(blob);
  }
  return blobs;
}

export async function assembleSessionBlob(sessionId) {
  const session = await db.getRecordingSession(sessionId);
  if (!session) throw new Error('Recording session not found');
  const rows = await db.getRecordingChunks(sessionId);
  if (!rows.length) throw new Error('No audio chunks in session');
  const blobs = await decryptChunks(rows, session.mimeType);
  return { blob: new Blob(blobs, { type: session.mimeType }), mimeType: session.mimeType, session };
}

export async function getSegmentBlob(sessionId, startIndex, count) {
  const session = await db.getRecordingSession(sessionId);
  if (!session) throw new Error('Recording session not found');
  const rows = await db.getRecordingChunks(sessionId, startIndex, count);
  if (!rows.length) return null;
  const blobs = await decryptChunks(rows, session.mimeType);
  return { blob: new Blob(blobs, { type: session.mimeType }), mimeType: session.mimeType };
}

export function waitForPendingChunks(sessionId) {
  return appendQueues.get(sessionId) || Promise.resolve();
}

export async function listRecoverableSessions() {
  const [sessions, transcripts] = await Promise.all([
    db.listRecordingSessions({ status: 'complete' }),
    db.listTranscripts(),
  ]);
  const linked = new Set();
  for (const t of transcripts) {
    if (t.recordingSessionId) linked.add(t.recordingSessionId);
  }
  return sessions
    .filter((s) => (s.chunkCount || 0) > 0 && !linked.has(s.id))
    .sort((a, b) => (b.lastChunkAt || b.startedAt || '').localeCompare(a.lastChunkAt || a.startedAt || ''));
}

export function totalSegments(chunkCount) {
  if (!chunkCount) return 0;
  return Math.ceil(chunkCount / CHUNKS_PER_SEGMENT);
}
