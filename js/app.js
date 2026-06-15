import * as db from './db.js';
import * as auth from './auth.js';
import { DEFAULT_MODEL, DEFAULT_LANGUAGE } from './config.js';
import { splitIntoSegments } from './segments.js';
import * as correctionMemory from './correction-memory.js';
import { findKnownTerms } from './clinical-lexicon.js';
import { annotateTranscriptUncertainty } from './uncertainty.js';
import { generateFinalReviewedTranscript, buildEditLog } from './final-transcript.js';
import { createReviewUI } from './review-ui.js';
import { createFormReviewUI, exportFinalForm, normalizePipelineForm } from './form-review-ui.js';
import { assertFormGenerationAllowed } from './safety.js';
import { probeWebGpuAvailable } from './webgpu-probe.js';

// --- DOM ---
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginError = document.getElementById('loginError');
const lockBtn = document.getElementById('lockBtn');
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

// --- State ---
let currentTranscriptText = '';
let currentAudioBlob = null;        // unsaved recording/upload kept in memory
let currentAudioObjectUrl = null;
let currentChunks = [];             // Whisper segment timestamps for the current transcript
let currentDetailTranscript = null;
let detailAudioObjectUrl = null;
let isTranscribing = false;
let isExtracting = false;           // true during correction OR form filling
let llmSupported = false;           // set by probeWebGpu() — needs a working adapter, not just navigator.gpu
let llmUnavailableReason = '';

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
      engineBadge.textContent = msg.device === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
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
        modelStatus.textContent = `Downloading model… ${pct}% (${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB)`;
      }
      break;
    }
    case 'ready': {
      modelReady = { modelId: msg.modelId };
      progressWrap.classList.remove('visible');
      progressBar.style.width = '0%';
      fileProgress.clear();
      modelStatus.textContent = `Model ready: ${shortModelName(msg.modelId)} (cached for offline use).`;
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
      if (job) { pendingJobs.delete(msg.id); job.resolve({ text: msg.text, chunks: msg.chunks || [] }); }
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
        modelStatus.textContent = 'Model failed to load: ' + err.message;
        pendingLoad.reject(err);
        pendingLoad = null;
      } else {
        showToast('Error: ' + err.message);
      }
      break;
    }
  }
};

worker.onerror = (e) => {
  modelStatus.textContent = 'Transcription engine failed to start: ' + (e.message || 'unknown error');
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
  modelStatus.textContent = `Loading ${shortModelName(modelId)}…`;
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

// --- Audio decoding (any format -> 16 kHz mono Float32Array) ---
async function decodeToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0).slice();
    }
    const out = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < audioBuffer.length; i++) out[i] += ch[i];
    }
    const n = audioBuffer.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] /= n;
    return out;
  } finally {
    ctx.close();
  }
}

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
  resultEl.textContent = message || 'Transcribing…';
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

function setCurrentAudio(blob) {
  currentAudioBlob = blob;
  if (currentAudioObjectUrl) URL.revokeObjectURL(currentAudioObjectUrl);
  currentAudioObjectUrl = URL.createObjectURL(blob);
  recordedAudio.src = currentAudioObjectUrl;
  recordedSection.classList.remove('hidden');
}

// --- Transcription flow ---
async function runTranscription(blob, onPartialTarget) {
  const language = languageSelect.value || null;
  let audioData;
  try {
    audioData = await decodeToMono16k(blob);
  } catch (err) {
    throw new Error('Could not decode this audio file. ' + (err.message || ''));
  }
  await ensureModelLoaded();
  return transcribeInWorker(audioData, language, onPartialTarget);
}

transcribeBtn.addEventListener('click', async () => {
  if (!currentAudioBlob || isTranscribing) return;
  isTranscribing = true;
  transcribeBtn.disabled = true;
  setLoading('Preparing audio…');
  try {
    const { text, chunks } = await runTranscription(currentAudioBlob, (partial) => {
      if (!auth.isUnlocked()) return;
      resultEl.textContent = partial;
      resultEl.className = 'loading';
    });
    if (!auth.isUnlocked()) return;
    currentChunks = chunks || [];
    setResult(text);
  } catch (err) {
    if (!auth.isUnlocked()) return;
    setResult('Transcription failed: ' + err.message, true);
  } finally {
    isTranscribing = false;
    transcribeBtn.disabled = false;
  }
});

