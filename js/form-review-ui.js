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

import { resolveSegmentChain, normalizeSegmentId } from './final-transcript.js';
import { NOT_MENTIONED } from './safety.js';
import { t, onLangChange } from './i18n.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function confLabel(c) {
  return t(c === 'high' ? 'form.confHigh' : c === 'medium' ? 'form.confMedium' : 'form.confLow') || c;
}

function colorLabel(color) {
  return t(color === 'green' ? 'form.colorGreen' : color === 'yellow' ? 'form.colorYellow' : 'form.colorRed') || color;
}

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
      templateId: form.templateId || null,
      templateName: form.templateName || null,
    };
  }
  const metaKeys = new Set([
    'fields', 'missingFields', 'missing_fields', 'overallWarnings', 'overall_warnings',
    'approvedAt', 'templateId', 'templateName',
  ]);
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
    overallWarnings: [t('form.legacyWarning')],
    approvedAt: form.approvedAt || null,
    templateId: form.templateId || null,
    templateName: form.templateName || null,
  };
}

function formFields(form) {
  return (form && Array.isArray(form.fields)) ? form.fields : [];
}

function isNotMentioned(value) {
  if (!value || !String(value).trim()) return true;
  return String(value).trim().toLowerCase() === NOT_MENTIONED.toLowerCase();
}

