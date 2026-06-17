// Lightweight performance collector for pipeline steps: time, byte sizes, JS heap.

import { t } from './i18n.js';

const textEncoder = new TextEncoder();

export function utf8ByteLength(str) {
  if (!str) return 0;
  return textEncoder.encode(String(str)).length;
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

export function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatMemory(n) {
  if (n == null || Number.isNaN(n)) return t('perf.unavailable');
  const sign = n >= 0 ? '+' : '';
  return `${sign}${formatBytes(Math.abs(n))}`;
}

export function snapshotHeap() {
  const mem = performance.memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') {
    return { available: false, heapUsedBefore: null, heapUsedAfter: null, heapDelta: null };
  }
  return { available: true, heapUsed: mem.usedJSHeapSize };
}

function buildMemoryRecord(before, after) {
  if (!before?.available && !after?.available) {
    return { available: false, heapUsedBefore: null, heapUsedAfter: null, heapDelta: null };
  }
  const heapUsedBefore = before?.heapUsed ?? null;
  const heapUsedAfter = after?.heapUsed ?? null;
  const heapDelta = (heapUsedBefore != null && heapUsedAfter != null)
    ? heapUsedAfter - heapUsedBefore
    : null;
  return { available: heapUsedBefore != null || heapUsedAfter != null, heapUsedBefore, heapUsedAfter, heapDelta };
}

export function createMetricsRun({ phase, meta = {} } = {}) {
  return {
    phase: phase || 'unknown',
    startedAt: new Date().toISOString(),
    completedAt: null,
    meta,
    steps: [],
    totals: null,
  };
}

export function recordStep(run, stepId, label, data = {}) {
  if (!run) return null;
  const step = {
    id: stepId,
    label: label || stepId,
    durationMs: data.durationMs ?? 0,
    spaceBytes: data.spaceBytes || {},
    memory: data.memory || buildMemoryRecord(null, null),
    meta: data.meta || {},
  };
  run.steps.push(step);
  return step;
}

export async function measureStep(run, stepId, label, fn, spaceHints = {}) {
  const { meta, _fromResult, ...baseSpace } = spaceHints;
  const memBefore = snapshotHeap();
  const t0 = performance.now();
  let result;
  let thrown;
  try {
    result = await fn();
  } catch (err) {
    thrown = err;
  }
  const durationMs = performance.now() - t0;
  const memAfter = snapshotHeap();
  const spaceBytes = { ...baseSpace };
  if (typeof _fromResult === 'function' && !thrown) {
    Object.assign(spaceBytes, _fromResult(result) || {});
  }
  recordStep(run, stepId, label, {
    durationMs,
    spaceBytes,
    memory: buildMemoryRecord(memBefore, memAfter),
    meta: meta || {},
  });
  if (thrown) throw thrown;
  return result;
}

export function measureStepSync(run, stepId, label, fn, spaceHints = {}) {
  const { meta, _fromResult, ...baseSpace } = spaceHints;
  const memBefore = snapshotHeap();
  const t0 = performance.now();
  let result;
  let thrown;
  try {
    result = fn();
  } catch (err) {
    thrown = err;
  }
  const durationMs = performance.now() - t0;
  const memAfter = snapshotHeap();
  const spaceBytes = { ...baseSpace };
  if (typeof _fromResult === 'function' && !thrown) {
    Object.assign(spaceBytes, _fromResult(result) || {});
  }
  recordStep(run, stepId, label, {
    durationMs,
    spaceBytes,
    memory: buildMemoryRecord(memBefore, memAfter),
    meta: meta || {},
  });
  if (thrown) throw thrown;
  return result;
}

function sumSpaceBytes(steps) {
  const totals = {};
  for (const step of steps) {
    for (const [k, v] of Object.entries(step.spaceBytes || {})) {
      if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
    }
  }
  return totals;
}

export function finalizeRun(run) {
  if (!run) return null;
  run.completedAt = new Date().toISOString();
  run.totals = {
    durationMs: run.steps.reduce((s, step) => s + (step.durationMs || 0), 0),
    spaceBytes: sumSpaceBytes(run.steps),
    stepCount: run.steps.length,
  };
  return run;
}

