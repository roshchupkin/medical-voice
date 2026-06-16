// Chunked, resumable transcription for crash-safe recording sessions.

import * as db from './db.js';
import * as recordingSession from './recording-session.js';
import { decodeToMono16k } from './audio-decode.js';
import { splitIntoSegments, mergeChunkArrays, mergeTranscriptionText } from './segments.js';
import { draftTitle, t } from './i18n.js';

export { SEGMENT_MINUTES, CHUNKS_PER_SEGMENT } from './recording-session.js';

export async function createDraftForSession(sessionId, { language, modelId } = {}) {
  const session = await recordingSession.getSession(sessionId);
  if (!session) throw new Error('Recording session not found');
  const id = crypto.randomUUID();
  const entry = {
    id,
    title: draftTitle(),
    text: '',
    language: language || 'auto',
    status: 'draft',
    createdAt: new Date().toISOString(),
    recordingSessionId: sessionId,
    transcription: {
      completedSegments: 0,
      totalSegments: recordingSession.totalSegments(session.chunkCount),
      modelId: modelId || null,
      chunks: [],
      complete: false,
    },
  };
  await db.saveTranscript(entry);
  return entry;
}

export async function createAudioOnlyDraft(recordingId, { language, mimeType } = {}) {
  const id = crypto.randomUUID();
  const entry = {
    id,
    title: draftTitle(),
    text: '',
    language: language || 'auto',
    status: 'draft',
    createdAt: new Date().toISOString(),
    recordingId,
    uploadMimeType: mimeType || null,
    transcription: { complete: false, monolithic: true, started: false },
  };
  await db.saveTranscript(entry);
  return entry;
}

export async function transcribeRecordingSession(sessionId, draftId, {
  language,
  modelId,
  ensureModelLoaded,
  transcribeInWorker,
  onProgress,
  onPartial,
  persistPartial,
  isCancelled,
}) {
  const session = await recordingSession.getSession(sessionId);
  if (!session) throw new Error('Recording session not found');

  let draft = await db.getTranscript(draftId);
  if (!draft) throw new Error('Draft transcript not found');

  const totalSegments = recordingSession.totalSegments(session.chunkCount);
  let completed = draft.transcription?.completedSegments || 0;
  let text = draft.text || '';
  let chunks = draft.transcription?.chunks || [];

  if (!draft.transcription) {
    draft.transcription = { completedSegments: 0, totalSegments, modelId, chunks: [], complete: false };
  }
  draft.transcription.totalSegments = totalSegments;
  draft.transcription.modelId = modelId;

  await ensureModelLoaded();

  for (let seg = completed; seg < totalSegments; seg++) {
    if (isCancelled && isCancelled()) throw new Error('Transcription cancelled');

    const startIndex = seg * recordingSession.CHUNKS_PER_SEGMENT;
    const remaining = session.chunkCount - startIndex;
    const count = Math.min(recordingSession.CHUNKS_PER_SEGMENT, remaining);
    if (count <= 0) break;

    onProgress?.({ segment: seg + 1, totalSegments, message: t('status.segmentProgress', { current: seg + 1, total: totalSegments }) });

    const segmentBlob = await recordingSession.getSegmentBlob(sessionId, startIndex, count);
    if (!segmentBlob) break;

    let audioData;
    try {
      audioData = await decodeToMono16k(segmentBlob.blob);
    } catch (err) {
      throw new Error(`Could not decode segment ${seg + 1}. ${err.message || ''}`);
    }

    const offsetSec = seg * recordingSession.SEGMENT_MINUTES * 60;
    let segmentPartialTimer = null;
    let lastPartialPersist = 0;

    const { text: segmentText, chunks: segmentChunks } = await transcribeInWorker(
      audioData,
      language,
      (partial) => {
        onPartial?.(mergeTranscriptionText(text, partial));
        if (persistPartial) {
          const now = Date.now();
          if (now - lastPartialPersist >= 30000) {
            lastPartialPersist = now;
            if (segmentPartialTimer) clearTimeout(segmentPartialTimer);
            segmentPartialTimer = setTimeout(() => {
              persistPartial({
                text: mergeTranscriptionText(text, partial),
                transcription: {
                  ...draft.transcription,
                  completedSegments: completed,
                  totalSegments,
                  chunks,
                  complete: false,
                },
              }).catch(() => {});
            }, 0);
          }
        }
      },
    );

    if (segmentPartialTimer) clearTimeout(segmentPartialTimer);

    text = mergeTranscriptionText(text, segmentText);
    chunks = mergeChunkArrays(chunks, segmentChunks, offsetSec);
    completed = seg + 1;

    const transcription = {
      completedSegments: completed,
      totalSegments,
      modelId,
      chunks,
      complete: completed >= totalSegments,
    };
    const raw = { text, segments: splitIntoSegments(text, chunks), modelId };

    draft = await db.updateTranscript(draftId, { text, transcription, raw, language });
    onPartial?.(text);
  }

  const transcription = {
    ...(draft.transcription || {}),
    completedSegments: completed,
    totalSegments,
    modelId,
    chunks,
    complete: true,
  };
  return db.updateTranscript(draftId, {
    text,
    transcription,
    raw: { text, segments: splitIntoSegments(text, chunks), modelId },
    language,
  });
}

export function isTranscriptionIncomplete(draft) {
  if (!draft || draft.status !== 'draft') return false;
  const t = draft.transcription;
  if (!t) return false;
  if (t.monolithic) return !t.complete && !!t.started;
  if (t.complete) return false;
  return (t.totalSegments || 0) > 0 && (t.completedSegments || 0) < t.totalSegments;
}
