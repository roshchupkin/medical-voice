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
const fillFormBtn = document.getElementById('fillFormBtn');
const detailFillFormBtn = document.getElementById('detailFillFormBtn');
const llmStatus = document.getElementById('llmStatus');
const llmProgressWrap = document.getElementById('llmProgressWrap');
const llmProgressBar = document.getElementById('llmProgressBar');
const templateFieldsEl = document.getElementById('templateFields');
const addFieldBtn = document.getElementById('addFieldBtn');
const resetTemplateBtn = document.getElementById('resetTemplateBtn');
const formFieldsEl = document.getElementById('formFields');
const downloadFormJsonBtn = document.getElementById('downloadFormJsonBtn');
const formSourceHint = document.getElementById('formSourceHint');

// --- State ---
let currentTranscriptText = '';
let currentAudioBlob = null;        // unsaved recording/upload kept in memory
let currentAudioObjectUrl = null;
let currentDetailTranscript = null;
let detailAudioObjectUrl = null;
let isTranscribing = false;
let currentFormData = null;   // { fieldName: value } or null
let formSourceId = null;      // saved transcript id the form belongs to, or null for the current (unsaved) transcript
let formBelongsToCurrent = false; // true when the form was filled from the current (left panel) transcript
let isExtracting = false;
let llmSupported = 'gpu' in navigator;

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
  fillFormBtn.disabled = !currentTranscriptText || !llmSupported || isExtracting;
}

function setLoading(message) {
  resultEl.textContent = message || 'Transcribing…';
  resultEl.className = 'loading';
  saveBtn.disabled = true;
  downloadBtn.disabled = true;
  fillFormBtn.disabled = true;
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
    if (currentFormData && formBelongsToCurrent) {
      entry.form = { ...currentFormData };
      formSourceId = id;
      updateFormSourceHint();
    }
    await db.saveTranscript(entry);
    showToast('Saved as "' + title + '".');
    loadSavedList();
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
});

downloadBtn.addEventListener('click', () => {
  const form = (currentFormData && formBelongsToCurrent) ? currentFormData : null;
  downloadAsTxt(transcriptWithFormText(currentTranscriptText, form), 'transcript.txt');
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
    if (t.form && Object.keys(t.form).length) {
      currentFormData = { ...t.form };
      formSourceId = t.id;
      formBelongsToCurrent = false;
      renderForm();
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
    if (formSourceId === id) clearForm();
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
  const t = currentDetailTranscript;
  downloadAsTxt(transcriptWithFormText(t.text || '', t.form), (t.title || 'transcript').replace(/\s+/g, '_') + '.txt');
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

// --- LLM worker (lazy: created on first "Fill form" click) ---
let llmWorker = null;
let llmModelReady = false;
const pendingExtracts = new Map(); // id -> { resolve, reject }
let extractCounter = 0;

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
        setLlmProgress(msg.text || 'Loading form model…', msg.progress);
        break;
      case 'ready':
        llmModelReady = true;
        setLlmProgress('Form model ready: Qwen2.5 1.5B (cached for offline use).');
        break;
      case 'complete': {
        const job = pendingExtracts.get(msg.id);
        if (job) { pendingExtracts.delete(msg.id); job.resolve({ data: msg.data, truncated: msg.truncated }); }
        break;
      }
      case 'error': {
        const err = new Error(msg.message || 'Form model error');
        if (msg.id !== undefined && pendingExtracts.has(msg.id)) {
          const job = pendingExtracts.get(msg.id);
          pendingExtracts.delete(msg.id);
          job.reject(err);
        } else {
          setLlmProgress('Form model error: ' + err.message);
        }
        break;
      }
    }
  };
  llmWorker.onerror = (e) => {
    const err = new Error(e.message || 'Form model worker failed');
    setLlmProgress('Form model failed to start: ' + err.message);
    for (const [id, job] of pendingExtracts) {
      job.reject(err);
      pendingExtracts.delete(id);
    }
    // Allow a fresh worker on next attempt (e.g. after a network hiccup).
    llmWorker.terminate();
    llmWorker = null;
    llmModelReady = false;
  };
  return llmWorker;
}

function extractInWorker(transcript, schema) {
  const id = ++extractCounter;
  return new Promise((resolve, reject) => {
    pendingExtracts.set(id, { resolve, reject });
    getLlmWorker().postMessage({ type: 'extract', id, transcript, schema });
  });
}

// --- Filled form rendering / persistence ---
const persistFormToTranscript = debounce(() => {
  if (!formSourceId || !currentFormData) return;
  db.updateTranscript(formSourceId, { form: { ...currentFormData } })
    .then((updated) => {
      if (currentDetailTranscript && currentDetailTranscript.id === updated.id) currentDetailTranscript = updated;
    })
    .catch(() => showToast('Could not save form changes.'));
}, 600);

