// Form review UI with source traceability.
//
// Renders the structured, traceable form output. Each field is editable and
// shows its confidence/warnings plus a click-to-expand "source chain" that lets
// the clinician verify exactly where the value came from:
//   raw Whisper sentence -> LLM-corrected -> final clinician-reviewed version,
//   whether it was edited, its prior green/yellow/red flag, and whether the
//   value was directly stated or inferred.
//
// Final approval records an approval timestamp; export produces a JSON file with
// the full provenance (all three transcript versions, edit log, annotations,
// and the traceable form).

import { resolveSegmentChain } from './final-transcript.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CONF_LABEL = { high: 'hoog', medium: 'middel', low: 'laag' };
const COLOR_LABEL = { green: 'groen', yellow: 'geel', red: 'rood' };

// Normalises stored form data into the traceable shape. Older saves used a flat
// { "Field name": "value" } object without fields[] or source metadata.
export function normalizePipelineForm(form) {
  if (!form || typeof form !== 'object') return null;
  if (Array.isArray(form.fields)) {
    return {
      fields: form.fields,
      missingFields: form.missingFields || form.missing_fields || [],
      overallWarnings: form.overallWarnings || form.overall_warnings || [],
      approvedAt: form.approvedAt || null,
    };
  }
  const metaKeys = new Set(['fields', 'missingFields', 'missing_fields', 'overallWarnings', 'overall_warnings', 'approvedAt']);
  const legacy = Object.entries(form).filter(([k]) => !metaKeys.has(k));
  if (!legacy.length) return null;
  return {
    fields: legacy.map(([field_name, value]) => ({
      field_name,
      value: value === null || value === undefined ? '' : String(value),
      source_sentence: '',
      source_segment_id: '',
      confidence: 'medium',
      was_inferred: false,
      needs_review: false,
      warning: null,
    })),
    missingFields: [],
    overallWarnings: ['Opgeslagen in oud formaat — geen brontraceerbaarheid. Genereer het formulier opnieuw voor bronnen per veld.'],
    approvedAt: form.approvedAt || null,
  };
}

function formFields(form) {
  return (form && Array.isArray(form.fields)) ? form.fields : [];
}