// --- Recording ---
const MAX_RECORDING_MS = 3 * 60 * 60 * 1000;
let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
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
      pauseRecordBtn.textContent = 'Resume';
    } catch (_) { /* pause not supported */ }
  } else if (mediaRecorder.state === 'paused') {
    try {
      mediaRecorder.resume();
      recordingPausedDuration += Date.now() - recordingPausedAt;
      recordingPausedAt = null;
      recordingIndicator.classList.remove('paused');
      recordingPausedEl.classList.add('hidden');
      pauseRecordBtn.textContent = 'Pause';
    } catch (_) { /* resume not supported */ }
  }
});

recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStream = stream;
    recordingMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    recordedSection.classList.add('hidden');
    currentAudioBlob = null;
    recordingChunks = [];

    mediaRecorder = recordingMimeType ? new MediaRecorder(stream, { mimeType: recordingMimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordingChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      recordingStream?.getTracks().forEach(t => t.stop());
      recordingStream = null;
      recordBtn.textContent = 'Record';
      recordBtn.classList.remove('stop');
      window.onbeforeunload = null;
      if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
      if (recordingLimitInterval) { clearInterval(recordingLimitInterval); recordingLimitInterval = null; }
      recordingIndicator.classList.remove('visible');
      pauseRecordBtn.style.display = 'none';

      if (!recordingChunks.length) {
        setResult('Recording produced no audio.', true);
        return;
      }
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      recordingChunks = [];
      setCurrentAudio(blob);
      setResult('Listen back, pick model and language, then click Transcribe.');
    };

    mediaRecorder.onerror = (e) => {
      setResult('Recording error: ' + (e.error?.message || 'unknown'), true);
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    };

    mediaRecorder.start(5000);
    recordBtn.textContent = 'Stop';
    recordBtn.classList.add('stop');
    window.onbeforeunload = () => true;

    recordingStartTime = Date.now();
    recordingPausedDuration = 0;
    recordingPausedAt = null;
    recordingIndicator.classList.remove('paused');
    recordingPausedEl.classList.add('hidden');
    recordingTimeEl.textContent = '0:00';
    recordingIndicator.classList.add('visible');
    if (typeof mediaRecorder.pause === 'function') {
      pauseRecordBtn.style.display = '';
      pauseRecordBtn.textContent = 'Pause';
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
          showToast('Recording stopped at 3-hour limit.');
        }
      }
    }, 30000);
  } catch (e) {
    setResult('Microphone error: ' + e.message, true);
  }
});

// --- Upload ---
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  setCurrentAudio(file);
  setResult('Listen back, pick model and language, then click Transcribe.');
  fileInput.value = '';
});