export function createFormReviewUI(root, callbacks = {}) {
  const { onChange, onApprove, onExport, onCopy, onCopyField, onDownloadTxt } = callbacks;
  let pipeline = null;
  let viewMode = 'review';

  root.innerHTML = '';
  const warnings = el('div', 'form-warnings');
  const fieldsWrap = el('div', 'form-fields-wrap');
  const missingWrap = el('div', 'form-missing');
  const actions = el('div', 'row form-actions form-actions-sticky');
  const modeReviewBtn = el('button', 'form-mode-btn', t('form.modeReview'));
  modeReviewBtn.type = 'button';
  const modeSummaryBtn = el('button', 'form-mode-btn', t('form.modeSummary'));
  modeSummaryBtn.type = 'button';
  const approveBtn = el('button', 'primary', t('form.approve'));
  approveBtn.type = 'button';
  const copyWrap = el('div', 'form-copy-wrap');
  const copyBtn = el('button', '', t('form.copy'));
  copyBtn.type = 'button';
  const copyMenu = el('div', 'form-copy-menu hidden');
  const copyLabeledBtn = el('button', 'button-as-link', t('form.copyLabeled'));
  copyLabeledBtn.type = 'button';
  const copySoepBtn = el('button', 'button-as-link', t('form.copySoep'));
  copySoepBtn.type = 'button';
  copyMenu.append(copyLabeledBtn, copySoepBtn);
  copyWrap.append(copyBtn, copyMenu);
  const downloadTxtBtn = el('button', '', t('form.downloadTxt'));
  downloadTxtBtn.type = 'button';
  const exportBtn = el('button', '', t('form.exportJson'));
  exportBtn.type = 'button';
  const statusEl = el('span', 'form-approval-status', '');
  const modeGroup = el('span', 'form-mode-group');
  modeGroup.append(modeReviewBtn, modeSummaryBtn);
  actions.append(modeGroup, approveBtn, copyWrap, downloadTxtBtn, exportBtn, statusEl);
  root.append(warnings, fieldsWrap, missingWrap, actions);

  function setViewMode(mode) {
    viewMode = mode === 'summary' ? 'summary' : 'review';
    modeReviewBtn.classList.toggle('active', viewMode === 'review');
    modeSummaryBtn.classList.toggle('active', viewMode === 'summary');
    if (pipeline && pipeline.form) {
      renderWarnings();
      if (viewMode === 'summary') renderSummaryFields();
      else renderFields();
      renderMissing();
    }
  }

  modeReviewBtn.addEventListener('click', () => setViewMode('review'));
  modeSummaryBtn.addEventListener('click', () => setViewMode('summary'));

  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => copyMenu.classList.add('hidden'));

  async function doCopy(format) {
    copyMenu.classList.add('hidden');
    if (!pipeline || !pipeline.form) return;
    if (onCopy) await onCopy(pipeline, format);
  }
  copyLabeledBtn.addEventListener('click', (e) => { e.stopPropagation(); doCopy('labeled'); });
  copySoepBtn.addEventListener('click', (e) => { e.stopPropagation(); doCopy('soep'); });

  downloadTxtBtn.addEventListener('click', () => {
    if (!pipeline || !pipeline.form) return;
    if (onDownloadTxt) onDownloadTxt(pipeline);
  });

  approveBtn.addEventListener('click', () => {
    if (!pipeline || !pipeline.form) return;
    const needsReview = formFields(pipeline.form).filter((f) => f.needs_review).length;
    if (needsReview && !window.confirm(t('form.approveConfirm', { count: needsReview }))) return;
    pipeline.form.approvedAt = new Date().toISOString();
    renderStatus();
    setViewMode('summary');
    if (onApprove) onApprove(pipeline);
  });
  exportBtn.addEventListener('click', () => {
    if (!pipeline) return;
    if (onExport) onExport(pipeline);
    else exportFinalForm(pipeline);
  });

  function refreshActionLabels() {
    modeReviewBtn.textContent = t('form.modeReview');
    modeSummaryBtn.textContent = t('form.modeSummary');
    approveBtn.textContent = t('form.approve');
    copyBtn.textContent = t('form.copy');
    copyLabeledBtn.textContent = t('form.copyLabeled');
    copySoepBtn.textContent = t('form.copySoep');
    downloadTxtBtn.textContent = t('form.downloadTxt');
    exportBtn.textContent = t('form.exportJson');
  }

  function renderWarnings() {
    warnings.innerHTML = '';
    if (!pipeline || !pipeline.form) return;
    const list = [...(pipeline.form.overallWarnings || [])];
    const needsReview = formFields(pipeline.form).filter((f) => f.needs_review).length;
    if (needsReview) list.unshift(t('form.fieldsNeedReview', { count: needsReview }));
    if (!list.length) return;
    warnings.append(el('strong', '', t('form.warnings')));
    const ul = el('ul');
    for (const w of list) ul.append(el('li', '', w));
    warnings.append(ul);
  }

  function enrichFieldSource(field) {
    if (!pipeline) return;
    const normSid = normalizeSegmentId(field.source_segment_id);
    if (!normSid) return;
    field.source_segment_id = normSid;
    if (field.source_sentence && field.source_sentence.trim()) return;
    const chain = resolveSegmentChain(normSid, {
      rawSegments: pipeline.raw.segments,
      correctedSegments: pipeline.correction ? pipeline.correction.segments : [],
      finalSegments: pipeline.finalTranscript ? pipeline.finalTranscript.segments : [],
      annotations: pipeline.annotations,
      edits: pipeline.edits,
    });
    if (!chain) return;
    field.source_sentence = chain.final || chain.corrected || chain.raw || '';
  }

  function renderFields() {
    fieldsWrap.innerHTML = '';
    if (!pipeline || !pipeline.form) return;
    for (const field of formFields(pipeline.form)) {
      enrichFieldSource(field);
      const wrap = el('div', 'tform-field' + (field.needs_review ? ' needs-review' : ''));

      const labelRow = el('div', 'tform-label-row');
      labelRow.append(el('label', '', field.field_name));
      const badges = el('span', 'tform-badges');
      badges.append(el('span', `conf-badge conf-${field.confidence}`, t('form.confidence') + confLabel(field.confidence)));
      if (field.was_inferred) badges.append(el('span', 'tform-flag inferred', t('form.inferred')));
      if (field.needs_review) badges.append(el('span', 'tform-flag review', t('form.needsReview')));
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

      const normSid = normalizeSegmentId(field.source_segment_id);
      if (normSid && normSid !== field.source_segment_id) field.source_segment_id = normSid;

      if (field.source_sentence || field.source_segment_id) {
        const teaserText = field.source_sentence
          ? field.source_sentence
          : t('form.sourceNoSentence');
        const teaser = el('p', 'tform-source-teaser');
        if (field.source_segment_id) {
          teaser.append(
            el('span', 'tform-source-seg', `${t('form.sourceSegment')}: ${field.source_segment_id}`),
            document.createTextNode(' — ' + teaserText),
          );
        } else {
          teaser.textContent = teaserText;
        }
        wrap.append(teaser);
      }

      const srcBtn = el('button', 'button-as-link tform-source-btn', t('form.showSource'));
      srcBtn.type = 'button';
      const srcPanel = el('div', 'tform-source hidden');
      srcBtn.addEventListener('click', () => {
        const isHidden = srcPanel.classList.toggle('hidden');
        srcBtn.textContent = isHidden ? t('form.showSource') : t('form.hideSource');
        if (!isHidden) {
          srcPanel.dataset.built = '';
          buildSourcePanel(srcPanel, field);
          srcPanel.dataset.built = '1';
        }
      });
      wrap.append(srcBtn, srcPanel);
      fieldsWrap.append(wrap);
    }
  }

  function renderSummaryFields() {
    fieldsWrap.innerHTML = '';
    if (!pipeline || !pipeline.form) return;

    if (pipeline.form.templateName) {
      const meta = el('p', 'form-summary-template', t('form.templateUsed', { name: pipeline.form.templateName }));
      fieldsWrap.append(meta);
    }

    for (const field of formFields(pipeline.form)) {
      const empty = isNotMentioned(field.value);
      const wrap = el('div', 'form-summary-field' + (field.needs_review ? ' needs-review' : '') + (empty ? ' empty-value' : ''));

      const head = el('div', 'form-summary-head');
      head.append(el('strong', 'form-summary-label', field.field_name));
      const flags = el('span', 'form-summary-flags');
      if (field.needs_review) flags.append(el('span', 'tform-flag review', t('form.needsReview')));
      if (empty) flags.append(el('span', 'tform-flag empty-flag', NOT_MENTIONED));
      if (flags.childNodes.length) head.append(flags);
      wrap.append(head);

      const valueEl = el('div', 'form-summary-value', empty ? NOT_MENTIONED : field.value);
      wrap.append(valueEl);

      const copyFieldBtn = el('button', 'button-as-link form-copy-field-btn', t('form.copyField'));
      copyFieldBtn.type = 'button';
      copyFieldBtn.addEventListener('click', async () => {
        if (onCopyField) await onCopyField(field);
      });
      wrap.append(copyFieldBtn);
      fieldsWrap.append(wrap);
    }
  }

  function buildSourcePanel(panel, field) {
    panel.innerHTML = '';
    const normSid = normalizeSegmentId(field.source_segment_id);
    if (normSid && normSid !== field.source_segment_id) field.source_segment_id = normSid;

    const stated = field.was_inferred ? t('form.sourceInferred') : t('form.sourceStated');
    panel.append(traceRow(t('form.sourceStatus'), stated));
    panel.append(traceRow(t('form.sourceConfidence'), confLabel(field.confidence)));
    panel.append(traceRow(t('form.sourceSentence'), field.source_sentence || '—'));

    const chain = normSid
      ? resolveSegmentChain(normSid, {
          rawSegments: pipeline.raw.segments,
          correctedSegments: pipeline.correction ? pipeline.correction.segments : [],
          finalSegments: pipeline.finalTranscript ? pipeline.finalTranscript.segments : [],
          annotations: pipeline.annotations,
          edits: pipeline.edits,
        })
      : null;

    if (chain) {
      panel.append(traceRow(t('form.sourceSegment'), field.source_segment_id));
      panel.append(traceRow(t('form.sourceRaw'), chain.raw || '—'));
      panel.append(traceRow(t('form.sourceAi'), chain.corrected || '—'));
      panel.append(traceRow(t('form.sourceFinal'), chain.final || '—'));
      panel.append(traceRow(t('form.sourceEdited'), chain.edited ? t('form.yes') : t('form.no')));
      panel.append(traceRow(t('form.sourcePriorFlag'), chain.color ? colorLabel(chain.color) : '—'));
    } else {
      panel.append(el('p', 'hint', t('form.sourceNoSegment')));
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
    missingWrap.append(el('strong', '', t('form.missingFields')));
    const ul = el('ul');
    for (const m of list) ul.append(el('li', '', `${m.field_name}: ${m.reason}`));
    missingWrap.append(ul);
  }

  function renderStatus() {
    if (!pipeline || !pipeline.form) return;
    if (pipeline.form.approvedAt) {
      statusEl.textContent = t('form.approvedAt', { date: new Date(pipeline.form.approvedAt).toLocaleString() });
      statusEl.classList.add('approved');
    } else {
      const n = formFields(pipeline.form).filter((f) => f.needs_review).length;
      statusEl.textContent = n ? t('form.notApprovedReview', { count: n }) : t('form.notApproved');
      statusEl.classList.remove('approved');
    }
  }

  function showLoading(message) {
    warnings.innerHTML = '';
    missingWrap.innerHTML = '';
    fieldsWrap.innerHTML = '';
    statusEl.textContent = '';
    fieldsWrap.append(el('p', 'empty-state loading', message || t('form.extracting')));
  }

  function showError(message) {
    warnings.innerHTML = '';
    missingWrap.innerHTML = '';
    fieldsWrap.innerHTML = '';
    statusEl.textContent = '';
    fieldsWrap.append(el('p', 'empty-state error', message));
  }

  function showEmpty() {
    warnings.innerHTML = '';
    missingWrap.innerHTML = '';
    fieldsWrap.innerHTML = '';
    statusEl.textContent = '';
    fieldsWrap.append(el('p', 'empty-state', t('form.empty')));
  }

  function fullRender() {
    refreshActionLabels();
    renderWarnings();
    if (viewMode === 'summary') renderSummaryFields();
    else renderFields();
    renderMissing();
    renderStatus();
  }

  onLangChange(() => {
    if (pipeline) fullRender();
    else {
      refreshActionLabels();
      if (fieldsWrap.querySelector('.empty-state') && !fieldsWrap.querySelector('.tform-field')) {
        showEmpty();
      }
    }
  });

  return {
    render(p, opts = {}) {
      pipeline = p;
      if (!pipeline || !pipeline.form) { this.clear(); return; }
      pipeline.form = normalizePipelineForm(pipeline.form);
      if (!pipeline.form) { this.clear(); return; }
      if (opts.mode) {
        viewMode = opts.mode === 'summary' ? 'summary' : 'review';
      } else if (pipeline.form.approvedAt) {
        viewMode = 'summary';
      } else {
        viewMode = 'review';
      }
      modeReviewBtn.classList.toggle('active', viewMode === 'review');
      modeSummaryBtn.classList.toggle('active', viewMode === 'summary');
      fullRender();
    },
    setMode(mode) {
      setViewMode(mode);
    },
    getMode() {
      return viewMode;
    },
    clear() {
      pipeline = null;
      refreshActionLabels();
      showEmpty();
    },
    showLoading(message) {
      pipeline = null;
      refreshActionLabels();
      showLoading(message);
    },
    showError(message) {
      pipeline = null;
      refreshActionLabels();
      showError(message);
    },
  };
}

// Builds a full-provenance export object and triggers a JSON download.
export function exportFinalForm(pipeline, filename) {
  const out = {
    exportedAt: new Date().toISOString(),
    title: pipeline.title || t('saved.untitled'),
    language: pipeline.language || null,
    rawTranscript: pipeline.raw ? pipeline.raw.text : '',
    correctedTranscript: pipeline.correction ? pipeline.correction.correctedText : '',
    finalTranscript: pipeline.finalTranscript ? pipeline.finalTranscript.text : '',
    segments: pipeline.raw ? pipeline.raw.segments : [],
    annotations: pipeline.annotations || [],
    editLog: pipeline.editLog || [],
    form: pipeline.form || null,
    performanceMetrics: pipeline.metrics || null,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || ((pipeline.title || 'medical-form').replace(/\s+/g, '_') + '.json');
  a.click();
  URL.revokeObjectURL(a.href);
}