export function mergeMetrics(existing, phase, run) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  if (run) {
    finalizeRun(run);
    base[phase] = run;
  }
  base.lastUpdated = new Date().toISOString();
  return base;
}

function formatSpaceCell(spaceBytes) {
  if (!spaceBytes || !Object.keys(spaceBytes).length) return '—';
  const parts = [];
  const labels = {
    input: 'in',
    output: 'out',
    audioPcm: 'PCM',
    transcriptUtf8: 'text',
    download: 'dl',
    promptUtf8: 'prompt',
    responseUtf8: 'resp',
    segmentCount: null,
    rulesApplied: null,
    fieldCount: null,
    audioDurationSec: null,
    audioSamples: null,
  };
  for (const [k, v] of Object.entries(spaceBytes)) {
    if (k === 'segmentCount' || k === 'rulesApplied' || k === 'fieldCount') {
      parts.push(`${k.replace('Count', '')}: ${v}`);
    } else if (k === 'audioDurationSec') {
      parts.push(`${Number(v).toFixed(1)}s audio`);
    } else if (typeof v === 'number') {
      const lbl = labels[k];
      parts.push(lbl ? `${lbl} ${formatBytes(v)}` : `${k} ${formatBytes(v)}`);
    }
  }
  return parts.join(', ') || '—';
}

function formatMemoryCell(memory) {
  if (!memory?.available) return t('perf.unavailable');
  if (memory.heapDelta != null) return formatMemory(memory.heapDelta);
  if (memory.heapUsedAfter != null) return formatBytes(memory.heapUsedAfter);
  return t('perf.unavailable');
}

const PHASE_LABELS = {
  transcription: 'perf.phaseTranscription',
  correction: 'perf.phaseCorrection',
  form: 'perf.phaseForm',
};

function renderPhaseTable(phaseKey, phaseRun, container) {
  if (!phaseRun?.steps?.length) return;
  const section = document.createElement('div');
  section.className = 'perf-phase';
  const heading = document.createElement('h4');
  heading.className = 'perf-phase-title';
  const phaseLabel = PHASE_LABELS[phaseKey] ? t(PHASE_LABELS[phaseKey]) : phaseKey;
  const totalMs = phaseRun.totals?.durationMs ?? phaseRun.steps.reduce((s, x) => s + (x.durationMs || 0), 0);
  heading.textContent = `${phaseLabel} — ${t('perf.total')}: ${formatMs(totalMs)}`;
  section.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'perf-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>${escapeHtml(t('perf.step'))}</th>
    <th>${escapeHtml(t('perf.time'))}</th>
    <th>${escapeHtml(t('perf.space'))}</th>
    <th>${escapeHtml(t('perf.memory'))}</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const step of phaseRun.steps) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(step.label || step.id)}</td>
      <td>${escapeHtml(formatMs(step.durationMs))}</td>
      <td>${escapeHtml(formatSpaceCell(step.spaceBytes))}</td>
      <td>${escapeHtml(formatMemoryCell(step.memory))}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  container.appendChild(section);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMetricsTable(metrics, root) {
  if (!root) return;
  root.innerHTML = '';
  if (!metrics || typeof metrics !== 'object') {
    root.closest('.perf-panel')?.classList.add('hidden');
    return;
  }
  const phases = ['transcription', 'correction', 'form'];
  const hasAny = phases.some((p) => metrics[p]?.steps?.length);
  const panel = root.closest('.perf-panel');
  if (!hasAny) {
    panel?.classList.add('hidden');
    return;
  }
  panel?.classList.remove('hidden');
  for (const phaseKey of phases) {
    renderPhaseTable(phaseKey, metrics[phaseKey], root);
  }
}

export function sumFileProgressBytes(fileProgressMap) {
  let loaded = 0;
  if (!fileProgressMap) return 0;
  for (const p of fileProgressMap.values()) {
    loaded += p.loaded || 0;
  }
  return loaded;
}
