import * as db from './db.js';
import * as auth from './auth.js';
import { DEFAULT_MODEL, DEFAULT_LANGUAGE } from './config.js';
import { splitIntoSegments } from './segments.js';
import { decodeToMono16k } from './audio-decode.js';
import {
  buildCorrectionWindows,
  mergeCorrectionResults,
  detectBoundaryConflicts,
  filterSegmentsForExtract,
} from './correction-chunks.js';
import * as recordingSession from './recording-session.js';
import * as transcribeSegments from './transcribe-segments.js';
import * as correctionMemory from './correction-memory.js';
import { findKnownTerms } from './clinical-lexicon.js';
import { annotateTranscriptUncertainty } from './uncertainty.js';
import { generateFinalReviewedTranscript, buildEditLog } from './final-transcript.js';
import { createReviewUI } from './review-ui.js';
import { createFormReviewUI, exportFinalForm, normalizePipelineForm } from './form-review-ui.js';
import { assertFormGenerationAllowed } from './safety.js';
import { probeWebGpuAvailable } from './webgpu-probe.js';
import { t, applyStatic, onLangChange, toggleLang, getDefaultTemplate, getLang } from './i18n.js';
import {
  createMetricsRun,
  measureStep,
  measureStepSync,
  recordStep,
  finalizeRun,
  mergeMetrics,
  renderMetricsTable,
  sumFileProgressBytes,
  utf8ByteLength,
} from './perf-metrics.js';

// --- DOM ---
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginError = document.getElementById('loginError');
const lockBtn = document.getElementById('lockBtn');
const langToggleBtn = document.getElementById('langToggleBtn');
const engineBadge = document.getElementById('engineBadge');
const modelStatus = document.getElementById('modelStatus');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const recordBtn = document.getElementById('recordBtn');
const fileInput = document.getElementById('fileInput');
const recordingIndicator = document.getElementById('recordingIndicator');
const recordingTimeEl = document.getElementById('recordingTime');
const recordingPausedEl = document.getElementById('recordingPaused');
const pauseRecordBtn = document.getElementById('pauseRecordBtn');
const modelSelect = document.getElementById('modelSelect');
const languageSelect = document.getElementById('languageSelect');
const resultEl = document.getElementById('result');
const saveBtn = document.getElementById('saveBtn');
const downloadBtn = document.getElementById('downloadBtn');
const recordedSection = document.getElementById('recordedSection');
const recordedAudio = document.getElementById('recordedAudio');
const transcribeBtn = document.getElementById('transcribeBtn');
const savedListEl = document.getElementById('savedList');
const detailPanel = document.getElementById('detailPanel');
const detailTitle = document.getElementById('detailTitle');
const detailContent = document.getElementById('detailContent');
const detailEditArea = document.getElementById('detailEditArea');
const backToListBtn = document.getElementById('backToListBtn');
const detailEditBtn = document.getElementById('detailEditBtn');
const detailSaveEditBtn = document.getElementById('detailSaveEditBtn');
const detailCancelEditBtn = document.getElementById('detailCancelEditBtn');
const detailRenameBtn = document.getElementById('detailRenameBtn');
const detailDownloadBtn = document.getElementById('detailDownloadBtn');
const detailRecordingSection = document.getElementById('detailRecordingSection');
const detailAudio = document.getElementById('detailAudio');
const detailRetranscribeBtn = document.getElementById('detailRetranscribeBtn');
const detailDownloadAudioLink = document.getElementById('detailDownloadAudioLink');
const toastEl = document.getElementById('toast');
const reviewBtn = document.getElementById('reviewBtn');
const detailFillFormBtn = document.getElementById('detailFillFormBtn');
const llmStatus = document.getElementById('llmStatus');
const llmProgressWrap = document.getElementById('llmProgressWrap');
const llmProgressBar = document.getElementById('llmProgressBar');
const templateFieldsEl = document.getElementById('templateFields');
const addFieldBtn = document.getElementById('addFieldBtn');
const resetTemplateBtn = document.getElementById('resetTemplateBtn');
const reviewPanel = document.getElementById('reviewPanel');
const reviewRoot = document.getElementById('reviewRoot');
const formPanel = document.getElementById('formPanel');
const formPanelStatus = document.getElementById('formPanelStatus');
const formReviewRoot = document.getElementById('formReviewRoot');
const recoveryBanner = document.getElementById('recoveryBanner');
const recoveryMessage = document.getElementById('recoveryMessage');
const recoveryRecoverBtn = document.getElementById('recoveryRecoverBtn');
const recoveryDiscardBtn = document.getElementById('recoveryDiscardBtn');
const transcribeProgressWrap = document.getElementById('transcribeProgressWrap');
const transcribeProgressBar = document.getElementById('transcribeProgressBar');
const detailResumeTranscribeBtn = document.getElementById('detailResumeTranscribeBtn');
const perfPanel = document.getElementById('perfPanel');
const perfPanelBody = document.getElementById('perfPanelBody');
const detailPerfPanel = document.getElementById('detailPerfPanel');
const detailPerfPanelBody = document.getElementById('detailPerfPanelBody');

// --- State ---
let currentTranscriptText = '';
let currentAudioBlob = null;        // unsaved recording/upload kept in memory
let currentAudioObjectUrl = null;
let currentChunks = [];             // Whisper segment timestamps for the current transcript
let currentRecordingSessionId = null;
let currentDraftId = null;
let pendingRecovery = null;
let currentDetailTranscript = null;
let detailAudioObjectUrl = null;
let isTranscribing = false;
let isExtracting = false;           // true during correction OR form filling
let llmSupported = false;           // set by probeWebGpu() — needs a working adapter, not just navigator.gpu
let llmUnavailableReason = '';
let currentMetrics = null;          // { transcription, correction, form, lastUpdated }
let activeLlmMetricsRun = null;     // metrics run for in-flight LLM phase
let lastWhisperReadyMetrics = null; // worker-reported load metrics

const UPLOAD_WARN_BYTES = 15 * 1024 * 1024; // ~1 h of Opus WebM at typical bitrates

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

function renderPerfPanel(metrics = currentMetrics) {
  renderMetricsTable(metrics, perfPanelBody);
}

function renderDetailPerfPanel(metrics) {
  if (!detailPerfPanelBody) return;
  renderMetricsTable(metrics, detailPerfPanelBody);
}

function applyMetrics(metrics) {
  currentMetrics = metrics;
  if (pipeline) pipeline.metrics = metrics;
  renderPerfPanel(metrics);
  if (currentDetailTranscript) {
    currentDetailTranscript.metrics = metrics;
    renderDetailPerfPanel(metrics);
  }
}

async function persistMetricsNow() {
  if (!auth.isUnlocked() || !currentMetrics) return;
  const id = pipeline?.id || currentDraftId;
  if (!id) return;
  try {
    await db.updateTranscript(id, { metrics: currentMetrics });
  } catch (_) { /* best-effort */ }
}

function patchWhisperLoadStep(metricsRun) {
  if (!metricsRun) return;
  const step = metricsRun.steps.find((s) => s.id === 'whisperModelLoad');
  if (!step) return;
  step.spaceBytes.download = sumFileProgressBytes(fileProgress);
  if (lastWhisperReadyMetrics && !lastWhisperReadyMetrics.cached) {
    step.durationMs = lastWhisperReadyMetrics.durationMs ?? step.durationMs;
    if (lastWhisperReadyMetrics.memory) step.memory = lastWhisperReadyMetrics.memory;
  }
}

// The staged pipeline currently under review/editing. One shared object drives
// both the review panel and the form panel. See buildPipeline().
//   { id, title, language, raw:{text,segments,modelId}, correction, annotations,
//     edits, ruleApplications, finalTranscript, editLog, form }
let pipeline = null;

// --- Worker / model loading ---
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

let modelReady = null;      // { modelId } once loaded
let pendingLoad = null;     // { modelId, resolve, reject }
const pendingJobs = new Map(); // id -> { resolve, reject, onPartial }
let jobCounter = 0;
const fileProgress = new Map(); // file -> { loaded, total }

worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'device': {
      engineBadge.textContent = msg.device === 'webgpu' ? t('engine.webgpu') : t('engine.wasm');
      engineBadge.className = 'badge ' + (msg.device === 'webgpu' ? 'webgpu' : 'wasm');
      break;
    }
    case 'progress': {
      fileProgress.set(msg.file, { loaded: msg.loaded, total: msg.total });
      let loaded = 0, total = 0;
      for (const p of fileProgress.values()) { loaded += p.loaded; total += p.total; }
      if (total > 0) {
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        progressWrap.classList.add('visible');
        progressBar.style.width = pct + '%';
        modelStatus.textContent = t('engine.downloading', {
          pct,
          loaded: (loaded / 1048576).toFixed(0),
          total: (total / 1048576).toFixed(0),
        });
      }
      break;
    }
    case 'ready': {
      if (msg.metrics) lastWhisperReadyMetrics = msg.metrics;
      modelReady = { modelId: msg.modelId };
      progressWrap.classList.remove('visible');
      progressBar.style.width = '0%';
      fileProgress.clear();
      modelStatus.textContent = t('engine.ready', { model: shortModelName(msg.modelId) });
      if (pendingLoad && pendingLoad.modelId === msg.modelId) {
        pendingLoad.resolve();
        pendingLoad = null;
      }
      break;
    }
    case 'partial': {
      const job = pendingJobs.get(msg.id);
      if (job && job.onPartial) job.onPartial(msg.text);
      break;
    }
    case 'complete': {
      const job = pendingJobs.get(msg.id);
      if (job) {
        pendingJobs.delete(msg.id);
        job.resolve({ text: msg.text, chunks: msg.chunks || [], metrics: msg.metrics || null });
      }
      break;
    }
    case 'error': {
      const err = new Error(msg.message || 'Worker error');
      if (msg.id !== undefined && pendingJobs.has(msg.id)) {
        const job = pendingJobs.get(msg.id);
        pendingJobs.delete(msg.id);
        job.reject(err);
      } else if (pendingLoad) {
        progressWrap.classList.remove('visible');
        modelStatus.textContent = t('engine.loadFailed', { error: err.message });
        pendingLoad.reject(err);
        pendingLoad = null;
      } else {
        showToast(t('toast.error', { error: err.message }));
      }
      break;
    }
  }
};

