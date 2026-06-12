// Web Worker: runs a local small language model (Qwen2.5 1.5B) via Web-LLM,
// fully in-browser over WebGPU, to extract structured form data from transcripts.
// Messages in:  { type: 'extract', id, transcript, schema }
// Messages out: { type: 'progress', text, progress }   // progress is 0..1
//               { type: 'ready', modelId }
//               { type: 'complete', id, data, truncated }
//               { type: 'error', id?, message }

import * as webllm from 'https://esm.run/@mlc-ai/web-llm@0.2.84';

const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
const CONTEXT_WINDOW = 8192;
// Keep the prompt safely inside the context window (~4 chars per token, leaving
// room for the system prompt and the generated JSON).
const MAX_TRANSCRIPT_CHARS = 16000;

let engine = null;
let enginePromise = null;

async function ensureEngine() {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = (async () => {
      if (!self.navigator || !('gpu' in self.navigator)) {
        throw new Error('WebGPU is not available in this browser.');
      }
      const adapter = await self.navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No WebGPU adapter found. Form filling needs a GPU-capable browser.');
      }
      const eng = await webllm.CreateMLCEngine(
        MODEL_ID,
        {
          initProgressCallback: (report) => {
            self.postMessage({
              type: 'progress',
              text: report.text || '',
              progress: typeof report.progress === 'number' ? report.progress : 0,
            });
          },
        },
        { context_window_size: CONTEXT_WINDOW },
      );
      self.postMessage({ type: 'ready', modelId: MODEL_ID });
      return eng;
    })();
    // Allow retrying after a failed load (e.g. interrupted download).
    enginePromise.catch(() => { enginePromise = null; });
  }
  engine = await enginePromise;
  return engine;
}

function buildMessages(transcript, schema) {
  const fieldList = Object.entries(schema.properties || {})
    .map(([name, def]) => `- "${name}"${def.description ? `: ${def.description}` : ''}`)
    .join('\n');
  const system = [
    'You are a clinical documentation assistant.',
    'You receive the raw transcript of a medical consultation and must fill out a form.',
    'Extract information strictly from the transcript. Never invent, guess, or embellish details.',
    'Write each field value in the same language as the transcript.',
    'If the transcript contains no information for a field, use an empty string "".',
    'Respond with a JSON object containing exactly these fields:',
    fieldList,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Transcript:\n\n' + transcript },
  ];
}

async function extract({ id, transcript, schema }) {
  const eng = await ensureEngine();
  let text = (transcript || '').trim();
  let truncated = false;
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }
  const response = await eng.chat.completions.create({
    messages: buildMessages(text, schema),
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
  });
  const content = response?.choices?.[0]?.message?.content || '';
  let data;
  try {
    data = JSON.parse(content);
  } catch (_) {
    throw new Error('The model returned invalid JSON. Please try again.');
  }
  self.postMessage({ type: 'complete', id, data, truncated });
}

// Serialize jobs: the engine handles one request at a time.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'extract') {
        await extract(msg);
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
    }
  });
};
