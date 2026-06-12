// Web Worker: runs the Whisper model via Transformers.js, fully in-browser.
// Messages in:  { type: 'load', modelId }
//               { type: 'transcribe', id, audio: Float32Array, language: string|null }
// Messages out: { type: 'device', device }
//               { type: 'progress', file, loaded, total }
//               { type: 'ready', modelId, device }
//               { type: 'partial', id, text }
//               { type: 'complete', id, text }
//               { type: 'error', id?, message }

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

async function loadModel(modelId) {
  if (transcriber && currentModelId === modelId) {
    self.postMessage({ type: 'ready', modelId, device });
    return;
  }
  if (transcriber) {
    try { await transcriber.dispose(); } catch (_) { /* best effort */ }
    transcriber = null;
    currentModelId = null;
  }
  await detectDevice();
  self.postMessage({ type: 'device', device });

  const buildOptions = (dev) => dev === 'webgpu'
    ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: progressCallback }
    : { device: 'wasm', dtype: 'q8', progress_callback: progressCallback };

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
  self.postMessage({ type: 'ready', modelId, device });
}

async function transcribe({ id, audio, language }) {
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
  const output = await transcriber(audio, {
    language: language || null,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
    streamer,
  });
  const text = (output && output.text ? output.text : '').trim();
  self.postMessage({ type: 'complete', id, text: text || '(no speech detected)' });
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