worker.onerror = (e) => {
  modelStatus.textContent = t('engine.workerFailed', { error: e.message || 'unknown error' });
  if (pendingLoad) { pendingLoad.reject(new Error(e.message || 'Worker failed')); pendingLoad = null; }
  for (const [id, job] of pendingJobs) {
    job.reject(new Error(e.message || 'Worker failed'));
    pendingJobs.delete(id);
  }
};

function shortModelName(modelId) {
  return modelId.split('/').pop();
}

function ensureModelLoaded() {
  const modelId = modelSelect.value;
  if (modelReady && modelReady.modelId === modelId) return Promise.resolve();
  if (pendingLoad && pendingLoad.modelId === modelId) return pendingLoad.promise;
  modelReady = null;
  fileProgress.clear();
  modelStatus.textContent = t('engine.loading', { model: shortModelName(modelId) });
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pendingLoad = { modelId, resolve, reject, promise };
  worker.postMessage({ type: 'load', modelId });
  return promise;
}

function transcribeInWorker(audioData, language, onPartial) {
  const id = ++jobCounter;
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, onPartial });
    worker.postMessage({ type: 'transcribe', id, audio: audioData, language: language || null }, [audioData.buffer]);
  });
}

// --- Audio decoding imported from js/audio-decode.js ---

// --- UI helpers ---
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function setResult(text, isError = false) {
  resultEl.textContent = text;
  resultEl.className = isError ? 'error' : '';
  currentTranscriptText = isError ? '' : (text || '');
  saveBtn.disabled = !currentTranscriptText;
  downloadBtn.disabled = !currentTranscriptText;
  reviewBtn.disabled = !currentTranscriptText || !llmSupported || isExtracting;
}

function setLoading(message) {
  resultEl.textContent = message || t('status.transcribing');
  resultEl.className = 'loading';
  saveBtn.disabled = true;
  downloadBtn.disabled = true;
  reviewBtn.disabled = true;
}

function showToast(message, durationMs = 2500) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  if (showToast._timer) clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.remove('show');
    showToast._timer = null;
  }, durationMs);
}

function setFormPanelStatus(kind, message) {
  if (!formPanelStatus) return;
  formPanelStatus.className = 'form-panel-status' + (kind ? ' ' + kind : '');
  formPanelStatus.textContent = message || '';
  formPanelStatus.classList.toggle('hidden', !message);
  if (formPanel) formPanel.classList.toggle('panel-attention', kind === 'success');
}

function downloadAsTxt(text, filename) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'transcript.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { dateStyle: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { timeStyle: 'short' });
  } catch (_) { return iso || '—'; }
}

function setCurrentAudio(blob, options = {}) {
  currentAudioBlob = blob;
  if (options && 'sessionId' in options) currentRecordingSessionId = options.sessionId;
  if (currentAudioObjectUrl) URL.revokeObjectURL(currentAudioObjectUrl);
  currentAudioObjectUrl = URL.createObjectURL(blob);
  recordedAudio.src = currentAudioObjectUrl;
  recordedSection.classList.remove('hidden');
}

function updateBeforeUnload() {
  const recording = mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused');
  const hasDraftWork = !!(currentDraftId && (currentTranscriptText || isTranscribing));
  if (recording || hasDraftWork || isTranscribing) {
    window.onbeforeunload = () => true;
  } else {
    window.onbeforeunload = null;
  }
}

function setTranscribeProgress(segment, totalSegments) {
  if (!transcribeProgressWrap || !transcribeProgressBar) return;
  if (!totalSegments || totalSegments <= 1) {
    transcribeProgressWrap.classList.remove('visible');
    transcribeProgressBar.style.width = '0%';
    return;
  }
  transcribeProgressWrap.classList.add('visible');
  transcribeProgressBar.style.width = Math.round((segment / totalSegments) * 100) + '%';
}

function hideRecoveryBanner() {
  pendingRecovery = null;
  recoveryBanner?.classList.remove('visible');
}

function showRecoveryBanner(recovery) {
  pendingRecovery = recovery;
  if (recoveryMessage) recoveryMessage.textContent = recovery.message || '';
  if (recoveryRecoverBtn) {
    if (recovery.type === 'draft') {
      recoveryRecoverBtn.textContent = recovery.resume ? t('recovery.resume') : t('recovery.openDraft');
    } else {
      recoveryRecoverBtn.textContent = t('recovery.recoverAudio');
    }
  }
  recoveryBanner?.classList.add('visible');
}

async function restoreDraftWorkspace(draftId) {
  const draft = await db.getTranscript(draftId);
  if (!draft) throw new Error('Draft not found');
  currentDraftId = draft.id;
  currentRecordingSessionId = draft.recordingSessionId || null;
  currentChunks = draft.transcription?.chunks || [];
  detailPanel.classList.add('hidden');
  if (draft.text) {
    setResult(draft.text);
  } else {
    setResult(t('status.draftLoaded'));
  }
  if (draft.recordingSessionId) {
    const { blob } = await recordingSession.assembleSessionBlob(draft.recordingSessionId);
    setCurrentAudio(blob, { sessionId: draft.recordingSessionId });
  } else if (draft.recordingId) {
    const rec = await db.getRecording(draft.recordingId);
    if (rec?.blob) setCurrentAudio(rec.blob, { sessionId: null });
  }
  hideRecoveryBanner();
  showToast(t('toast.draftRestored'));
  return draft;
}

async function checkRecovery() {
  hideRecoveryBanner();
  try {
    const activeSession = await recordingSession.getActiveSession();
    if (activeSession && activeSession.chunkCount > 0) {
      const mins = Math.round((activeSession.chunkCount * recordingSession.CHUNK_TIMESLICE_MS) / 60000);
      showRecoveryBanner({
        type: 'recording',
        sessionId: activeSession.id,
        message: t('recovery.interruptedRecording', { mins: mins || '<1' }),
      });
      return;
    }

    const drafts = await db.listDraftTranscripts();
    const incomplete = drafts.find((d) => transcribeSegments.isTranscriptionIncomplete(d));
    if (incomplete) {
      const tr = incomplete.transcription || {};
      const progress = tr.monolithic
        ? t('recovery.transcriptionInterrupted')
        : t('recovery.transcriptionProgress', { done: tr.completedSegments || 0, total: tr.totalSegments || '?' });
      showRecoveryBanner({
        type: 'draft',
        draftId: incomplete.id,
        resume: true,
        message: progress + t('recovery.openDraftContinue'),
      });
      return;
    }

    const withWork = drafts.find((d) => d.text || d.recordingSessionId || d.recordingId);
    if (withWork) {
      showRecoveryBanner({
        type: 'draft',
        draftId: withWork.id,
        resume: false,
        message: t('recovery.unsavedDraft'),
      });
      return;
    }

    const orphans = await recordingSession.listRecoverableSessions();
    if (orphans.length > 0) {
      const s = orphans[0];
      const mins = Math.round((s.chunkCount * recordingSession.CHUNK_TIMESLICE_MS) / 60000);
      showRecoveryBanner({
        type: 'recording',
        sessionId: s.id,
        message: t('recovery.orphanAudio', { mins: mins || '<1' }),
      });
    }
  } catch (e) {
    console.warn('Recovery check failed', e);
  }
}

async function recoverRecordingSession(sessionId) {
  try {
    const { blob } = await recordingSession.assembleSessionBlob(sessionId);
    currentRecordingSessionId = sessionId;
    currentDraftId = null;
    setCurrentAudio(blob, { sessionId });
    setResult(t('status.recoveredListen'));
    hideRecoveryBanner();
    showToast(t('toast.recordingRecovered'));
  } catch (e) {
    showToast(t('toast.recordingRecoverFailed', { error: e.message }));
  }
}

const persistDraftPartial = debounce(async (patch) => {
  if (!auth.isUnlocked() || !currentDraftId) return;
  try {
    await db.updateTranscript(currentDraftId, patch);
  } catch (_) { /* best-effort */ }
}, 30000);