// --- Save / download current transcript ---
saveBtn.addEventListener('click', async () => {
  const text = currentTranscriptText.trim();
  if (!text) return;
  const title = (window.prompt('Title for this transcript (optional):', '') || '').trim() || 'Untitled';
  try {
    const id = crypto.randomUUID();
    const raw = (pipeline && pipeline.id === null && pipeline.raw)
      ? pipeline.raw
      : { text, segments: splitIntoSegments(text, currentChunks), modelId: modelSelect.value };
    const entry = {
      id,
      title,
      text,
      language: languageSelect.value || 'auto',
      createdAt: new Date().toISOString(),
      raw,
    };
    if (currentAudioBlob) {
      const recordingId = id + '.audio';
      await db.saveRecording(recordingId, currentAudioBlob, currentAudioBlob.type);
      entry.recordingId = recordingId;
    }
    // Persist the review/form pipeline when it belongs to this (unsaved) transcript.
    if (pipeline && pipeline.id === null) {
      entry.correction = pipeline.correction;
      entry.annotations = pipeline.annotations;
      entry.edits = pipeline.edits;
      entry.ruleApplications = pipeline.ruleApplications;
      entry.finalTranscript = pipeline.finalTranscript;
      entry.editLog = pipeline.editLog;
      entry.form = pipeline.form;
    }
    await db.saveTranscript(entry);
    if (pipeline && pipeline.id === null) { pipeline.id = id; pipeline.title = title; }
    showToast('Saved as "' + title + '".');
    loadSavedList();
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
});

downloadBtn.addEventListener('click', () => {
  downloadAsTxt(buildTranscriptExportText(pipeline, currentTranscriptText), 'transcript.txt');
});

// --- Saved transcripts list ---
function renderSavedList(items) {
  if (!items || items.length === 0) {
    savedListEl.innerHTML = '<li class="empty-state">No saved transcripts yet. Transcribe and click Save.</li>';
    return;
  }
  savedListEl.innerHTML = items.map(t => `
    <li data-id="${t.id}">
      <span class="item-title" title="${escapeHtml(t.title || 'Untitled')}">${escapeHtml(t.title || 'Untitled')}</span>
      <span class="item-date">${formatDate(t.createdAt)}</span>
      <span class="item-actions">
        <button type="button" class="open-btn">Open</button>
        <button type="button" class="danger delete-btn">Delete</button>
      </span>
    </li>
  `).join('');
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
    savedListEl.innerHTML = '<li class="empty-state error">Failed to load list.</li>';
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
    const t = await db.getTranscript(id);
    if (!t) throw new Error('Not found');
    currentDetailTranscript = t;
    exitEditMode();
    detailTitle.textContent = t.title || 'Untitled';
    detailContent.textContent = t.text || '';
    if (detailAudioObjectUrl) { URL.revokeObjectURL(detailAudioObjectUrl); detailAudioObjectUrl = null; }
    if (t.recordingId) {
      const rec = await db.getRecording(t.recordingId);
      if (rec && rec.blob) {
        detailAudioObjectUrl = URL.createObjectURL(rec.blob);
        detailRecordingSection.classList.remove('hidden');
        detailAudio.src = detailAudioObjectUrl;
        detailDownloadAudioLink.href = detailAudioObjectUrl;
        const ext = (rec.mimeType || '').includes('webm') ? '.webm' : '';
        detailDownloadAudioLink.download = (t.title || 'recording').replace(/\s+/g, '_') + (ext || '.audio');
      } else {
        detailRecordingSection.classList.add('hidden');
      }
    } else {
      detailRecordingSection.classList.add('hidden');
      detailAudio.src = '';
      detailDownloadAudioLink.href = '#';
    }
    // Restore any saved review/form pipeline so the clinician can continue.
    if (t.correction || t.form) {
      loadPipelineFromEntry(t);
    } else {
      resetPipelineUI();
    }
    detailPanel.classList.remove('hidden');
    updateBusyButtons();
  } catch (e) {
    showToast('Could not open transcript.');
  }
}

async function removeTranscript(id) {
  try {
    await db.deleteTranscript(id);
    showToast('Deleted.');
    if (currentDetailTranscript && currentDetailTranscript.id === id) {
      detailPanel.classList.add('hidden');
      currentDetailTranscript = null;
    }
    if (pipeline && pipeline.id === id) resetPipelineUI();
    loadSavedList();
  } catch (e) {
    showToast('Could not delete.');
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
    showToast('Saved changes.');
  } catch (e) {
    showToast('Could not save changes.');
  }
});

detailRenameBtn.addEventListener('click', async () => {
  if (!currentDetailTranscript) return;
  const newTitle = (window.prompt('New title:', currentDetailTranscript.title || 'Untitled') || '').trim();
  if (!newTitle) return;
  try {
    const updated = await db.updateTranscript(currentDetailTranscript.id, { title: newTitle });
    currentDetailTranscript = updated;
    detailTitle.textContent = newTitle;
    showToast('Renamed.');
    loadSavedList();
  } catch (e) {
    showToast('Could not rename.');
  }
});

detailDownloadBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  const t = currentDetailTranscript;
  const text = (pipeline && pipeline.id === t.id)
    ? buildTranscriptExportText(pipeline, t.text || '')
    : buildTranscriptExportText(t, t.text || '');
  downloadAsTxt(text, (t.title || 'transcript').replace(/\s+/g, '_') + '.txt');
});

