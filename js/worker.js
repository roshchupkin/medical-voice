// Web Worker: runs the Whisper model via Transformers.js, fully in-browser.
// Messages in:  { type: 'load', modelId }
//               { type: 'transcribe', id, audio: Float32Array, language: string|null }
// Messages out: { type: 'device', device }
//               { type: 'progress', file, loaded, total }
//               { type: 'ready', modelId, device }
//               { type: 'partial', id, text }
//               { type: 'complete', id, text, chunks, metrics? }
//               { type: 'ready', modelId, device, metrics? }
//               { type: 'error', id?, message }
//
// `chunks` carries segment-level timestamps ([{ text, timestamp: [start, end] }])
// when the model produces them. They feed the heuristic ASR-confidence scoring
// in js/segments.js. They are best-effort: some models/inputs return none.

import { pipeline, WhisperTextStreamer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let transcriber = null;
let currentModelId = null;
let device = null;

async function detectDevice() {
  if (device) return device;
  try {
    if (self.navigator && 'gpu' in self.navigator) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        device = 'webgpu';
        return device;
      }
    }
  } catch (_) {
    // WebGPU probe failed; fall through to WASM
  }
  device = 'wasm';
  return device;
}

function progressCallback(p) {
  if (p.status === 'progress') {
    self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
  }
}

function heapSnapshot() {
  const mem = performance.memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
  return mem.usedJSHeapSize;
}

function buildMetrics(t0, memBefore) {
  const memAfter = heapSnapshot();
  return {
    durationMs: performance.now() - t0,
    memory: {
      available: memBefore != null || memAfter != null,
      heapUsedBefore: memBefore,
      heapUsedAfter: memAfter,
      heapDelta: (memBefore != null && memAfter != null) ? memAfter - memBefore : null,
    },
  };
}

async function loadModel(modelId) {
  if (transcriber && currentModelId === modelId) {
    self.postMessage({ type: 'ready', modelId, device, metrics: { durationMs: 0, cached: true } });
    return;
  }
  const t0 = performance.now();
  const memBefore = heapSnapshot();
  if (transcriber) {
    try { await transcriber.dispose(); } catch (_) { /* best effort */ }
    transcriber = null;
    currentModelId = null;
  }
  await detectDevice();
  self.postMessage({ type: 'device', device });

  // Use 4-bit weights to keep memory low enough for the large multilingual
  // models. The fp16/fp32 encoders are 1.2-2.4 GB and overflow the download
  // buffer on limited-RAM machines; the q4f16 encoder is ~350 MB. On WebGPU we
  // use q4f16 (4-bit weights, fp16 activations); on the WASM/CPU fallback we use
  // plain q4 since fp16 activations are not well supported there.
  const buildOptions = (dev) => dev === 'webgpu'
    ? { device: 'webgpu', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, progress_callback: progressCallback }
    : { device: 'wasm', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, progress_callback: progressCallback };

  try {
    transcriber = await pipeline('automatic-speech-recognition', modelId, buildOptions(device));
  } catch (err) {
    if (device === 'webgpu') {
      // WebGPU init can fail on some drivers; retry on WASM.
      device = 'wasm';
      self.postMessage({ type: 'device', device });
      transcriber = await pipeline('automatic-speech-recognition', modelId, buildOptions('wasm'));
    } else {
      throw err;
    }
  }
  currentModelId = modelId;
  self.postMessage({ type: 'ready', modelId, device, metrics: buildMetrics(t0, memBefore) });
}

async function transcribe({ id, audio, language }) {
  const t0 = performance.now();
  const memBefore = heapSnapshot();
  const audioSamples = audio ? audio.length : 0;
  if (!transcriber) {
    self.postMessage({ type: 'error', id, message: 'Model not loaded.' });
    return;
  }
  let partialText = '';
  const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
    skip_prompt: true,
    callback_function: (text) => {
      partialText += text;
      self.postMessage({ type: 'partial', id, text: partialText });
    },
  });
  let output;
  try {
    // Segment-level timestamps give us per-phrase timing for the heuristic
    // confidence scoring without the instability of word-level timestamps.
    output = await transcriber(audio, {
      language: language || null,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      streamer,
    });
  } catch (err) {
    // Some quantized models reject timestamp decoding; fall back to plain text.
    output = await transcriber(audio, {
      language: language || null,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
      streamer,
    });
  }
  const text = (output && output.text ? output.text : '').trim();
  const chunks = (output && Array.isArray(output.chunks)) ? output.chunks.map((c) => ({
    text: c.text || '',
    timestamp: Array.isArray(c.timestamp) ? c.timestamp : null,
  })) : [];
  const metrics = buildMetrics(t0, memBefore);
  metrics.audioSamples = audioSamples;
  metrics.audioPcm = audioSamples * 4;
  metrics.transcriptUtf8 = new TextEncoder().encode(text || '').length;
  self.postMessage({ type: 'complete', id, text: text || '(no speech detected)', chunks, metrics });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await loadModel(msg.modelId);
    } else if (msg.type === 'transcribe') {
      await transcribe(msg);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
  }
};