async function runMonolithicTranscription(blob, onPartialTarget, metricsRun) {
  if (blob.size >= UPLOAD_WARN_BYTES) {
    showToast(t('toast.largeFile'), 8000);
  }
  const language = languageSelect.value || null;
  if (currentDraftId) {
    const existing = await db.getTranscript(currentDraftId);
    const prev = existing?.transcription || {};
    await db.updateTranscript(currentDraftId, {
      transcription: { ...prev, complete: false, monolithic: true, started: true },
    });
  }

  let audioData;
  if (metricsRun) {
    const inputSize = blob.size;
    try {
      audioData = await measureStep(
        metricsRun,
        'audioDecode',
        t('perf.stepAudioDecode'),
        () => decodeToMono16k(blob),
        {
          input: inputSize,
          _fromResult: (data) => ({ output: data.byteLength, audioPcm: data.byteLength }),
        },
      );
    } catch (err) {
      throw new Error('Could not decode this audio file. ' + (err.message || ''));
    }
    lastWhisperReadyMetrics = null;
    await measureStep(metricsRun, 'whisperModelLoad', t('perf.stepWhisperLoad'), () => ensureModelLoaded());
    patchWhisperLoadStep(metricsRun);
  } else {
    try {
      audioData = await decodeToMono16k(blob);
    } catch (err) {
      throw new Error('Could not decode this audio file. ' + (err.message || ''));
    }
    await ensureModelLoaded();
  }

  const workerResult = await transcribeInWorker(audioData, language, onPartialTarget);
  const { text, chunks, metrics: wm } = workerResult;
  if (metricsRun) {
    recordStep(metricsRun, 'whisperTranscribe', t('perf.stepWhisperTranscribe'), {
      durationMs: wm?.durationMs,
      spaceBytes: {
        audioPcm: wm?.audioPcm,
        audioDurationSec: wm?.audioSamples ? wm.audioSamples / 16000 : undefined,
        transcriptUtf8: wm?.transcriptUtf8 ?? utf8ByteLength(text),
      },
      memory: wm?.memory,
    });
    const segments = splitIntoSegments(text, chunks);
    recordStep(metricsRun, 'segmentSplit', t('perf.stepSegmentSplit'), {
      durationMs: 0,
      spaceBytes: { segmentCount: segments.length, transcriptUtf8: utf8ByteLength(text) },
      memory: { available: false, heapUsedBefore: null, heapUsedAfter: null, heapDelta: null },
    });
  }

  if (currentDraftId) {
    const raw = { text, segments: splitIntoSegments(text, chunks), modelId: modelSelect.value };
    await db.updateTranscript(currentDraftId, {
      text,
      raw,
      language: language || 'auto',
      transcription: { complete: true, monolithic: true, chunks: chunks || [] },
    });
  }
  return { text, chunks };
}

async function runSegmentedTranscription(onPartialTarget, metricsRun) {
  if (!currentRecordingSessionId) throw new Error('No recording session');
  const language = languageSelect.value || null;
  const modelId = modelSelect.value;

  if (!currentDraftId) {
    const draft = await transcribeSegments.createDraftForSession(currentRecordingSessionId, { language, modelId });
    currentDraftId = draft.id;
    loadSavedList();
  }

  lastWhisperReadyMetrics = null;
  const updated = await transcribeSegments.transcribeRecordingSession(
    currentRecordingSessionId,
    currentDraftId,
    {
      language,
      modelId,
      ensureModelLoaded,
      transcribeInWorker,
      metricsRun,
      onWhisperLoad: () => patchWhisperLoadStep(metricsRun),
      onProgress: ({ segment, totalSegments, message }) => {
        setLoading(message);
        setTranscribeProgress(segment, totalSegments);
      },
      onPartial: onPartialTarget,
      persistPartial: (patch) => persistDraftPartial(patch),
      isCancelled: () => !auth.isUnlocked(),
    },
  );

  currentDraftId = updated.id;
  return { text: updated.text, chunks: updated.transcription?.chunks || [] };
}

// --- Transcription flow ---
async function runTranscription(blob, onPartialTarget) {
  const metricsRun = createMetricsRun({
    phase: 'transcription',
    meta: { modelId: modelSelect.value, language: languageSelect.value || 'auto' },
  });
  let result;
  if (currentRecordingSessionId) {
    result = await runSegmentedTranscription(onPartialTarget, metricsRun);
  } else {
    result = await runMonolithicTranscription(blob, onPartialTarget, metricsRun);
  }
  finalizeRun(metricsRun);
  currentMetrics = mergeMetrics(currentMetrics, 'transcription', metricsRun);
  if (pipeline) pipeline.metrics = currentMetrics;
  renderPerfPanel();
  await persistMetricsNow();
  return result;
}

transcribeBtn.addEventListener('click', async () => {
  if ((!currentAudioBlob && !currentRecordingSessionId) || isTranscribing) return;
  isTranscribing = true;
  transcribeBtn.disabled = true;
  updateBeforeUnload();
  setLoading(t('status.preparing'));
  try {
    const { text, chunks } = await runTranscription(currentAudioBlob, (partial) => {
      if (!auth.isUnlocked()) return;
      resultEl.textContent = partial;
      resultEl.className = 'loading';
      if (currentDraftId) {
        persistDraftPartial({ text: partial });
      }
    });
    if (!auth.isUnlocked()) return;
    currentChunks = chunks || [];
    setResult(text);
    updateBeforeUnload();
  } catch (err) {
    if (!auth.isUnlocked()) return;
    if (currentDraftId) {
      try {
        const draft = await db.getTranscript(currentDraftId);
        if (draft?.text) {
          setResult(draft.text);
          showToast(t('toast.transcriptionStopped', { error: err.message }), 6000);
          loadSavedList();
          return;
        }
      } catch (_) { /* fall through */ }
    }
    setResult(t('status.transcriptionFailed', { error: err.message }), true);
  } finally {
    isTranscribing = false;
    transcribeBtn.disabled = false;
    setTranscribeProgress(0, 0);
    updateBeforeUnload();
  }
});

// --- Recording ---
const MAX_RECORDING_MS = 3 * 60 * 60 * 1000;
let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingChunkIndex = 0;
let recordingMimeType = 'audio/webm';
let recordingTimerInterval = null;
let recordingLimitInterval = null;
let recordingStartTime = 0;
let recordingPausedDuration = 0;
let recordingPausedAt = null;

pauseRecordBtn.addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') {
    try {
      mediaRecorder.pause();
      recordingPausedAt = Date.now();
      recordingIndicator.classList.add('paused');
      recordingPausedEl.classList.remove('hidden');
      pauseRecordBtn.textContent = t('transcribe.resume');
    } catch (_) { /* pause not supported */ }
  } else if (mediaRecorder.state === 'paused') {
    try {
      mediaRecorder.resume();
      recordingPausedDuration += Date.now() - recordingPausedAt;
      recordingPausedAt = null;
      recordingIndicator.classList.remove('paused');
      recordingPausedEl.classList.add('hidden');
      pauseRecordBtn.textContent = t('transcribe.pause');
    } catch (_) { /* resume not supported */ }
  }
});

recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
    mediaRecorder.stop();
    return;
  }
  try {
    const active = await recordingSession.getActiveSession();
    if (active && active.chunkCount > 0) {
      const discard = window.confirm(t('confirm.discardRecording'));
      if (!discard) return;
      await recordingSession.abandonSession(active.id);
      hideRecoveryBanner();
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStream = stream;
    recordingMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    recordedSection.classList.add('hidden');
    currentAudioBlob = null;
    currentDraftId = null;
    recordingChunks = [];
    recordingChunkIndex = 0;

    const sessionId = await recordingSession.createSession(recordingMimeType);
    currentRecordingSessionId = sessionId;

    mediaRecorder = recordingMimeType ? new MediaRecorder(stream, { mimeType: recordingMimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      recordingChunks.push(e.data);
      const idx = recordingChunkIndex++;
      recordingSession.appendChunk(sessionId, idx, e.data).catch((err) => {
        showToast(t('toast.chunkSaveFailed', { error: err.message }));
      });
    };

    mediaRecorder.onstop = async () => {
      recordingStream?.getTracks().forEach(t => t.stop());
      recordingStream = null;
      recordBtn.textContent = t('transcribe.record');
      recordBtn.classList.remove('stop');
      if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
      if (recordingLimitInterval) { clearInterval(recordingLimitInterval); recordingLimitInterval = null; }
      recordingIndicator.classList.remove('visible');
      pauseRecordBtn.style.display = 'none';
      updateBeforeUnload();

      if (!recordingChunks.length && !recordingChunkIndex) {
        if (currentRecordingSessionId) await recordingSession.abandonSession(currentRecordingSessionId);
        currentRecordingSessionId = null;
        setResult(t('status.recordingNoAudio'), true);
        return;
      }

      try {
        if (currentRecordingSessionId) await recordingSession.completeSession(currentRecordingSessionId);
        const { blob } = await recordingSession.assembleSessionBlob(currentRecordingSessionId);
        recordingChunks = [];
        setCurrentAudio(blob, { sessionId: currentRecordingSessionId });
        if (!currentDraftId && currentRecordingSessionId) {
          try {
            const draft = await transcribeSegments.createDraftForSession(currentRecordingSessionId, {
              language: languageSelect.value || 'auto',
              modelId: modelSelect.value,
            });
            currentDraftId = draft.id;
            loadSavedList();
          } catch (_) { /* draft is optional; recovery banner still works */ }
        }
        setResult(t('status.listenThenTranscribe'));
      } catch (e) {
        const blob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
        recordingChunks = [];
        setCurrentAudio(blob, { sessionId: currentRecordingSessionId });
        setResult(t('status.listenThenTranscribe'));
        showToast(t('toast.recordingInMemory'));
      }
    };

    mediaRecorder.onerror = (e) => {
      setResult(t('status.recordingError', { error: e.error?.message || 'unknown' }), true);
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    };

    mediaRecorder.start(recordingSession.CHUNK_TIMESLICE_MS);
    recordBtn.textContent = t('transcribe.stop');
    recordBtn.classList.add('stop');
    updateBeforeUnload();

    recordingStartTime = Date.now();
    recordingPausedDuration = 0;
    recordingPausedAt = null;
    recordingIndicator.classList.remove('paused');
    recordingPausedEl.classList.add('hidden');
    recordingTimeEl.textContent = '0:00';
    recordingIndicator.classList.add('visible');
    if (typeof mediaRecorder.pause === 'function') {
      pauseRecordBtn.style.display = '';
      pauseRecordBtn.textContent = t('transcribe.pause');
    }
    recordingTimerInterval = setInterval(() => {
      let elapsed = Date.now() - recordingStartTime - recordingPausedDuration;
      if (recordingPausedAt) elapsed -= Date.now() - recordingPausedAt;
      recordingTimeEl.textContent = formatDuration(Math.max(0, elapsed));
    }, 1000);

    const limitStart = Date.now();
    recordingLimitInterval = setInterval(() => {
      if (Date.now() - limitStart >= MAX_RECORDING_MS) {
        clearInterval(recordingLimitInterval);
        recordingLimitInterval = null;
        if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
          mediaRecorder.stop();
          showToast(t('toast.recordingLimit'));
        }
      }
    }, 30000);
  } catch (e) {
    setResult(t('status.microphoneError', { error: e.message }), true);
  }
});