function updateFormSourceHint() {
  if (!currentFormData) { formSourceHint.textContent = ''; return; }
  formSourceHint.textContent = formSourceId
    ? 'This form is stored with its saved transcript. Edits are saved automatically.'
    : 'This form belongs to the current transcript. Click "Save transcript" to store them together.';
}

function renderForm() {
  formFieldsEl.innerHTML = '';
  if (!currentFormData) {
    formFieldsEl.innerHTML = '<p class="empty-state">Transcribe audio, then click "Fill form" to extract data into these fields.</p>';
    downloadFormJsonBtn.disabled = true;
    updateFormSourceHint();
    return;
  }
  for (const [name, value] of Object.entries(currentFormData)) {
    const wrap = document.createElement('div');
    wrap.className = 'form-field';
    const label = document.createElement('label');
    label.textContent = name;
    const area = document.createElement('textarea');
    area.value = value || '';
    area.addEventListener('input', () => {
      currentFormData[name] = area.value;
      if (formSourceId) persistFormToTranscript();
    });
    wrap.append(label, area);
    formFieldsEl.appendChild(wrap);
  }
  downloadFormJsonBtn.disabled = false;
  updateFormSourceHint();
}

function clearForm() {
  currentFormData = null;
  formSourceId = null;
  formBelongsToCurrent = false;
  renderForm();
}

function formAsText(form) {
  return Object.entries(form)
    .map(([name, value]) => name + ':\n' + (value || '—'))
    .join('\n\n');
}

function transcriptWithFormText(text, form) {
  if (!form || !Object.keys(form).length) return text;
  return text + '\n\n----- Medical form -----\n\n' + formAsText(form);
}

// --- Extraction flow ---
async function runFormFill(transcript, sourceId) {
  if (isExtracting) return;
  const text = (transcript || '').trim();
  if (!text) { showToast('Nothing to extract: transcript is empty.'); return; }
  const schema = buildSchema();
  if (!schema) { showToast('Add at least one form field to the template first.'); return; }

  isExtracting = true;
  fillFormBtn.disabled = true;
  detailFillFormBtn.disabled = true;
  if (!llmModelReady) setLlmProgress('Loading form model (first use downloads ~900 MB, then cached)…');
  formFieldsEl.innerHTML = '<p class="empty-state loading">Extracting form data from transcript…</p>';
  formSourceHint.textContent = '';
  downloadFormJsonBtn.disabled = true;

  try {
    const { data, truncated } = await extractInWorker(text, schema);
    // Keep template field order; coerce values to strings.
    const form = {};
    for (const name of Object.keys(schema.properties)) {
      const v = data ? data[name] : '';
      form[name] = (v === null || v === undefined) ? '' : String(v);
    }
    currentFormData = form;
    formSourceId = sourceId || null;
    formBelongsToCurrent = !sourceId;
    renderForm();
    if (formSourceId) {
      const updated = await db.updateTranscript(formSourceId, { form: { ...form } });
      if (currentDetailTranscript && currentDetailTranscript.id === updated.id) currentDetailTranscript = updated;
      showToast('Form filled and saved with the transcript.');
    } else {
      showToast('Form filled. Review the fields before use.');
    }
    if (truncated) showToast('Note: transcript was very long and was truncated for extraction.');
    setLlmProgress('Form model ready: Qwen2.5 1.5B (cached for offline use).');
  } catch (err) {
    formFieldsEl.innerHTML = '<p class="empty-state error">Form filling failed: ' + escapeHtml(err.message || 'unknown error') + '</p>';
    let statusMsg = 'Form model error: ' + (err.message || 'unknown error');
    if (/memory|allocat|device.*lost/i.test(err.message || '')) {
      statusMsg += ' — your GPU may not have enough memory for this model. Close other tabs and try again.';
    } else if (/fetch|network|download/i.test(err.message || '')) {
      statusMsg += ' — the model download may have been interrupted. Check your connection and try again.';
    }
    setLlmProgress(statusMsg);
  } finally {
    isExtracting = false;
    fillFormBtn.disabled = !currentTranscriptText || !llmSupported;
    detailFillFormBtn.disabled = !llmSupported;
  }
}

fillFormBtn.addEventListener('click', () => runFormFill(currentTranscriptText, null));

detailFillFormBtn.addEventListener('click', () => {
  if (!currentDetailTranscript) return;
  runFormFill(currentDetailTranscript.text, currentDetailTranscript.id);
});

downloadFormJsonBtn.addEventListener('click', () => {
  if (!currentFormData) return;
  const blob = new Blob([JSON.stringify(currentFormData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'medical-form.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

function initLlmSupport() {
  if (llmSupported) return;
  fillFormBtn.disabled = true;
  detailFillFormBtn.disabled = true;
  const reason = 'Form filling needs WebGPU, which this browser does not support. Use a recent Chrome or Edge.';
  fillFormBtn.title = reason;
  detailFillFormBtn.title = reason;
  llmStatus.textContent = reason + ' Transcription still works normally.';
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

// --- Init ---
initLlmSupport();
loadTemplate();
loadSavedList();
requestPersistentStorage();