// --- Detail: re-transcribe with currently selected model/language ---
detailRetranscribeBtn.addEventListener('click', async () => {
  if (!currentDetailTranscript || !currentDetailTranscript.recordingId || isTranscribing) return;
  const rec = await db.getRecording(currentDetailTranscript.recordingId);
  if (!rec || !rec.blob) { showToast('Recording not found.'); return; }
  isTranscribing = true;
  detailRetranscribeBtn.disabled = true;
  const originalText = currentDetailTranscript.text || '';
  detailContent.textContent = 'Re-transcribing…';
  try {
    const { text, chunks } = await runTranscription(rec.blob, (partial) => {
      if (!auth.isUnlocked()) return;
      detailContent.textContent = partial;
    });
    if (!auth.isUnlocked()) return;
    const raw = { text, segments: splitIntoSegments(text, chunks), modelId: modelSelect.value };
    // A fresh transcription invalidates any prior correction/review/form.
    const updated = await db.updateTranscript(currentDetailTranscript.id, {
      text, raw, correction: null, annotations: null, edits: null, finalTranscript: null, editLog: null, form: null,
    });
    currentDetailTranscript = updated;
    detailContent.textContent = text;
    showToast('Transcript updated. Re-run "Improve & review".');
  } catch (e) {
    if (!auth.isUnlocked()) return;
    detailContent.textContent = originalText;
    showToast('Re-transcription failed: ' + e.message);
  } finally {
    isTranscribing = false;
    detailRetranscribeBtn.disabled = false;
  }
});

// --- Model select: invalidate readiness so next transcription loads the new model ---
modelSelect.addEventListener('change', () => {
  const modelId = modelSelect.value;
  if (modelReady && modelReady.modelId !== modelId) {
    modelStatus.textContent = `Model will switch to ${shortModelName(modelId)} on next transcription.`;
  }
});

// =====================================================================
// Medical form filling (local LLM via Web-LLM, see js/llm-worker.js)
// =====================================================================

const DEFAULT_TEMPLATE = [
  { name: 'Reason for visit', hint: 'Why the patient came in' },
  { name: 'Symptoms', hint: 'Symptoms reported by the patient, with onset and duration' },
  { name: 'Findings', hint: 'Observations or examination findings mentioned by the clinician' },
  { name: 'Plan / medication', hint: 'Recommended actions, prescriptions with dosage, follow-up' },
];

let templateFields = DEFAULT_TEMPLATE.map(f => ({ ...f }));

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

// --- Template editor ---
const persistTemplate = debounce(() => {
  if (!auth.isUnlocked()) return;
  db.saveFormTemplate(templateFields).catch(() => showToast('Could not save form template.'));
}, 600);

function renderTemplateEditor() {
  templateFieldsEl.innerHTML = '';
  templateFields.forEach((field, i) => {
    const row = document.createElement('div');
    row.className = 'template-field-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'field-name';
    nameInput.placeholder = 'Field name';
    nameInput.value = field.name;
    nameInput.addEventListener('input', () => { templateFields[i].name = nameInput.value; persistTemplate(); });

    const hintInput = document.createElement('input');
    hintInput.type = 'text';
    hintInput.className = 'field-hint';
    hintInput.placeholder = 'Hint for the AI (optional)';
    hintInput.value = field.hint || '';
    hintInput.addEventListener('input', () => { templateFields[i].hint = hintInput.value; persistTemplate(); });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove field';
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
  templateFields = DEFAULT_TEMPLATE.map(f => ({ ...f }));
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
        setLlmProgress(msg.text || 'Loading local assistant…', msg.progress);
        break;
      case 'ready':
        llmModelReady = true;
        setLlmProgress('Local assistant ready: Qwen2.5 1.5B (cached for offline use).');
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
          setLlmProgress('Local assistant error: ' + err.message);
        }
        break;
      }
    }
  };
  llmWorker.onerror = (e) => {
    const err = new Error(e.message || 'Local assistant worker failed');
    setLlmProgress('Local assistant failed to start: ' + err.message);
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

function correctInWorker(segments, protectedTerms, knownTerms) {
  return llmRequest({ type: 'correct', segments, protectedTerms, knownTerms }).then((m) => m.result);
}

function extractInWorker(transcript, segments, schema) {
  return llmRequest({ type: 'extract', transcript, segments, schema }).then((m) => ({ data: m.data, truncated: m.truncated }));
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
      showToast('Correctieregel opgeslagen.');
    } catch (_) {
      showToast('Kon de regel niet opslaan.');
    }
  },
});