// --- Upload ---
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  currentRecordingSessionId = null;
  currentDraftId = null;
  setCurrentAudio(file, { sessionId: null });
  setResult(t('status.savingUpload'));
  try {
    const recordingId = crypto.randomUUID() + '.audio';
    await db.saveRecording(recordingId, file, file.type);
    const draft = await transcribeSegments.createAudioOnlyDraft(recordingId, {
      language: languageSelect.value,
      mimeType: file.type,
    });
    currentDraftId = draft.id;
    loadSavedList();
    setResult(t('status.listenThenTranscribe'));
    updateBeforeUnload();
  } catch (e) {
    setResult(t('status.listenThenTranscribe'));
    showToast(t('toast.uploadPersistFailed', { error: e.message }));
  }
  fileInput.value = '';
});

// --- Save / download current transcript ---
saveBtn.addEventListener('click', async () => {
  const text = currentTranscriptText.trim();
  if (!text) return;
  const title = (window.prompt(t('prompt.saveTitle'), '') || '').trim() || t('saved.untitled');
  try {
    const id = currentDraftId || crypto.randomUUID();
    const raw = (pipeline && pipeline.id === null && pipeline.raw)
      ? pipeline.raw
      : { text, segments: splitIntoSegments(text, currentChunks), modelId: modelSelect.value };
    const entry = {
      id,
      title,
      text,
      language: languageSelect.value || 'auto',
      createdAt: new Date().toISOString(),
      status: 'saved',
      raw,
    };
    if (currentRecordingSessionId) {
      entry.recordingSessionId = currentRecordingSessionId;
    }
    if (currentAudioBlob) {
      const recordingId = entry.recordingId || (id + '.audio');
      await db.saveRecording(recordingId, currentAudioBlob, currentAudioBlob.type);
      entry.recordingId = recordingId;
    }
    if (pipeline && pipeline.id === null) {
      entry.correction = pipeline.correction;
      entry.annotations = pipeline.annotations;
      entry.edits = pipeline.edits;
      entry.ruleApplications = pipeline.ruleApplications;
      entry.finalTranscript = pipeline.finalTranscript;
      entry.editLog = pipeline.editLog;
      entry.form = pipeline.form;
      entry.metrics = pipeline.metrics || currentMetrics;
    } else if (currentMetrics) {
      entry.metrics = currentMetrics;
    }
    if (currentDraftId) {
      const existing = await db.getTranscript(id);
      entry.createdAt = existing?.createdAt || entry.createdAt;
      await db.updateTranscript(id, entry);
    } else {
      await db.saveTranscript(entry);
    }
    if (pipeline && pipeline.id === null) { pipeline.id = id; pipeline.title = title; }
    currentDraftId = id;
    showToast(t('toast.savedAs', { title }));
    loadSavedList();
    updateBeforeUnload();
  } catch (e) {
    showToast(t('toast.saveFailed', { error: e.message }));
  }
});

downloadBtn.addEventListener('click', () => {
  downloadAsTxt(buildTranscriptExportText(pipeline, currentTranscriptText), 'transcript.txt');
});

// --- Saved transcripts list ---
function renderSavedList(items) {
  if (!items || items.length === 0) {
    savedListEl.innerHTML = '<li class="empty-state">' + escapeHtml(t('saved.empty')) + '</li>';
    return;
  }
  savedListEl.innerHTML = items.map(item => {
    const isDraft = item.status === 'draft';
    const tr = item.transcription || {};
    let draftMeta = '';
    if (isDraft && tr.totalSegments && !tr.monolithic) {
      draftMeta = ` <span class="item-date">${t('saved.segments', { done: tr.completedSegments || 0, total: tr.totalSegments })}</span>`;
    } else if (isDraft && tr.monolithic && !tr.complete) {
      draftMeta = ` <span class="item-date">${t('saved.transcribing')}</span>`;
    }
    const untitled = t('saved.untitled');
    const draftLabel = t('saved.draft');
    return `
    <li data-id="${item.id}">
      <span class="item-title" title="${escapeHtml(item.title || untitled)}">${escapeHtml(item.title || untitled)}${isDraft ? `<span class="badge draft">${draftLabel}</span>` : ''}${draftMeta}</span>
      <span class="item-date">${formatDate(item.createdAt)}</span>
      <span class="item-actions">
        <button type="button" class="open-btn">${t('saved.open')}</button>
        <button type="button" class="danger delete-btn">${t('saved.delete')}</button>
      </span>
    </li>`;
  }).join('');
  savedListEl.querySelectorAll('.open-btn').forEach(btn => {
    btn.addEventListener('click', () => openTranscript(btn.closest('li').dataset.id));
  });
  savedListEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => removeTranscript(btn.closest('li').dataset.id));
  });
}

async function loadSavedList() {
  try {
    const items = await db.listTranscripts();
    renderSavedList(items);
  } catch (e) {
    savedListEl.innerHTML = '<li class="empty-state error">' + escapeHtml(t('saved.loadFailed')) + '</li>';
  }
}

function exitEditMode() {
  detailEditArea.classList.add('hidden');
  detailContent.classList.remove('hidden');
  detailSaveEditBtn.style.display = 'none';
  detailCancelEditBtn.style.display = 'none';
  detailEditBtn.style.display = '';
}

async function openTranscript(id) {
  try {
    const entry = await db.getTranscript(id);
    if (!entry) throw new Error('Not found');
    if (entry.status === 'draft') {
      await restoreDraftWorkspace(id);
      if (transcribeSegments.isTranscriptionIncomplete(entry)) {
        showToast(t('toast.draftRestoredResume'));
      }
      return;
    }
    currentDetailTranscript = entry;
    exitEditMode();
    detailTitle.textContent = entry.title || t('saved.untitled');
    detailContent.textContent = entry.text || '';
    if (detailAudioObjectUrl) { URL.revokeObjectURL(detailAudioObjectUrl); detailAudioObjectUrl = null; }
    if (entry.recordingId) {
      const rec = await db.getRecording(entry.recordingId);
      if (rec && rec.blob) {
        detailAudioObjectUrl = URL.createObjectURL(rec.blob);
        detailRecordingSection.classList.remove('hidden');
        detailAudio.src = detailAudioObjectUrl;
        detailDownloadAudioLink.href = detailAudioObjectUrl;
        const ext = (rec.mimeType || '').includes('webm') ? '.webm' : '';
        detailDownloadAudioLink.download = (entry.title || 'recording').replace(/\s+/g, '_') + (ext || '.audio');
      } else {
        detailRecordingSection.classList.add('hidden');
      }
    } else if (entry.recordingSessionId) {
      try {
        const { blob, mimeType } = await recordingSession.assembleSessionBlob(entry.recordingSessionId);
        detailAudioObjectUrl = URL.createObjectURL(blob);
        detailRecordingSection.classList.remove('hidden');
        detailAudio.src = detailAudioObjectUrl;
        detailDownloadAudioLink.href = detailAudioObjectUrl;
        const ext = (mimeType || '').includes('webm') ? '.webm' : '';
        detailDownloadAudioLink.download = (entry.title || 'recording').replace(/\s+/g, '_') + (ext || '.audio');
      } catch (_) {
        detailRecordingSection.classList.add('hidden');
      }
    } else {
      detailRecordingSection.classList.add('hidden');
      detailAudio.src = '';
      detailDownloadAudioLink.href = '#';
    }
    // Restore any saved review/form pipeline so the clinician can continue.
    if (entry.correction || entry.form) {
      loadPipelineFromEntry(entry);
    } else {
      resetPipelineUI();
      currentMetrics = entry.metrics || null;
      renderPerfPanel(entry.metrics);
      renderDetailPerfPanel(entry.metrics);
    }
    detailPanel.classList.remove('hidden');
    updateBusyButtons();
  } catch (e) {
    showToast(t('toast.openFailed'));
  }
}

