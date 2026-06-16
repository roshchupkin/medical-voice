// Web Worker: runs a local small language model (Qwen2.5 1.5B) via Web-LLM,
// fully in-browser over WebGPU. It performs two clinical tasks against ONE
// shared engine instance (loading the ~900 MB model only once):
//   - 'correct': improve a raw Dutch transcript and annotate uncertainty,
//                without changing clinical meaning (returns structured JSON).
//   - 'extract': fill a structured medical form from the clinician-reviewed
//                transcript, with per-field source traceability.
//
// Messages in:  { type: 'correct', id, window?, segments?, protectedTerms, knownTerms }
//               { type: 'extract', id, transcript, segments, schema }
// Messages out: { type: 'progress', text, progress }   // progress is 0..1
//               { type: 'ready', modelId }
//               { type: 'complete', id, task, ...result }
//               { type: 'error', id?, message }

import * as webllm from 'https://esm.run/@mlc-ai/web-llm@0.2.84';
import { requestWebGpuAdapter, WEBGPU_ADAPTER_ERROR } from './webgpu-probe.js';
import { EXTRACT_MAX_TRANSCRIPT_CHARS } from './config.js';

const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
// A smaller context window keeps GPU memory use down on weaker adapters (some
// Windows GPUs cap maxStorageBufferBindingSize at 256 MB, which causes device
// loss with larger windows). 4096 tokens is plenty for our prompts + JSON.
const CONTEXT_WINDOW = 4096;

let engine = null;
let enginePromise = null;

// Tolerant JSON parsing: we no longer constrain decoding with a Web-LLM grammar
// (its JSON-schema compiler can crash on some GPUs and the constrained decoding
// adds GPU load that triggers device loss on weak adapters). Instead we ask the
// model for JSON in the prompt and parse it leniently here.
function parseJsonLoose(content) {
  if (!content) return null;
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (_) { /* try to slice out the object */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { /* give up */ }
  }
  return null;
}

// When the GPU device is lost/hung the cached engine is dead; drop it so the
// next request re-initialises (and the app can surface a clear retry message).
function isFatalGpuError(err) {
  const m = (err && err.message ? err.message : String(err || '')).toLowerCase();
  // Adapter missing / API absent is not recoverable by retrying the same request.
  if (m.includes('no webgpu adapter') || m.includes('webgpu is not available')) return false;
  return (
    (m.includes('device') && (m.includes('lost') || m.includes('hung') || m.includes('removed'))) ||
    m.includes('dxgi_error_device_hung')
  );
}
function resetEngine() {
  engine = null;
  enginePromise = null;
}

// Runs a chat completion, automatically recovering ONCE from a lost/hung GPU
// device by dropping the dead engine, re-initialising it, and resubmitting the
// same request. A second fatal failure propagates to the caller.
async function chatWithRetry(params) {
  const eng = await ensureEngine();
  try {
    return await eng.chat.completions.create(params);
  } catch (err) {
    if (!isFatalGpuError(err)) throw err;
    resetEngine();
    self.postMessage({ type: 'progress', text: 'GPU verbroken — model opnieuw laden en opnieuw proberen…', progress: 0 });
    let eng2;
    try {
      eng2 = await ensureEngine();
    } catch (reinitErr) {
      resetEngine();
      throw reinitErr;
    }
    try {
      return await eng2.chat.completions.create(params);
    } catch (retryErr) {
      if (isFatalGpuError(retryErr)) resetEngine();
      throw retryErr;
    }
  }
}