export function createFormReviewUI(root, callbacks = {}) {
  const { onChange, onApprove, onExport } = callbacks;
  let pipeline = null;

  root.innerHTML = '';
  const warnings = el('div', 'form-warnings');
  const fieldsWrap = el('div', 'form-fields-wrap');
  const missingWrap = el('div', 'form-missing');
  const actions = el('div', 'row form-actions');
  const approveBtn = el('button', 'primary', 'Formulier goedkeuren'); approveBtn.type = 'button';
  const exportBtn = el('button', '', 'Exporteer .json'); exportBtn.type = 'button';
  const statusEl = el('span', 'form-approval-status', '');
  actions.append(approveBtn, exportBtn, statusEl);
  root.append(warnings, fieldsWrap, missingWrap, actions);

  approveBtn.addEventListener('click', () => {
    if (!pipeline || !pipeline.form) return;
    pipeline.form.approvedAt = new Date().toISOString();
    renderStatus();
    if (onApprove) onApprove(pipeline);
  });
  exportBtn.addEventListener('click', () => {
    if (!pipeline) return;
    if (onExport) onExport(pipeline);
    else exportFinalForm(pipeline);
  });

  function renderWarnings() {
    warnings.innerHTML = '';
    if (!pipeline || !pipeline.form) return;
    const list = [...(pipeline.form.overallWarnings || [])];
    const needsReview = formFields(pipeline.form).filter((f) => f.needs_review).length;
    if (needsReview) list.unshift(`${needsReview} veld(en) gemarkeerd voor controle.`);
    if (!list.length) return;
    warnings.append(el('strong', '', 'Waarschuwingen:'));
    const ul = el('ul');
    for (const w of list) ul.append(el('li', '', w));
    warnings.append(ul);
  }

  function renderFields() {
    fieldsWrap.innerHTML = '';
    if (!pipeline || !pipeline.form) return;
    for (const field of formFields(pipeline.form)) {
      const wrap = el('div', 'tform-field' + (field.needs_review ? ' needs-review' : ''));

      const labelRow = el('div', 'tform-label-row');
      labelRow.append(el('label', '', field.field_name));
      const badges = el('span', 'tform-badges');
      badges.append(el('span', `conf-badge conf-${field.confidence}`, 'zekerheid: ' + (CONF_LABEL[field.confidence] || field.confidence)));
      if (field.was_inferred) badges.append(el('span', 'tform-flag inferred', 'afgeleid'));
      if (field.needs_review) badges.append(el('span', 'tform-flag review', 'controleer'));
      labelRow.append(badges);
      wrap.append(labelRow);

      const ta = el('textarea', 'tform-value');
      ta.value = field.value;
      ta.addEventListener('input', () => {
        field.value = ta.value;
        if (onChange) onChange(pipeline);
      });
      wrap.append(ta);

      if (field.warning) wrap.append(el('p', 'tform-warning', field.warning));

      const srcBtn = el('button', 'button-as-link', 'Toon bron'); srcBtn.type = 'button';
      const srcPanel = el('div', 'tform-source hidden');
      srcBtn.addEventListener('click', () => {
        const isHidden = srcPanel.classList.toggle('hidden');
        srcBtn.textContent = isHidden ? 'Toon bron' : 'Verberg bron';
        if (!isHidden && !srcPanel.dataset.built) {
          buildSourcePanel(srcPanel, field);
          srcPanel.dataset.built = '1';
        }
      });
      wrap.append(srcBtn, srcPanel);
      fieldsWrap.append(wrap);
    }
  }

  function buildSourcePanel(panel, field) {
    panel.innerHTML = '';
    const stated = field.was_inferred ? 'Afgeleid (niet letterlijk genoemd)' : 'Letterlijk vermeld';
    panel.append(traceRow('Status', stated));
    panel.append(traceRow('Zekerheid', CONF_LABEL[field.confidence] || field.confidence));
    panel.append(traceRow('Bronzin (AI)', field.source_sentence || '—'));

    const chain = field.source_segment_id
      ? resolveSegmentChain(field.source_segment_id, {
          rawSegments: pipeline.raw.segments,
          correctedSegments: pipeline.correction ? pipeline.correction.segments : [],
          finalSegments: pipeline.finalTranscript ? pipeline.finalTranscript.segments : [],
          annotations: pipeline.annotations,
          edits: pipeline.edits,
        })
      : null;

    if (chain) {
      panel.append(traceRow('Segment', field.source_segment_id));
      panel.append(traceRow('Ruwe Whisper-tekst', chain.raw || '—'));
      panel.append(traceRow('AI-correctie', chain.corrected || '—'));
      panel.append(traceRow('Definitieve tekst', chain.final || '—'));
      panel.append(traceRow('Bewerkt door clinicus', chain.edited ? 'ja' : 'nee'));
      panel.append(traceRow('Eerdere markering', chain.color ? COLOR_LABEL[chain.color] : '—'));
    } else {
      panel.append(el('p', 'hint', 'Geen specifiek bronsegment gekoppeld. Controleer de bronzin hierboven tegen de transcriptie.'));
    }
  }

  function traceRow(label, value) {
    const row = el('div', 'trace-row');
    row.append(el('span', 'trace-label', label));
    row.append(el('span', 'trace-value', value));
    return row;
  }

  function renderMissing() {
    missingWrap.innerHTML = '';
    if (!pipeline || !pipeline.form) return;
    const list = pipeline.form.missingFields || [];
    if (!list.length) return;
    missingWrap.append(el('strong', '', 'Ontbrekende velden:'));
    const ul = el('ul');
    for (const m of list) ul.append(el('li', '', `${m.field_name}: ${m.reason}`));
    missingWrap.append(ul);
  }

  function renderStatus() {
    if (!pipeline || !pipeline.form) return;
    if (pipeline.form.approvedAt) {
      statusEl.textContent = 'Goedgekeurd op ' + new Date(pipeline.form.approvedAt).toLocaleString();
      statusEl.classList.add('approved');
    } else {
      const n = formFields(pipeline.form).filter((f) => f.needs_review).length;
      statusEl.textContent = n ? `Nog niet goedgekeurd — ${n} veld(en) te controleren.` : 'Nog niet goedgekeurd.';
      statusEl.classList.remove('approved');
    }
  }

  return {
    render(p) {
      pipeline = p;
      if (!pipeline || !pipeline.form) { this.clear(); return; }
      pipeline.form = normalizePipelineForm(pipeline.form);
      if (!pipeline.form) { this.clear(); return; }
      renderWarnings();
      renderFields();
      renderMissing();
      renderStatus();
    },
    clear() {
      pipeline = null;
      warnings.innerHTML = '';
      fieldsWrap.innerHTML = '';
      missingWrap.innerHTML = '';
      statusEl.textContent = '';
    },
  };
}

// Builds a full-provenance export object and triggers a JSON download.
export function exportFinalForm(pipeline, filename) {
  const out = {
    exportedAt: new Date().toISOString(),
    title: pipeline.title || 'Untitled',
    language: pipeline.language || null,
    rawTranscript: pipeline.raw ? pipeline.raw.text : '',
    correctedTranscript: pipeline.correction ? pipeline.correction.correctedText : '',
    finalTranscript: pipeline.finalTranscript ? pipeline.finalTranscript.text : '',
    segments: pipeline.raw ? pipeline.raw.segments : [],
    annotations: pipeline.annotations || [],
    editLog: pipeline.editLog || [],
    form: pipeline.form || null,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || ((pipeline.title || 'medical-form').replace(/\s+/g, '_') + '.json');
  a.click();
  URL.revokeObjectURL(a.href);
}