const formReviewUI = createFormReviewUI(formReviewRoot, {
  onChange: () => persistPipeline(),
  onApprove: () => { persistPipeline(); showToast('Formulier goedgekeurd.'); },
  onExport: (p) => exportFinalForm(p),
});

const persistPipeline = debounce(() => {
  if (!auth.isUnlocked() || !pipeline || !pipeline.id) return;
  db.updateTranscript(pipeline.id, {
    raw: pipeline.raw,
    correction: pipeline.correction,
    annotations: pipeline.annotations,
    edits: pipeline.edits,
    ruleApplications: pipeline.ruleApplications,
    finalTranscript: pipeline.finalTranscript,
    editLog: pipeline.editLog,
    form: pipeline.form,
  }).then((updated) => {
    if (currentDetailTranscript && currentDetailTranscript.id === updated.id) currentDetailTranscript = updated;
  }).catch(() => showToast('Could not save review changes.'));
}, 600);

function buildPipeline({ id = null, title = '', language, text, segments }) {
  return {
    id, title, language,
    raw: { text, segments, modelId: modelSelect.value },
    correction: null, annotations: null, edits: {}, ruleApplications: [],
    finalTranscript: null, editLog: null, form: null,
  };
}

function loadPipelineFromEntry(t) {
  pipeline = {
    id: t.id,
    title: t.title || '',
    language: t.language,
    raw: (t.raw && Array.isArray(t.raw.segments)) ? t.raw : { text: t.text || '', segments: splitIntoSegments(t.text || '', []), modelId: t.raw ? t.raw.modelId : null },
    correction: t.correction || null,
    annotations: t.annotations || null,
    edits: t.edits || {},
    ruleApplications: t.ruleApplications || [],
    finalTranscript: t.finalTranscript || null,
    editLog: t.editLog || null,
    form: normalizePipelineForm(t.form),
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
    setFormPanelStatus('success', `Saved form loaded (${n} field(s)). Review the filled values in the right column below.`);
    formReviewUI.render(pipeline);
  } else {
    formPanel.classList.add('hidden');
    formReviewUI.clear();
    setFormPanelStatus('', '');
  }
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
  reviewUI.setProceedBusy(isExtracting, isExtracting ? 'Formulier genereren…' : 'Genereer formulier');
}

function handleLlmError(err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  let statusMsg = 'Local assistant error: ' + msg;
  if (/no webgpu adapter|webgpu is not available/i.test(msg)) {
    statusMsg =
      'Local assistant unavailable: no working WebGPU GPU adapter. ' +
      'Fully restart the browser (especially after a prior GPU crash), use Chrome or Edge, update graphics drivers, ' +
      'and check chrome://gpu. Transcription still works.';
    llmSupported = false;
    llmUnavailableReason = statusMsg;
    updateBusyButtons();
  } else if (/memory|allocat|device.*lost|device.*hung|dxgi/i.test(msg)) {
    statusMsg += ' — your GPU may not have enough memory, or the GPU reset after a hang. Close other tabs, restart the browser, then try again.';
  } else if (/fetch|network|download/i.test(msg)) {
    statusMsg += ' — the model download may have been interrupted. Check your connection and try again.';
  }
  setLlmProgress(statusMsg);
  showToast('AI-stap mislukt: ' + msg);
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
  if (!llmSupported) { showToast('Form/correction needs WebGPU (use a recent Chrome or Edge).'); return; }
  isExtracting = true;
  updateBusyButtons();
  formPanel.classList.add('hidden');
  formReviewUI.clear();
  if (!llmModelReady) setLlmProgress('Loading local assistant (first use downloads ~900 MB, then cached)…');
  showToast('Bezig met verbeteren van de transcriptie…');

  try {
    const rules = await correctionMemory.getActiveRules({ specialty: null });
    const ruleApplications = [];
    const protectedAll = [];
    const inputSegments = pipeline.raw.segments.map((seg) => {
      const { text, applied, protectedTerms } = correctionMemory.applyLocalCorrectionRules(seg.text, rules);
      for (const a of applied) ruleApplications.push({ ...a, segment_id: seg.id, at: new Date().toISOString() });
      for (const p of protectedTerms) protectedAll.push(p);
      return { id: seg.id, text, asrConfidence: seg.asrConfidence };
    });
    pipeline.ruleApplications = ruleApplications;
    const protectedTerms = dedupeProtected(protectedAll);
    const knownTerms = findKnownTerms(inputSegments.map((s) => s.text).join(' '));

    const result = await correctInWorker(inputSegments, protectedTerms, knownTerms);
    if (!auth.isUnlocked()) return;

    pipeline.correction = {
      correctedText: result.corrected_transcript,
      segments: result.segments,
      globalWarnings: result.global_warnings,
    };
    pipeline.annotations = annotateTranscriptUncertainty(inputSegments, result.segments);
    pipeline.edits = {};
    pipeline.finalTranscript = null;
    pipeline.editLog = null;
    pipeline.form = null;

    reviewPanel.classList.remove('hidden');
    reviewUI.render(pipeline);
    reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    persistPipeline();
    setLlmProgress('Local assistant ready: Qwen2.5 1.5B (cached for offline use).');
    showToast('Transcriptie verbeterd. Beoordeel de gemarkeerde passages.');
  } catch (err) {
    if (!auth.isUnlocked()) return;
    handleLlmError(err);
  } finally {
    isExtracting = false;
    updateBusyButtons();
  }
}