async function removeTranscript(id) {
  try {
    await db.deleteTranscript(id);
    showToast(t('toast.deleted'));
    if (currentDetailTranscript && currentDetailTranscript.id === id) {
      detailPanel.classList.add('hidden');
      currentDetailTranscript = null;
    }
    if (pipeline && pipeline.id === id) resetPipelineUI();
    loadSavedList();
  } catch (e) {
    showToast(t('toast.deleteFailed'));
  }
}

backToListBtn.addEventListener('click', () => {
  detailPanel.classList.add('hidden');
  currentDetailTranscript = null;
  exitEditMode();
  updateBusyButtons();
});

// --- Detail: edit / rename / download ---
detailEditBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  detailEditArea.value = currentDetailTranscript.text || '';
  detailEditArea.classList.remove('hidden');
  detailContent.classList.add('hidden');
  detailSaveEditBtn.style.display = '';
  detailCancelEditBtn.style.display = '';
  detailEditBtn.style.display = 'none';
});

detailCancelEditBtn.addEventListener('click', exitEditMode);

detailSaveEditBtn.addEventListener('click', async () => {
  if (!currentDetailTranscript) return;
  try {
    const updated = await db.updateTranscript(currentDetailTranscript.id, { text: detailEditArea.value });
    currentDetailTranscript = updated;
    detailContent.textContent = updated.text || '';
    exitEditMode();
    showToast(t('toast.changesSaved'));
  } catch (e) {
    showToast(t('toast.changesSaveFailed'));
  }
});

detailRenameBtn.addEventListener('click', async () => {
  if (!currentDetailTranscript) return;
  const newTitle = (window.prompt(t('prompt.renameTitle'), currentDetailTranscript.title || t('saved.untitled')) || '').trim();
  if (!newTitle) return;
  try {
    const updated = await db.updateTranscript(currentDetailTranscript.id, { title: newTitle });
    currentDetailTranscript = updated;
    detailTitle.textContent = newTitle;
    showToast(t('toast.renamed'));
    loadSavedList();
  } catch (e) {
    showToast(t('toast.renameFailed'));
  }
});

detailDownloadBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  const entry = currentDetailTranscript;
  const text = (pipeline && pipeline.id === entry.id)
    ? buildTranscriptExportText(pipeline, entry.text || '')
    : buildTranscriptExportText(entry, entry.text || '');
  downloadAsTxt(text, (entry.title || 'transcript').replace(/\s+/g, '_') + '.txt');
});

// --- Detail: re-transcribe with currently selected model/language ---
detailRetranscribeBtn.addEventListener('click', async () => {
  if (!currentDetailTranscript || !currentDetailTranscript.recordingId || isTranscribing) return;
  const rec = await db.getRecording(currentDetailTranscript.recordingId);
  if (!rec || !rec.blob) { showToast(t('toast.recordingNotFound')); return; }
  isTranscribing = true;
  detailRetranscribeBtn.disabled = true;
  const originalText = currentDetailTranscript.text || '';
  detailContent.textContent = t('status.retranscribing');
  try {
    const metricsRun = createMetricsRun({
      phase: 'transcription',
      meta: { modelId: modelSelect.value, retranscribe: true },
    });
    const { text, chunks } = await runMonolithicTranscription(rec.blob, (partial) => {
      if (!auth.isUnlocked()) return;
      detailContent.textContent = partial;
    }, metricsRun);
    if (!auth.isUnlocked()) return;
    finalizeRun(metricsRun);
    currentMetrics = mergeMetrics(currentDetailTranscript.metrics, 'transcription', metricsRun);
    const raw = { text, segments: splitIntoSegments(text, chunks), modelId: modelSelect.value };
    const updated = await db.updateTranscript(currentDetailTranscript.id, {
      text, raw, correction: null, annotations: null, edits: null, finalTranscript: null, editLog: null, form: null,
      transcription: { complete: true, monolithic: true, started: true, chunks: chunks || [] },
      metrics: currentMetrics,
    });
    currentDetailTranscript = updated;
    detailContent.textContent = text;
    applyMetrics(currentMetrics);
    detailResumeTranscribeBtn.style.display = 'none';
    showToast(t('toast.retranscribeDone'));
  } catch (e) {
    if (!auth.isUnlocked()) return;
    detailContent.textContent = originalText;
    showToast(t('toast.retranscribeFailed', { error: e.message }));
  } finally {
    isTranscribing = false;
    detailRetranscribeBtn.disabled = false;
  }
});

async function resumeDraftTranscription(draftId) {
  const draft = await db.getTranscript(draftId);
  if (!draft || !transcribeSegments.isTranscriptionIncomplete(draft)) {
    showToast(t('toast.nothingToResume'));
    return;
  }
  currentDraftId = draft.id;
  currentRecordingSessionId = draft.recordingSessionId || null;
  currentChunks = draft.transcription?.chunks || [];
  if (draft.raw?.segments) {
    currentChunks = draft.transcription?.chunks || [];
  }
  setResult(draft.text || '');
  hideRecoveryBanner();

  try {
    if (currentRecordingSessionId) {
      const { blob } = await recordingSession.assembleSessionBlob(currentRecordingSessionId);
      setCurrentAudio(blob, { sessionId: currentRecordingSessionId });
    } else if (draft.recordingId) {
      const rec = await db.getRecording(draft.recordingId);
      if (rec?.blob) setCurrentAudio(rec.blob, { sessionId: null });
    }
  } catch (e) {
    showToast(t('toast.audioLoadFailed', { error: e.message }));
    return;
  }

  detailPanel.classList.add('hidden');
  isTranscribing = true;
  transcribeBtn.disabled = true;
  updateBeforeUnload();
  setLoading(t('status.resuming'));
  try {
    const { text, chunks } = await runTranscription(currentAudioBlob, (partial) => {
      if (!auth.isUnlocked()) return;
      resultEl.textContent = partial;
      resultEl.className = 'loading';
      persistDraftPartial({ text: partial });
    });
    if (!auth.isUnlocked()) return;
    currentChunks = chunks || [];
    setResult(text);
    loadSavedList();
  } catch (err) {
    if (!auth.isUnlocked()) return;
    if (draft.text) setResult(draft.text);
    showToast(t('toast.resumeFailed', { error: err.message }), 6000);
  } finally {
    isTranscribing = false;
    transcribeBtn.disabled = false;
    setTranscribeProgress(0, 0);
    updateBeforeUnload();
  }
}

detailResumeTranscribeBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  resumeDraftTranscription(currentDetailTranscript.id);
});

recoveryRecoverBtn.addEventListener('click', async () => {
  if (!pendingRecovery) return;
  try {
    if (pendingRecovery.type === 'recording') {
      await recoverRecordingSession(pendingRecovery.sessionId);
    } else if (pendingRecovery.draftId) {
      const draft = await restoreDraftWorkspace(pendingRecovery.draftId);
      if (pendingRecovery.resume && transcribeSegments.isTranscriptionIncomplete(draft)) {
        await resumeDraftTranscription(draft.id);
      }
    }
  } catch (e) {
    showToast(t('toast.recoveryFailed', { error: e.message }));
  }
});

recoveryDiscardBtn.addEventListener('click', async () => {
  if (!pendingRecovery) return;
  try {
    if (pendingRecovery.type === 'recording' && pendingRecovery.sessionId) {
      await recordingSession.abandonSession(pendingRecovery.sessionId);
      if (currentRecordingSessionId === pendingRecovery.sessionId) {
        currentRecordingSessionId = null;
      }
      showToast(t('toast.discardedRecording'));
    } else if (pendingRecovery.draftId) {
      await db.deleteTranscript(pendingRecovery.draftId);
      if (currentDraftId === pendingRecovery.draftId) currentDraftId = null;
      showToast(t('toast.discardedDraft'));
      loadSavedList();
    }
    hideRecoveryBanner();
    await checkRecovery();
  } catch (e) {
    showToast(t('toast.discardFailed', { error: e.message }));
  }
});

// --- Model select: invalidate readiness so next transcription loads the new model ---
modelSelect.addEventListener('change', () => {
  const modelId = modelSelect.value;
  if (modelReady && modelReady.modelId !== modelId) {
    modelStatus.textContent = t('engine.willSwitch', { model: shortModelName(modelId) });
  }
});

// =====================================================================
// Medical form filling (local LLM via Web-LLM, see js/llm-worker.js)
// =====================================================================

let templateFields = getDefaultTemplate().map(f => ({ ...f }));

// --- Template editor ---
const persistTemplate = debounce(() => {
  if (!auth.isUnlocked()) return;
  db.saveFormTemplate(templateFields).catch(() => showToast(t('toast.templateSaveFailed')));
}, 600);