async function ensureEngine() {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = (async () => {
      if (!self.navigator || !('gpu' in self.navigator)) {
        throw new Error('WebGPU is not available in this browser.');
      }
      const adapter = await requestWebGpuAdapter();
      if (!adapter) {
        throw new Error(WEBGPU_ADAPTER_ERROR);
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

// The core safety rule, used verbatim in the correction prompt.
const CORE_RULE =
  'Je mag spelling, grammatica en duidelijke transcriptiefouten corrigeren, ' +
  'maar je mag de medische betekenis niet veranderen. Bij twijfel markeer je de ' +
  'passage als onzeker in plaats van zelf een keuze te maken.';

function formatSegmentBlock(segments) {
  return (segments || []).map((s) => `${s.id}: ${s.text}`).join('\n') || '(geen)';
}

function buildCorrectionMessages({ window, segments, protectedTerms, knownTerms }) {
  const target = window ? (window.target || []) : (segments || []);
  const prevContext = window ? (window.prevContext || []) : [];
  const nextContext = window ? (window.nextContext || []) : [];
  const chunked = !!(window && (prevContext.length || nextContext.length || target.length < (segments || []).length));

  const system = [
    'Je bent een medisch assistent die ruwe Nederlandse spraak-naar-tekst transcripties nakijkt.',
    'Corrigeer eventuele spelfouten, herkenningsfouten en grammaticale problemen, gebaseerd op de medische context.',
    CORE_RULE,
    'Corrigeer alleen wanneer de correctie duidelijk is. Bij onzekerheid: markeer expliciet (highlight_color yellow of red).',
    'Let extra goed op medicatienamen, doseringen, getallen, datums, anatomische locaties, links/rechts, diagnoses, allergieën, negaties en behandeladviezen.',
    'Verander NOOIT stilzwijgend een medicatienaam, dosering, links/rechts of een negatie.',
  ];

  if (chunked) {
    system.push(
      'Corrigeer en retourneer segmenten uitsluitend voor DOELSEGMENTEN.',
      'Contextsegmenten (vorige/volgende) helpen bij zinsgrenzen; negeer ze in de output.',
    );
  }

  system.push(
    '',
    'Antwoord UITSLUITEND met een JSON-object:',
    '{',
    '  "segments": [',
    '    {',
    '      "segment_id": "<id>",',
    '      "corrected_text": "<gecorrigeerde tekst>",',
    '      "change_type": "spelling|grammar|medical_term|medication|dosage|anatomy|laterality|negation|number|date|diagnosis|unclear_audio|no_change",',
    '      "confidence": "high|medium|low",',
    '      "clinical_risk": "low|medium|high",',
    '      "highlight_color": "green|yellow|red",',
    '      "needs_clinician_review": true,',
    '      "reason": "<korte uitleg>"',
    '    }',
    '  ],',
    '  "global_warnings": ["<korte waarschuwing>"]',
    '}',
    'Geef voor ELK doelsegment exact één object met hetzelfde segment_id. Verzin geen segmenten.',
  );

  if (protectedTerms && protectedTerms.length) {
    system.push(
      '',
      'De volgende termen mogen NIET worden gewijzigd (laat ze exact staan):',
      protectedTerms.map((t) => `- "${t.term}"${t.note ? ` (${t.note})` : ''}`).join('\n'),
    );
  }
  if (knownTerms && knownTerms.length) {
    system.push(
      '',
      'Bekende correcte spellingen (referentie):',
      knownTerms.join(', '),
    );
  }

  let userContent;
  if (chunked) {
    userContent = [
      'VORIGE CONTEXT (alleen lezen, niet corrigeren):',
      formatSegmentBlock(prevContext),
      '',
      'DOELSEGMENTEN (corrigeer en retourneer ALLEEN deze):',
      formatSegmentBlock(target),
      '',
      'VOLGENDE CONTEXT (alleen lezen, niet corrigeren):',
      formatSegmentBlock(nextContext),
    ].join('\n');
  } else {
    userContent = 'Ruwe transcriptie per segment:\n\n' + formatSegmentBlock(target);
  }

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: userContent },
  ];
}

const CHANGE_TYPES = new Set([
  'spelling', 'grammar', 'medical_term', 'medication', 'dosage', 'anatomy',
  'laterality', 'negation', 'number', 'date', 'diagnosis', 'unclear_audio', 'no_change',
]);

// Normalises the model's correction output into a trustworthy shape, filling
// safe defaults and guaranteeing one entry per target segment.
function normalizeCorrection(parsed, segments) {
  const bySeg = new Map();
  const list = parsed && Array.isArray(parsed.segments) ? parsed.segments : [];
  for (const item of list) {
    if (item && item.segment_id) bySeg.set(String(item.segment_id), item);
  }

  const outSegments = segments.map((seg) => {
    const raw = bySeg.get(seg.id) || {};
    const correctedText = typeof raw.corrected_text === 'string' && raw.corrected_text.length
      ? raw.corrected_text
      : seg.text;
    const changed = correctedText.trim() !== seg.text.trim();
    let changeType = CHANGE_TYPES.has(raw.change_type) ? raw.change_type : (changed ? 'spelling' : 'no_change');
    if (!changed) changeType = 'no_change';
    const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : (changed ? 'medium' : 'high');
    const clinicalRisk = ['low', 'medium', 'high'].includes(raw.clinical_risk) ? raw.clinical_risk : 'low';
    return {
      segment_id: seg.id,
      original_text: seg.text,
      corrected_text: correctedText,
      change_type: changeType,
      confidence,
      clinical_risk: clinicalRisk,
      highlight_color: ['green', 'yellow', 'red'].includes(raw.highlight_color) ? raw.highlight_color : null,
      needs_clinician_review: raw.needs_clinician_review === true,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    };
  });

  const correctedTranscript = outSegments.map((s) => s.corrected_text).join(' ').trim();

  const globalWarnings = Array.isArray(parsed?.global_warnings)
    ? parsed.global_warnings.filter((w) => typeof w === 'string' && w.trim())
    : [];

  return { corrected_transcript: correctedTranscript, segments: outSegments, global_warnings: globalWarnings };
}

function correctionMaxTokens(targetCount) {
  return Math.min(2000, 120 + 80 * Math.max(1, targetCount || 1));
}

function failedCorrectionFallback(segs) {
  return {
    corrected_transcript: segs.map((s) => s.text).join(' ').trim(),
    segments: segs.map((s) => ({
      segment_id: s.id,
      original_text: s.text,
      corrected_text: s.text,
      change_type: 'no_change',
      confidence: 'low',
      clinical_risk: 'medium',
      highlight_color: 'yellow',
      needs_clinician_review: true,
      reason: 'Automatische correctie mislukt; handmatige controle vereist.',
    })),
    global_warnings: ['Automatische correctie kon niet worden uitgevoerd. Controleer de transcriptie handmatig.'],
    failed: true,
  };
}

async function correct({ id, window, segments, protectedTerms, knownTerms }) {
  const target = window ? (window.target || []) : (Array.isArray(segments) ? segments : []);
  if (!target.length) {
    self.postMessage({
      type: 'complete',
      id,
      task: 'correct',
      result: { corrected_transcript: '', segments: [], global_warnings: [], failed: false },
    });
    return;
  }

  let parsed = null;
  try {
    const response = await chatWithRetry({
      messages: buildCorrectionMessages({ window, segments: target, protectedTerms, knownTerms }),
      temperature: 0,
      max_tokens: correctionMaxTokens(target.length),
    });
    const content = response?.choices?.[0]?.message?.content || '';
    parsed = parseJsonLoose(content);
  } catch (err) {
    if (isFatalGpuError(err)) throw err;
    parsed = null;
  }

  const result = parsed
    ? { ...normalizeCorrection(parsed, target), failed: false }
    : failedCorrectionFallback(target);

  self.postMessage({ type: 'complete', id, task: 'correct', result });
}

function buildMessages(numberedTranscript, fieldNames, fieldHints) {
  const fieldList = fieldNames
    .map((name) => `- "${name}"${fieldHints[name] ? `: ${fieldHints[name]}` : ''}`)
    .join('\n');
  const system = [
    'Je bent een medisch assistent.',
    'Vul het medische formulier in op basis van de gecontroleerde transcriptie.',
    'Gebruik ALLEEN expliciete informatie. Raad niets.',
    'Ontbreekt iets → exact "niet vermeld".',
    'Twijfel → needs_review true + korte warning.',
    'Geef source_segment_id (bijv. s3) voor elk veld met een bron.',
    'Wijzig nooit medicatienaam, dosering, links/rechts of negatie.',
    '',
    'Velden:',
    fieldList,
    '',
    'Antwoord UITSLUITEND met JSON:',
    '{ "fields": [',
    '  { "field_name": "<naam>", "value": "<waarde>", "source_segment_id": "<id of \'\'>",',
    '    "confidence": "high|medium|low", "needs_review": false, "warning": null }',
    '] }',
    'Eén object per veld. Geen extra velden.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Gecontroleerde transcriptie (per segment):\n\n' + numberedTranscript },
  ];
}

// Normalises form-fill output; derives source_sentence from segment lookup.
function normalizeForm(parsed, fieldNames, segmentById) {
  const byName = new Map();
  const list = parsed && Array.isArray(parsed.fields) ? parsed.fields : [];
  for (const f of list) if (f && f.field_name) byName.set(String(f.field_name), f);

  const fields = fieldNames.map((name) => {
    const f = byName.get(name) || {};
    let value = (f.value === null || f.value === undefined) ? '' : String(f.value);
    const empty = !value.trim() || /^niet vermeld$/i.test(value.trim());
    if (empty) value = 'niet vermeld';
    const sid = typeof f.source_segment_id === 'string' ? f.source_segment_id : '';
    const seg = sid && segmentById ? segmentById.get(sid) : null;
    const source_sentence = seg ? String(seg.text || '') : '';
    return {
      field_name: name,
      value,
      source_sentence,
      source_segment_id: sid,
      confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : (empty ? 'low' : 'medium'),
      was_inferred: f.was_inferred === true,
      needs_review: f.needs_review === true || (empty === false && f.confidence === 'low'),
      warning: typeof f.warning === 'string' && f.warning.trim() ? f.warning : null,
    };
  });

  const overall_warnings = Array.isArray(parsed?.overall_warnings)
    ? parsed.overall_warnings.filter((w) => typeof w === 'string' && w.trim())
    : [];

  return { fields, missing_fields: [], overall_warnings };
}

function extractMaxTokens(fieldCount) {
  return Math.min(1200, 200 + 60 * Math.max(1, fieldCount || 1));
}

async function extract({ id, transcript, segments, schema }) {
  const fieldNames = schema && schema.properties ? Object.keys(schema.properties) : [];
  const fieldHints = {};
  for (const name of fieldNames) {
    const def = schema.properties[name];
    if (def && def.description) fieldHints[name] = def.description;
  }

  const segmentById = new Map();
  let numbered;
  if (Array.isArray(segments) && segments.length) {
    for (const s of segments) segmentById.set(String(s.id), s);
    numbered = segments.map((s) => `${s.id}: ${s.text}`).join('\n');
  } else {
    numbered = (transcript || '').trim();
  }

  let truncated = false;
  if (numbered.length > EXTRACT_MAX_TRANSCRIPT_CHARS) {
    numbered = numbered.slice(0, EXTRACT_MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }

  const response = await chatWithRetry({
    messages: buildMessages(numbered, fieldNames, fieldHints),
    temperature: 0,
    max_tokens: extractMaxTokens(fieldNames.length),
  });
  const content = response?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonLoose(content);
  if (!parsed) {
    throw new Error('The model returned invalid JSON. Please try again.');
  }
  const data = normalizeForm(parsed, fieldNames, segmentById);
  self.postMessage({ type: 'complete', id, task: 'extract', data, truncated });
}

// Serialize jobs: the engine handles one request at a time.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'correct') {
        await correct(msg);
      } else if (msg.type === 'extract') {
        await extract(msg);
      }
    } catch (err) {
      if (isFatalGpuError(err)) resetEngine();
      self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
    }
  });
};