// Step 7-8: build final reviewed transcript, then fill the form from it only.
async function runGenerateForm() {
  if (!pipeline || !pipeline.correction) return;
  if (isExtracting) {
    showToast('Form generation is already in progress…', 3000);
    return;
  }
  try {
    assertFormGenerationAllowed(pipeline.annotations);
  } catch (e) {
    showToast(e.message, 5000);
    return;
  }
  const schema = buildSchema();
  if (!schema) { showToast('Add at least one form field to the template first.', 5000); return; }

  isExtracting = true;
  updateBusyButtons();

  const final = generateFinalReviewedTranscript(pipeline.correction.segments, pipeline.edits);
  pipeline.finalTranscript = final;
  pipeline.editLog = buildEditLog(pipeline.correction.segments, pipeline.edits, pipeline.ruleApplications);

  formPanel.classList.remove('hidden');
  setFormPanelStatus('loading', 'Filling the form from your reviewed transcript… This can take a minute on first use while the local AI model loads.');
  formReviewRoot.innerHTML = '<p class="empty-state loading">Extracting form data from the reviewed transcript…</p>';
  if (!llmModelReady) setLlmProgress('Loading local assistant…');

  try {
    const { data, truncated } = await extractInWorker(final.text, final.segments, schema);
    if (!auth.isUnlocked()) return;
    pipeline.form = {
      fields: data.fields,
      missingFields: data.missing_fields,
      overallWarnings: data.overall_warnings,
      approvedAt: null,
    };
    formReviewUI.render(pipeline);
    const filledCount = data.fields.filter((f) => f.value && f.value !== 'niet vermeld').length;
    setFormPanelStatus(
      'success',
      `Form filled (${filledCount} of ${data.fields.length} fields have values). Review the fields in the right column below. ` +
      'Click "Toon bron" on any field to see where its value came from in the transcript.',
    );
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    persistPipeline();
    if (truncated) showToast('Note: the transcript was very long and was truncated for extraction.', 6000);
    setLlmProgress('Local assistant ready: Qwen2.5 1.5B (cached for offline use).');
    showToast('Form filled — scroll to Step 3 below and review each field.', 7000);
  } catch (err) {
    if (!auth.isUnlocked()) return;
    setFormPanelStatus('error', 'Form filling failed: ' + (err.message || 'unknown error') + '. See the message below, then try again.');
    formReviewRoot.innerHTML = '<p class="empty-state error">Form filling failed: ' + escapeHtml(err.message || 'unknown error') + '</p>';
    handleLlmError(err);
  } finally {
    isExtracting = false;
    updateBusyButtons();
  }
}

// --- Export text helpers ---
function formAsTextStructured(form) {
  const normalized = normalizePipelineForm(form);
  if (!normalized || !normalized.fields.length) return '';
  return normalized.fields
    .map((f) => `${f.field_name}:\n${f.value || '—'}${f.needs_review ? '  [controleer]' : ''}`)
    .join('\n\n');
}