function renderTemplateEditor() {
  templateFieldsEl.innerHTML = '';
  templateFields.forEach((field, i) => {
    const row = document.createElement('div');
    row.className = 'template-field-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'field-name';
    nameInput.placeholder = t('form.fieldName');
    nameInput.value = field.name;
    nameInput.addEventListener('input', () => { templateFields[i].name = nameInput.value; persistTemplate(); });

    const hintInput = document.createElement('input');
    hintInput.type = 'text';
    hintInput.className = 'field-hint';
    hintInput.placeholder = t('form.fieldHint');
    hintInput.value = field.hint || '';
    hintInput.addEventListener('input', () => { templateFields[i].hint = hintInput.value; persistTemplate(); });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = '✕';
    removeBtn.title = t('form.removeField');
    removeBtn.addEventListener('click', () => {
      templateFields.splice(i, 1);
      renderTemplateEditor();
      persistTemplate();
    });

    row.append(nameInput, hintInput, removeBtn);
    templateFieldsEl.appendChild(row);
  });
}

addFieldBtn.addEventListener('click', () => {
  templateFields.push({ name: '', hint: '' });
  renderTemplateEditor();
  templateFieldsEl.querySelector('.template-field-row:last-child .field-name')?.focus();
});

resetTemplateBtn.addEventListener('click', () => {
  templateFields = getDefaultTemplate().map(f => ({ ...f }));
  renderTemplateEditor();
  persistTemplate();
});

async function loadTemplate() {
  try {
    const saved = await db.getFormTemplate();
    if (Array.isArray(saved) && saved.length) {
      templateFields = saved.map(f => ({ name: String(f.name || ''), hint: String(f.hint || '') }));
    }
  } catch (_) { /* keep defaults */ }
  renderTemplateEditor();
}

function buildSchema() {
  const fields = templateFields.filter(f => f.name.trim());
  if (!fields.length) return null;
  const properties = {};
  const required = [];
  for (const f of fields) {
    const name = f.name.trim();
    if (properties[name]) continue; // skip duplicate names
    properties[name] = { type: 'string' };
    if (f.hint && f.hint.trim()) properties[name].description = f.hint.trim();
    required.push(name);
  }
  return { type: 'object', properties, required };
}

// --- LLM worker (lazy: created on first "Improve & review" click) ---
// One worker, one model instance, two tasks: 'correct' and 'extract'.
let llmWorker = null;
let llmModelReady = false;
const pendingLlm = new Map(); // id -> { resolve, reject }
let llmCounter = 0;

function setLlmProgress(text, progress) {
  llmStatus.textContent = text;
  if (typeof progress === 'number' && progress > 0 && progress < 1) {
    llmProgressWrap.classList.add('visible');
    llmProgressBar.style.width = Math.round(progress * 100) + '%';
  } else {
    llmProgressWrap.classList.remove('visible');
    llmProgressBar.style.width = '0%';
  }
}

function getLlmWorker() {
  if (llmWorker) return llmWorker;
  llmWorker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  llmWorker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'progress':
        setLlmProgress(msg.text || t('llm.loading'), msg.progress);
        break;
      case 'ready':
        llmModelReady = true;
        if (msg.metrics && activeLlmMetricsRun) {
          const hasLoad = activeLlmMetricsRun.steps.some((s) => s.id === 'llmModelLoad');
          if (!hasLoad) {
            recordStep(activeLlmMetricsRun, 'llmModelLoad', t('perf.stepLlmLoad'), {
              durationMs: msg.metrics.durationMs,
              memory: msg.metrics.memory,
            });
          }
        }
        setLlmProgress(t('llm.ready'));
        break;
      case 'complete': {
        const job = pendingLlm.get(msg.id);
        if (job) { pendingLlm.delete(msg.id); job.resolve(msg); }
        break;
      }
      case 'error': {
        const err = new Error(msg.message || 'Local assistant error');
        if (msg.id !== undefined && pendingLlm.has(msg.id)) {
          const job = pendingLlm.get(msg.id);
          pendingLlm.delete(msg.id);
          job.reject(err);
        } else {
          setLlmProgress(t('llm.error', { error: err.message }));
        }
        break;
      }
    }
  };
  llmWorker.onerror = (e) => {
    const err = new Error(e.message || 'Local assistant worker failed');
    setLlmProgress(t('llm.workerFailed', { error: err.message }));
    for (const [id, job] of pendingLlm) {
      job.reject(err);
      pendingLlm.delete(id);
    }
    llmWorker.terminate();
    llmWorker = null;
    llmModelReady = false;
  };
  return llmWorker;
}

function llmRequest(payload) {
  const id = ++llmCounter;
  return new Promise((resolve, reject) => {
    pendingLlm.set(id, { resolve, reject });
    getLlmWorker().postMessage({ ...payload, id });
  });
}

function correctInWorker(window, protectedTerms, knownTerms) {
  return llmRequest({ type: 'correct', window, protectedTerms, knownTerms });
}

function extractInWorker(transcript, segments, schema) {
  const { segments: filtered, filtered: wasFiltered } = filterSegmentsForExtract(segments, schema);
  return llmRequest({ type: 'extract', transcript, segments: filtered, schema }).then((m) => ({
    data: m.data,
    truncated: m.truncated || wasFiltered,
    metrics: m.metrics || null,
  }));
}

// =====================================================================
// Staged pipeline: raw -> correction -> review -> final -> form -> approve.
// =====================================================================

const reviewUI = createReviewUI(reviewRoot, {
  onChange: () => persistPipeline(),
  onProceed: () => runGenerateForm(),
  onNotify: (msg, ms) => showToast(msg, ms || 4000),
  onAddRule: async (rule) => {
    try {
      if (rule.scope === 'session') correctionMemory.addSessionRule(rule);
      else await correctionMemory.addPersistentRule(rule);

      if (pipeline?.correction && rule.mode !== 'protect') {
        const rules = await correctionMemory.getActiveRules({ specialty: null });
        const { applied, replacements } = correctionMemory.applyRulesToCorrectionPipeline(pipeline, rules);
        if (applied.length) {
          pipeline.ruleApplications = [...(pipeline.ruleApplications || []), ...applied];
        }
        reviewUI.render(pipeline);
        persistPipeline();
        if (replacements > 0) {
          showToast(t('toast.ruleApplied', { count: replacements }));
        } else {
          showToast(t('toast.ruleNoMatch'));
        }
      } else if (pipeline?.correction && rule.mode === 'protect') {
        showToast(t('toast.ruleProtectSaved'));
      } else {
        showToast(t('toast.ruleSaved'));
      }
    } catch (_) {
      showToast(t('toast.ruleSaveFailed'));
    }
  },
});

const formReviewUI = createFormReviewUI(formReviewRoot, {
  onChange: () => persistPipeline(),
  onApprove: () => { persistPipeline(); showToast(t('toast.formApproved')); },
  onExport: (p) => exportFinalForm(p),
});

const persistPipeline = debounce(() => {
  if (!auth.isUnlocked() || !pipeline) return;
  const id = pipeline.id || currentDraftId;
  if (!id) return;
  db.updateTranscript(id, {
    raw: pipeline.raw,
    correction: pipeline.correction,
    annotations: pipeline.annotations,
    edits: pipeline.edits,
    ruleApplications: pipeline.ruleApplications,
    finalTranscript: pipeline.finalTranscript,
    editLog: pipeline.editLog,
    form: pipeline.form,
    metrics: pipeline.metrics || currentMetrics,
  }).then((updated) => {
    if (currentDetailTranscript && currentDetailTranscript.id === updated.id) currentDetailTranscript = updated;
  }).catch(() => showToast(t('toast.reviewSaveFailed')));
}, 600);

function buildPipeline({ id = null, title = '', language, text, segments, metrics = null }) {
  return {
    id, title, language,
    raw: { text, segments, modelId: modelSelect.value },
    correction: null, annotations: null, edits: {}, ruleApplications: [],
    finalTranscript: null, editLog: null, form: null,
    metrics: metrics || currentMetrics,
  };
}

function loadPipelineFromEntry(entry) {
  currentMetrics = entry.metrics || null;
  pipeline = {
    id: entry.id,
    title: entry.title || '',
    language: entry.language,
    raw: (entry.raw && Array.isArray(entry.raw.segments)) ? entry.raw : { text: entry.text || '', segments: splitIntoSegments(entry.text || '', []), modelId: entry.raw ? entry.raw.modelId : null },
    correction: entry.correction || null,
    annotations: entry.annotations || null,
    edits: entry.edits || {},
    ruleApplications: entry.ruleApplications || [],
    finalTranscript: entry.finalTranscript || null,
    editLog: entry.editLog || null,
    form: normalizePipelineForm(entry.form),
    metrics: entry.metrics || null,
  };
  if (pipeline.correction) {
    reviewPanel.classList.remove('hidden');
    reviewUI.render(pipeline);
  } else {
    reviewPanel.classList.add('hidden');
    reviewUI.clear();
  }
  if (pipeline.form) {
    formPanel.classList.remove('hidden');
    const n = (pipeline.form.fields && pipeline.form.fields.length) || 0;
    setFormPanelStatus('success', t('form.savedLoaded', { count: n }));
    formReviewUI.render(pipeline);
  } else {
    formPanel.classList.add('hidden');
    formReviewUI.clear();
    setFormPanelStatus('', '');
  }
  renderPerfPanel(pipeline.metrics);
  renderDetailPerfPanel(pipeline.metrics);
}

function resetPipelineUI() {
  pipeline = null;
  reviewUI.clear();
  formReviewUI.clear();
  reviewPanel.classList.add('hidden');
  formPanel.classList.add('hidden');
  setFormPanelStatus('', '');
}

