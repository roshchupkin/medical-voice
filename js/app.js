import * as db from './db.js';

// --- DOM ---
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

// --- State ---
let currentTranscriptText = '';
let currentAudioBlob = null;        // unsaved recording/upload kept in memory
let currentAudioObjectUrl = null;
let currentDetailTranscript = null;
let detailAudioObjectUrl = null;
let isTranscribing = false;

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
      if (job) { pendingJobs.delete(msg.id); job.resolve(msg.text); }
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
}

function setLoading(message) {
  resultEl.textContent = message || 'Transcribing…';
  resultEl.className = 'loading';
  saveBtn.disabled = true;
  downloadBtn.disabled = true;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
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
    const text = await runTranscription(currentAudioBlob, (partial) => {
      resultEl.textContent = partial;
      resultEl.className = 'loading';
    });
    setResult(text);
  } catch (err) {
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
    const entry = {
      id,
      title,
      text,
      language: languageSelect.value || 'auto',
      createdAt: new Date().toISOString(),
    };
    if (currentAudioBlob) {
      const recordingId = id + '.audio';
      await db.saveRecording(recordingId, currentAudioBlob, currentAudioBlob.type);
      entry.recordingId = recordingId;
    }
    await db.saveTranscript(entry);
    showToast('Saved as "' + title + '".');
    loadSavedList();
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
});

downloadBtn.addEventListener('click', () => {
  downloadAsTxt(currentTranscriptText, 'transcript.txt');
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
    detailPanel.classList.remove('hidden');
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
    loadSavedList();
  } catch (e) {
    showToast('Could not delete.');
  }
}

backToListBtn.addEventListener('click', () => {
  detailPanel.classList.add('hidden');
  currentDetailTranscript = null;
  exitEditMode();
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
  downloadAsTxt(currentDetailTranscript.text, (currentDetailTranscript.title || 'transcript').replace(/\s+/g, '_') + '.txt');
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
    const text = await runTranscription(rec.blob, (partial) => {
      detailContent.textContent = partial;
    });
    const updated = await db.updateTranscript(currentDetailTranscript.id, { text });
    currentDetailTranscript = updated;
    detailContent.textContent = text;
    showToast('Transcript updated.');
  } catch (e) {
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

// --- Init ---
loadSavedList();