function buildTranscriptExportText(p, fallbackText) {
  if (!p) return fallbackText || '';
  const parts = [];
  const raw = (p.raw && p.raw.text) || fallbackText || '';
  parts.push('===== Ruwe transcriptie (Whisper) =====\n' + raw);
  if (p.finalTranscript && p.finalTranscript.text) {
    parts.push('===== Definitieve gecontroleerde transcriptie =====\n' + p.finalTranscript.text);
  } else if (p.correction && p.correction.correctedText) {
    parts.push('===== AI-gecorrigeerde transcriptie =====\n' + p.correction.correctedText);
  }
  const formText = formAsTextStructured(p.form);
  if (formText) {
    parts.push('===== Medisch formulier =====\n' + formText);
  }
  return parts.join('\n\n');
}

// --- Entry points: start review from the current or a saved transcript ---
reviewBtn.addEventListener('click', () => {
  const text = currentTranscriptText.trim();
  if (!text) { showToast('Transcript is empty.'); return; }
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
  const t = currentDetailTranscript;
  if (pipeline && pipeline.id === t.id && pipeline.correction) {
    // Already loaded with a correction: re-run to refresh.
    runCorrection();
    return;
  }
  loadPipelineFromEntry(t);
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
  const reason = llmUnavailableReason ||
    'Transcript correction and form filling need a working WebGPU GPU adapter. Use a recent Chrome or Edge.';
  reviewBtn.title = reason;
  detailFillFormBtn.title = reason;
  llmStatus.textContent = reason + ' Transcription still works normally.';
}

async function probeWebGpu() {
  llmStatus.textContent = 'Checking WebGPU for the local assistant…';
  const { available, reason } = await probeWebGpuAvailable();
  llmSupported = available;
  llmUnavailableReason = reason || '';
  if (llmSupported) {
    llmStatus.textContent =
      'The local assistant (Qwen2.5 1.5B, ~900 MB) downloads on first use, then is cached for offline use. Runs locally via WebGPU.';
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
  return isTranscribing || isExtracting ||
    !!(mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused'));
}

function discardActiveRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.onerror = null;
    try { mediaRecorder.stop(); } catch (_) { /* already stopped */ }
  }
  recordingStream?.getTracks().forEach(t => t.stop());
  recordingStream = null;
  recordingChunks = [];
  mediaRecorder = null;
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
  if (recordingLimitInterval) { clearInterval(recordingLimitInterval); recordingLimitInterval = null; }
  recordBtn.textContent = 'Record';
  recordBtn.classList.remove('stop');
  recordingIndicator.classList.remove('visible');
  pauseRecordBtn.style.display = 'none';
  window.onbeforeunload = null;
}

function handleLocked() {
  discardActiveRecording();

  // Current (unsaved) transcript + audio
  currentTranscriptText = '';
  currentChunks = [];
  resultEl.textContent = 'Record or upload audio to transcribe.';
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
  savedListEl.innerHTML = '<li class="empty-state">Locked.</li>';
  resetPipelineUI();
  correctionMemory.clearSessionRules();
  templateFields = DEFAULT_TEMPLATE.map(f => ({ ...f }));
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
    if (migrated > 0) showToast(`Encrypted ${migrated} existing item(s) under your account.`);
  } catch (e) {
    console.warn('Legacy data migration failed', e);
  }
  loadTemplate();
  loadSavedList();
  probeWebGpu();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = loginUsername.value;
  const password = loginPassword.value;
  if (!username.trim() || !password) return;
  loginSubmitBtn.disabled = true;
  loginError.textContent = '';
  loginSubmitBtn.textContent = 'Checking…';
  try {
    const ok = await auth.login(username, password);
    if (!ok) {
      loginError.textContent = 'Access denied: invalid username or password.';
      loginPassword.value = '';
      loginPassword.focus();
      return;
    }
    loginPassword.value = '';
    await onUnlocked();
  } catch (err) {
    loginError.textContent = 'Login failed: ' + (err.message || 'unknown error');
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Unlock';
  }
});

lockBtn.addEventListener('click', () => auth.lock());

auth.configureAutoLock({ onLock: handleLocked, isBusy: isAppBusy });

// --- Init ---
if ([...modelSelect.options].some(o => o.value === DEFAULT_MODEL)) {
  modelSelect.value = DEFAULT_MODEL;
}
languageSelect.value = DEFAULT_LANGUAGE;
probeWebGpu();
requestPersistentStorage();
loginUsername.focus();