function updateBusyButtons() {
  reviewBtn.disabled = !currentTranscriptText || !llmSupported || isExtracting;
  detailFillFormBtn.disabled = !llmSupported || isExtracting || !currentDetailTranscript;
  reviewUI.setProceedBusy(isExtracting, isExtracting ? t('review.generatingForm') : t('review.generateForm'));
}

function handleLlmError(err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  let statusMsg = t('llm.error', { error: msg });
  if (/no webgpu adapter|webgpu is not available/i.test(msg)) {
    statusMsg = t('llm.unavailable');
    llmSupported = false;
    llmUnavailableReason = statusMsg;
    updateBusyButtons();
  } else if (/memory|allocat|device.*lost|device.*hung|dxgi/i.test(msg)) {
    statusMsg += t('llm.memoryHint');
  } else if (/fetch|network|download/i.test(msg)) {
    statusMsg += t('llm.networkHint');
  }
  setLlmProgress(statusMsg);
  showToast(t('toast.aiStepFailed', { error: msg }));
}

function dedupeProtected(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = (p.term || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Step 2-3: local rules -> LLM correction -> uncertainty annotation -> review.
async function runCorrection() {
  if (!pipeline || isExtracting) return;
  if (!llmSupported) { showToast(t('llm.needsWebgpuShort')); return; }
  isExtracting = true;
  updateBusyButtons();
  formPanel.classList.add('hidden');
  formReviewUI.clear();
  if (!llmModelReady) setLlmProgress(t('llm.loadingFirst'));
  showToast(t('toast.improving'));

  const metricsRun = createMetricsRun({ phase: 'correction' });
  activeLlmMetricsRun = metricsRun;

  try {
    const rules = await correctionMemory.getActiveRules({ specialty: null });
    const ruleApplications = [];
    const protectedAll = [];
    const inputSegments = measureStepSync(metricsRun, 'localRules', t('perf.stepLocalRules'), () => {
      return pipeline.raw.segments.map((seg) => {
        const { text, applied, protectedTerms } = correctionMemory.applyLocalCorrectionRules(seg.text, rules);
        for (const a of applied) ruleApplications.push({ ...a, segment_id: seg.id, at: new Date().toISOString() });
        for (const p of protectedTerms) protectedAll.push(p);
        return { id: seg.id, text, asrConfidence: seg.asrConfidence };
      });
    }, {
      rulesApplied: 0,
      transcriptUtf8: utf8ByteLength(pipeline.raw.text),
    });
    const localStep = metricsRun.steps[metricsRun.steps.length - 1];
    if (localStep) localStep.spaceBytes.rulesApplied = ruleApplications.length;

    pipeline.ruleApplications = ruleApplications;
    const protectedTerms = dedupeProtected(protectedAll);
    const knownTerms = findKnownTerms(inputSegments.map((s) => s.text).join(' '));

    const windows = buildCorrectionWindows(inputSegments);
    const windowResults = [];
    for (let i = 0; i < windows.length; i++) {
      const label = windows.length > 1
        ? t('status.correctionPart', { current: i + 1, total: windows.length })
        : t('status.improving');
      setLlmProgress(label, windows.length > 1 ? i / windows.length : undefined);
      const msg = await correctInWorker(windows[i], protectedTerms, knownTerms);
      if (!auth.isUnlocked()) return;
      windowResults.push(msg.result);
      const stepLabel = windows.length > 1
        ? t('perf.stepLlmCorrectWindow', { current: i + 1, total: windows.length })
        : t('perf.stepLlmCorrect');
      recordStep(metricsRun, 'llmCorrect', stepLabel, {
        durationMs: msg.metrics?.durationMs,
        spaceBytes: msg.metrics?.spaceBytes || {},
        memory: msg.metrics?.memory,
        meta: { windowIndex: i + 1 },
      });
      if (windows.length > 1) {
        setLlmProgress(t('status.correctionPartDone', { current: i + 1, total: windows.length }), (i + 1) / windows.length);
      }
    }

    const mergeOutcome = measureStepSync(metricsRun, 'mergeAndAnnotate', t('perf.stepMergeAnnotate'), () => {
      const merged = mergeCorrectionResults(windows, windowResults, inputSegments);
      const extraConflicts = detectBoundaryConflicts(merged.segments, windows);
      const boundaryConflicts = [
        ...(merged.boundaryConflicts || []),
        ...extraConflicts,
      ];
      const result = {
        corrected_transcript: merged.corrected_transcript,
        segments: merged.segments,
        global_warnings: merged.global_warnings,
      };
      const annotations = annotateTranscriptUncertainty(inputSegments, result.segments);
      return { result, boundaryConflicts, annotations };
    }, {
      transcriptUtf8: utf8ByteLength(windowResults.map((r) => r.corrected_transcript || '').join(' ')),
    });

    const { result, boundaryConflicts, annotations } = mergeOutcome;
    if (!auth.isUnlocked()) return;

    pipeline.correction = {
      correctedText: result.corrected_transcript,
      segments: result.segments,
      globalWarnings: result.global_warnings,
      boundaryConflicts,
      correctionMeta: {
        windowCount: windows.length,
        chunked: windows.length > 1,
      },
    };
    pipeline.annotations = annotations;
    pipeline.edits = {};
    pipeline.finalTranscript = null;
    pipeline.editLog = null;
    pipeline.form = null;

    finalizeRun(metricsRun);
    currentMetrics = mergeMetrics(pipeline.metrics || currentMetrics, 'correction', metricsRun);
    pipeline.metrics = currentMetrics;
    applyMetrics(currentMetrics);

    reviewPanel.classList.remove('hidden');
    reviewUI.render(pipeline);
    reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    persistPipeline();
    setLlmProgress(t('llm.ready'));
    showToast(t('toast.improved'));
  } catch (err) {
    if (!auth.isUnlocked()) return;
    handleLlmError(err);
  } finally {
    activeLlmMetricsRun = null;
    isExtracting = false;
    updateBusyButtons();
  }
}

// Step 7-8: build final reviewed transcript, then fill the form from it only.
async function runGenerateForm() {
  if (!pipeline || !pipeline.correction) return;
  if (isExtracting) {
    showToast(t('form.inProgress'), 3000);
    return;
  }
  try {
    assertFormGenerationAllowed(pipeline.annotations);
  } catch (e) {
    showToast(e.message, 5000);
    return;
  }
  const schema = buildSchema();
  if (!schema) { showToast(t('form.needsField'), 5000); return; }

  isExtracting = true;
  updateBusyButtons();

  const metricsRun = createMetricsRun({ phase: 'form' });
  activeLlmMetricsRun = metricsRun;

  const final = measureStepSync(metricsRun, 'buildFinalTranscript', t('perf.stepBuildFinal'), () => {
    return generateFinalReviewedTranscript(pipeline.correction.segments, pipeline.edits);
  }, {
    transcriptUtf8: utf8ByteLength(
      pipeline.correction.segments.map((s) => s.corrected_text || s.text || '').join(' '),
    ),
  });
  pipeline.finalTranscript = final;
  pipeline.editLog = buildEditLog(pipeline.correction.segments, pipeline.edits, pipeline.ruleApplications);

  formPanel.classList.remove('hidden');
  setFormPanelStatus('loading', t('form.loading'));
  formReviewUI.showLoading(t('form.extracting'));
  if (!llmModelReady) setLlmProgress(t('llm.loading'));

  try {
    const { data, truncated, metrics: extractMetrics } = await extractInWorker(final.text, final.segments, schema);
    recordStep(metricsRun, 'llmExtract', t('perf.stepLlmExtract'), {
      durationMs: extractMetrics?.durationMs,
      spaceBytes: extractMetrics?.spaceBytes || {},
      memory: extractMetrics?.memory,
    });
    if (!auth.isUnlocked()) return;
    pipeline.form = {
      fields: data.fields,
      missingFields: data.missing_fields,
      overallWarnings: data.overall_warnings,
      approvedAt: null,
    };

    finalizeRun(metricsRun);
    currentMetrics = mergeMetrics(pipeline.metrics || currentMetrics, 'form', metricsRun);
    pipeline.metrics = currentMetrics;
    applyMetrics(currentMetrics);

    formReviewUI.render(pipeline);
    const filledCount = data.fields.filter((f) => f.value && f.value !== 'niet vermeld').length;
    setFormPanelStatus(
      'success',
      t('form.filledSuccess', { filled: filledCount, total: data.fields.length }),
    );
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    persistPipeline();
    if (truncated) showToast(t('form.truncated'), 6000);
    setLlmProgress(t('llm.ready'));
    showToast(t('form.filledToast'), 7000);
  } catch (err) {
    if (!auth.isUnlocked()) return;
    const errMsg = err.message || 'unknown error';
    setFormPanelStatus('error', t('form.fillFailed', { error: errMsg }));
    formReviewUI.showError(t('form.fillFailedShort', { error: errMsg }));
    handleLlmError(err);
  } finally {
    activeLlmMetricsRun = null;
    isExtracting = false;
    updateBusyButtons();
  }
}

// --- Export text helpers ---
function formAsTextStructured(form) {
  const normalized = normalizePipelineForm(form);
  if (!normalized || !normalized.fields.length) return '';
  return normalized.fields
    .map((f) => `${f.field_name}:\n${f.value || '—'}${f.needs_review ? t('export.needsReview') : ''}`)
    .join('\n\n');
}

function buildTranscriptExportText(p, fallbackText) {
  if (!p) return fallbackText || '';
  const parts = [];
  const raw = (p.raw && p.raw.text) || fallbackText || '';
  parts.push(t('export.rawHeader') + '\n' + raw);
  if (p.finalTranscript && p.finalTranscript.text) {
    parts.push(t('export.finalHeader') + '\n' + p.finalTranscript.text);
  } else if (p.correction && p.correction.correctedText) {
    parts.push(t('export.correctedHeader') + '\n' + p.correction.correctedText);
  }
  const formText = formAsTextStructured(p.form);
  if (formText) {
    parts.push(t('export.formHeader') + '\n' + formText);
  }
  return parts.join('\n\n');
}

// --- Entry points: start review from the current or a saved transcript ---
reviewBtn.addEventListener('click', () => {
  const text = currentTranscriptText.trim();
  if (!text) { showToast(t('toast.transcriptEmpty')); return; }
  pipeline = buildPipeline({
    id: null,
    title: '',
    language: languageSelect.value || 'auto',
    text,
    segments: splitIntoSegments(text, currentChunks),
  });
  runCorrection();
});

detailFillFormBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  const entry = currentDetailTranscript;
  if (pipeline && pipeline.id === entry.id && pipeline.correction) {
    // Already loaded with a correction: re-run to refresh.
    runCorrection();
    return;
  }
  loadPipelineFromEntry(entry);
  if (!pipeline.correction) runCorrection();
});

