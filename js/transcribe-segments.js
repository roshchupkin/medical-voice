// Chunked, resumable transcription for crash-safe recording sessions.

import * as db from './db.js';
import * as recordingSession from './recording-session.js';
import { decodeToMono16k } from './audio-decode.js';
import { splitIntoSegments, mergeChunkArrays, mergeTranscriptionText } from './segments.js';
import { draftTitle, t } from './i18n.js';
import {
  measureStep,
  recordStep,
  utf8ByteLength,
} from './perf-metrics.js';

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
  metricsRun,
  onWhisperLoad,
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

  if (metricsRun && completed === 0) {
    await measureStep(metricsRun, 'whisperModelLoad', t('perf.stepWhisperLoad'), async () => {
      await ensureModelLoaded();
      onWhisperLoad?.();
    });
  } else {
    await ensureModelLoaded();
  }

  for (let seg = completed; seg < totalSegments; seg++) {
    if (isCancelled && isCancelled()) throw new Error('Transcription cancelled');

    const startIndex = seg * recordingSession.CHUNKS_PER_SEGMENT;
    const remaining = session.chunkCount - startIndex;
    const count = Math.min(recordingSession.CHUNKS_PER_SEGMENT, remaining);
    if (count <= 0) break;

    onProgress?.({ segment: seg + 1, totalSegments, message: t('status.segmentProgress', { current: seg + 1, total: totalSegments }) });

    const segmentBlob = await recordingSession.getSegmentBlob(sessionId, startIndex, count);
    if (!segmentBlob) break;

    const segLabel = totalSegments > 1
      ? t('perf.stepWhisperTranscribeSeg', { current: seg + 1, total: totalSegments })
      : t('perf.stepWhisperTranscribe');

    let audioData;
    if (metricsRun) {
      const inputSize = segmentBlob.blob.size;
      audioData = await measureStep(
        metricsRun,
        'audioDecode',
        t('perf.stepAudioDecode'),
        () => decodeToMono16k(segmentBlob.blob),
        {
          input: inputSize,
          meta: { segmentIndex: seg + 1 },
          _fromResult: (data) => ({ output: data.byteLength, audioPcm: data.byteLength }),
        },
      );
    } else {
      try {
        audioData = await decodeToMono16k(segmentBlob.blob);
      } catch (err) {
        throw new Error(`Could not decode segment ${seg + 1}. ${err.message || ''}`);
      }
    }

    const offsetSec = seg * recordingSession.SEGMENT_MINUTES * 60;
    let segmentPartialTimer = null;
    let lastPartialPersist = 0;

    let segmentText;
    let segmentChunks;
    if (metricsRun) {
      const workerResult = await transcribeInWorker(
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
      segmentText = workerResult.text;
      segmentChunks = workerResult.chunks;
      const wm = workerResult.metrics || {};
      recordStep(metricsRun, 'whisperTranscribe', segLabel, {
        durationMs: wm.durationMs,
        spaceBytes: {
          audioPcm: wm.audioPcm,
          audioDurationSec: wm.audioSamples ? wm.audioSamples / 16000 : undefined,
          transcriptUtf8: wm.transcriptUtf8,
        },
        memory: wm.memory,
        meta: { segmentIndex: seg + 1 },
      });
    } else {
      const result = await transcribeInWorker(
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
      segmentText = result.text;
      segmentChunks = result.chunks;
    }

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
  const finalText = text;
  const finalChunks = chunks;
  if (metricsRun) {
    const segments = splitIntoSegments(finalText, finalChunks);
    recordStep(metricsRun, 'segmentSplit', t('perf.stepSegmentSplit'), {
      durationMs: 0,
      spaceBytes: {
        segmentCount: segments.length,
        transcriptUtf8: utf8ByteLength(finalText),
      },
      memory: { available: false, heapUsedBefore: null, heapUsedAfter: null, heapDelta: null },
    });
  }
  return db.updateTranscript(draftId, {
    text: finalText,
    transcription,
    raw: { text: finalText, segments: splitIntoSegments(finalText, finalChunks), modelId },
    language,
  });
}

export function isTranscriptionIncomplete(draft) {
  if (!draft || draft.status !== 'draft') return false;
  const tr = draft.transcription;
  if (!tr) return false;
  if (tr.monolithic) return !tr.complete && !!tr.started;
  if (tr.complete) return false;
  return (tr.totalSegments || 0) > 0 && (tr.completedSegments || 0) < tr.totalSegments;
}