function initLlmSupport() {
  reviewBtn.disabled = true;
  detailFillFormBtn.disabled = true;
  if (llmSupported) {
    reviewBtn.title = '';
    detailFillFormBtn.title = '';
    return;
  }
  const reason = llmUnavailableReason || t('llm.needsWebgpu');
  reviewBtn.title = reason;
  detailFillFormBtn.title = reason;
  llmStatus.textContent = reason + t('llm.stillWorks');
}

async function probeWebGpu() {
  llmStatus.textContent = t('llm.checking');
  const { available, reason } = await probeWebGpuAvailable();
  llmSupported = available;
  llmUnavailableReason = reason || '';
  if (llmSupported) {
    llmStatus.textContent = t('llm.status');
  } else {
    initLlmSupport();
  }
  updateBusyButtons();
}

// Ask the browser to protect this site's storage (cached models, saved
// transcripts) from automatic eviction under disk pressure. Best-effort:
// browsers may decline silently, and the user can still clear site data.
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    const alreadyPersisted = await navigator.storage.persisted();
    if (alreadyPersisted) return;
    const granted = await navigator.storage.persist();
    console.log(granted
      ? 'Persistent storage granted: cached models will not be auto-evicted.'
      : 'Persistent storage declined: storage remains best-effort.');
  } catch (_) {
    // Not critical; ignore.
  }
}

// =====================================================================
// Login / lock (see js/auth.js). All patient data in IndexedDB is
// encrypted with a key derived from the password; locking drops the key
// and wipes decrypted data from the screen and memory.
// =====================================================================

function isAppBusy() {
  if (isTranscribing || isExtracting) return true;
  if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) return true;
  if (currentAudioBlob || currentRecordingSessionId || currentDraftId) return true;
  if (currentTranscriptText && currentTranscriptText.trim()) return true;
  return false;
}

async function prepareForLock() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  const sessionId = currentRecordingSessionId;
  if (typeof mediaRecorder.requestData === 'function') {
    try { mediaRecorder.requestData(); } catch (_) {}
  }
  await new Promise((resolve) => {
    const mr = mediaRecorder;
    const prevOnStop = mr.onstop;
    mr.onstop = async (ev) => {
      try { if (typeof prevOnStop === 'function') await prevOnStop.call(mr, ev); } catch (_) {}
      resolve();
    };
    try { mr.stop(); } catch (_) { resolve(); }
    setTimeout(resolve, 8000);
  });
  if (sessionId) await recordingSession.waitForPendingChunks(sessionId);
}

function cleanupRecordingUI() {
  mediaRecorder = null;
  recordingStream?.getTracks().forEach(t => t.stop());
  recordingStream = null;
  recordingChunks = [];
  recordingChunkIndex = 0;
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
  if (recordingLimitInterval) { clearInterval(recordingLimitInterval); recordingLimitInterval = null; }
  recordBtn.textContent = t('transcribe.record');
  recordBtn.classList.remove('stop');
  recordingIndicator.classList.remove('visible');
  pauseRecordBtn.style.display = 'none';
}

function handleLocked() {
  cleanupRecordingUI();

  // Current (unsaved) transcript + audio
  currentTranscriptText = '';
  currentChunks = [];
  currentRecordingSessionId = null;
  currentDraftId = null;
  resultEl.textContent = t('transcribe.empty');
  resultEl.className = '';
  saveBtn.disabled = true;
  downloadBtn.disabled = true;
  reviewBtn.disabled = true;
  if (currentAudioObjectUrl) { URL.revokeObjectURL(currentAudioObjectUrl); currentAudioObjectUrl = null; }
  currentAudioBlob = null;
  recordedAudio.src = '';
  recordedSection.classList.add('hidden');

  // Detail view
  if (detailAudioObjectUrl) { URL.revokeObjectURL(detailAudioObjectUrl); detailAudioObjectUrl = null; }
  detailAudio.src = '';
  detailDownloadAudioLink.href = '#';
  currentDetailTranscript = null;
  detailPanel.classList.add('hidden');
  detailContent.textContent = '';
  detailEditArea.value = '';
  detailTitle.textContent = '—';
  exitEditMode();

  // Saved list, pipeline (review + form), local session rules, and template
  savedListEl.innerHTML = '<li class="empty-state">' + escapeHtml(t('saved.locked')) + '</li>';
  resetPipelineUI();
  correctionMemory.clearSessionRules();
  templateFields = getDefaultTemplate().map(f => ({ ...f }));
  templateFieldsEl.innerHTML = '';

  // Back to the login screen
  lockBtn.style.display = 'none';
  loginError.textContent = '';
  loginPassword.value = '';
  loginOverlay.classList.remove('hidden');
  loginUsername.focus();
}

async function onUnlocked() {
  loginOverlay.classList.add('hidden');
  lockBtn.style.display = '';
  try {
    const migrated = await db.migrateLegacyData();
    if (migrated > 0) showToast(t('toast.migrated', { count: migrated }));
  } catch (e) {
    console.warn('Legacy data migration failed', e);
  }
  loadTemplate();
  loadSavedList();
  probeWebGpu();
  await checkRecovery();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = loginUsername.value;
  const password = loginPassword.value;
  if (!username.trim() || !password) return;
  loginSubmitBtn.disabled = true;
  loginError.textContent = '';
  loginSubmitBtn.textContent = t('login.checking');
  try {
    const ok = await auth.login(username, password);
    if (!ok) {
      loginError.textContent = t('login.denied');
      loginPassword.value = '';
      loginPassword.focus();
      return;
    }
    loginPassword.value = '';
    await onUnlocked();
  } catch (err) {
    loginError.textContent = t('login.failed', { error: err.message || 'unknown error' });
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = t('login.unlock');
  }
});

lockBtn.addEventListener('click', () => auth.lock());

auth.configureAutoLock({ onPrepareLock: prepareForLock, onLock: handleLocked, isBusy: isAppBusy });

function refreshDynamicUI() {
  applyStatic(document);
  if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
    recordBtn.textContent = t('transcribe.stop');
  } else {
    recordBtn.textContent = t('transcribe.record');
  }
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    pauseRecordBtn.textContent = t('transcribe.resume');
  } else if (pauseRecordBtn.style.display !== 'none') {
    pauseRecordBtn.textContent = t('transcribe.pause');
  }
  if (!currentTranscriptText && !isTranscribing && resultEl.className !== 'loading' && resultEl.className !== 'error') {
    resultEl.textContent = t('transcribe.empty');
  }
  if (pendingRecovery) showRecoveryBanner(pendingRecovery);
  renderTemplateEditor();
  if (auth.isUnlocked()) loadSavedList();
  if (pipeline?.correction) reviewUI.render(pipeline);
  else if (!pipeline) reviewUI.clear();
  if (pipeline?.form) formReviewUI.render(pipeline);
  else if (!formReviewRoot.querySelector('.tform-field')) {
    formReviewUI.clear();
  }
  if (!modelReady && !pendingLoad) {
    modelStatus.textContent = t('engine.notLoaded');
  }
  initLlmSupport();
  if (llmSupported && !isExtracting) llmStatus.textContent = llmModelReady ? t('llm.ready') : t('llm.status');
  updateBusyButtons();
  renderPerfPanel(pipeline?.metrics || currentMetrics);
  renderDetailPerfPanel(currentDetailTranscript?.metrics || pipeline?.metrics || currentMetrics);
}

langToggleBtn?.addEventListener('click', () => toggleLang());
onLangChange(() => refreshDynamicUI());

// --- Init ---
applyStatic(document);
document.documentElement.lang = getLang();
if (!modelReady) modelStatus.textContent = t('engine.notLoaded');
if ([...modelSelect.options].some(o => o.value === DEFAULT_MODEL)) {
  modelSelect.value = DEFAULT_MODEL;
}
languageSelect.value = DEFAULT_LANGUAGE;
probeWebGpu();
requestPersistentStorage();
loginUsername.focus();
