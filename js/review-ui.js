// Clinician transcript review UI.
//
// Renders the corrected transcript with green/yellow/red highlights, lets the
// clinician inspect each flagged passage (raw vs corrected), edit it, and
// accept / reject / confirm corrections. Form generation is gated until every
// red passage has been reviewed (confirmed, edited, or rejected).
//
// The module owns its DOM inside a root element and mutates the passed pipeline
// object's `edits` (segment_id -> { action, after?, note?, at }) and the
// `confirmed` flag on annotations, calling back into the app to persist and to
// proceed to form filling.

import { summarizeAnnotations } from './uncertainty.js';
import { t, onLangChange } from './i18n.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function colorLabel(color) {
  return t(color === 'green' ? 'review.colorGreen' : color === 'yellow' ? 'review.colorYellow' : 'review.colorRed');
}

export function createReviewUI(root, callbacks = {}) {
  const { onChange, onProceed, onAddRule, onNotify } = callbacks;

  let pipeline = null;
  let selectedId = null;
  let showRaw = false;

  // --- Static structure ---
  root.innerHTML = '';
  const banner = el('div', 'review-banner');
  const warnings = el('div', 'review-warnings');

  const toolbar = el('div', 'review-toolbar');
  const toggleBtn = el('button', '', t('review.showRaw'));
  toggleBtn.type = 'button';
  const legend = el('div', 'review-legend');
  const proceedRow = el('div', 'review-proceed-row');
  const proceedBtn = el('button', 'primary', t('review.generateForm'));
  proceedBtn.type = 'button';
  const proceedHint = el('p', 'hint', '');
  proceedRow.append(proceedBtn, proceedHint);

  const transcriptBox = el('div', 'review-transcript');
  const editorPanel = el('div', 'review-editor hidden');
  const ruleBox = buildRuleBox();
  root.append(banner, warnings, toolbar, transcriptBox, editorPanel, ruleBox.wrap, proceedRow);

  function renderLegend() {
    legend.innerHTML =
      `<span class="seg-chip seg-green">${t('review.legendGreen')}</span>` +
      `<span class="seg-chip seg-yellow">${t('review.legendYellow')}</span>` +
      `<span class="seg-chip seg-red">${t('review.legendRed')}</span>`;
  }
  toolbar.append(toggleBtn, legend);
  renderLegend();

  toggleBtn.addEventListener('click', () => {
    if (!pipeline || !pipeline.correction) return;
    showRaw = !showRaw;
    toggleBtn.textContent = showRaw ? t('review.showCorrected') : t('review.showRaw');
    renderTranscript();
  });

  proceedBtn.addEventListener('click', () => {
    if (!pipeline) return;
    if (proceedBtn.disabled) return;
    const summary = summarizeAnnotations(pipeline.annotations);
    if (summary.redOutstanding > 0) {
      const msg = t('review.redGate', { count: summary.redOutstanding });
      proceedHint.textContent = msg;
      proceedHint.classList.add('error');
      if (onNotify) onNotify(msg, 6000);
      return;
    }
    if (onProceed) onProceed(pipeline);
  });

  function buildRuleBox() {
    const wrap = el('details', 'review-rule-box');
    const summary = el('summary', '', t('review.addRule'));
    const rowFrom = el('div', 'rule-row');
    const fromIn = el('input');
    fromIn.placeholder = t('review.ruleFrom');
    const toIn = el('input');
    toIn.placeholder = t('review.ruleTo');
    const modeSel = el('select');
    [['replace', 'review.ruleModeReplace'], ['expand', 'review.ruleModeExpand'], ['protect', 'review.ruleModeProtect']]
      .forEach(([v, key]) => { const o = el('option', '', t(key)); o.value = v; modeSel.append(o); });
    const scopeSel = el('select');
    [['session', 'review.ruleScopeSession'], ['user', 'review.ruleScopeUser']]
      .forEach(([v, key]) => { const o = el('option', '', t(key)); o.value = v; scopeSel.append(o); });
    const addBtn = el('button', '', t('review.ruleSave'));
    addBtn.type = 'button';
    rowFrom.append(fromIn, toIn, modeSel, scopeSel, addBtn);
    const note = el('p', 'hint', t('review.ruleHint'));
    wrap.append(summary, rowFrom, note);

    addBtn.addEventListener('click', async () => {
      const rule = {
        from: fromIn.value.trim(),
        to: toIn.value.trim(),
        mode: modeSel.value,
        scope: scopeSel.value,
      };
      if (!rule.from || (rule.mode !== 'protect' && !rule.to)) {
        if (onNotify) onNotify(t('review.ruleIncomplete'), 4000);
        return;
      }
      if (onAddRule) await onAddRule(rule);
      fromIn.value = ''; toIn.value = '';
      note.textContent = t('review.ruleHint');
    });
    return { wrap, summary, fromIn, toIn, modeSel, scopeSel, addBtn, note };
  }

  function refreshRuleBoxLabels() {
    ruleBox.summary.textContent = t('review.addRule');
    ruleBox.fromIn.placeholder = t('review.ruleFrom');
    ruleBox.toIn.placeholder = t('review.ruleTo');
    ruleBox.modeSel.innerHTML = '';
    [['replace', 'review.ruleModeReplace'], ['expand', 'review.ruleModeExpand'], ['protect', 'review.ruleModeProtect']]
      .forEach(([v, key]) => { const o = el('option', '', t(key)); o.value = v; ruleBox.modeSel.append(o); });
    ruleBox.scopeSel.innerHTML = '';
    [['session', 'review.ruleScopeSession'], ['user', 'review.ruleScopeUser']]
      .forEach(([v, key]) => { const o = el('option', '', t(key)); o.value = v; ruleBox.scopeSel.append(o); });
    ruleBox.addBtn.textContent = t('review.ruleSave');
    ruleBox.note.textContent = t('review.ruleHint');
  }

  // --- Rendering ---
  function annotationFor(id) {
    return (pipeline.annotations || []).find((a) => a.segment_id === id) || null;
  }
  function correctedFor(id) {
    return (pipeline.correction.segments || []).find((c) => c.segment_id === id) || null;
  }
  function rawFor(id) {
    return (pipeline.raw.segments || []).find((s) => s.id === id) || null;
  }

  function renderBanner() {
    if (!pipeline) return;
    const s = summarizeAnnotations(pipeline.annotations);
    const footer = s.redOutstanding > 0
      ? t('review.bannerRedPending', { count: s.redOutstanding })
      : t('review.bannerRedDone');
    banner.innerHTML = t('review.banner', {
      green: s.green,
      yellow: s.yellow,
      red: s.red,
      redClass: s.red ? 'banner-red' : '',
      footer,
    });
  }

  function renderWarnings() {
    if (!pipeline) return;
    const list = (pipeline.correction && pipeline.correction.globalWarnings) || [];
    const conflicts = (pipeline.correction && pipeline.correction.boundaryConflicts) || [];
    if (!list.length && !conflicts.length) { warnings.innerHTML = ''; return; }
    warnings.innerHTML = '';
    if (list.length) {
      const head = el('strong', '', t('review.warnings'));
      warnings.append(head);
      const ul = el('ul');
      for (const w of list) ul.append(el('li', '', w));
      warnings.append(ul);
    }
    if (conflicts.length) {
      const head = el('strong', '', t('review.boundaryConflicts'));
      warnings.append(head);
      const ul = el('ul');
      for (const c of conflicts) {
        const ids = Array.isArray(c.segmentIds) && c.segmentIds.length
          ? ` (${c.segmentIds.join(', ')})`
          : '';
        ul.append(el('li', c.severity === 'high' ? 'conflict-high' : '', (c.message || c.type) + ids));
      }
      warnings.append(ul);
    }
  }

  function renderTranscript() {
    transcriptBox.innerHTML = '';
    if (!pipeline || !pipeline.correction) return;
    for (const seg of pipeline.correction.segments) {
      const ann = annotationFor(seg.segment_id);
      const color = ann ? ann.color : 'green';
      const finalEdit = pipeline.edits[seg.segment_id];
      let text;
      if (showRaw) {
        const raw = rawFor(seg.segment_id);
        text = raw ? raw.text : seg.original_text;
      } else if (finalEdit && finalEdit.action === 'reject') {
        text = seg.original_text;
      } else if (finalEdit && typeof finalEdit.after === 'string' && finalEdit.after.trim()) {
        text = finalEdit.after;
      } else {
        text = seg.corrected_text;
      }
      const span = el('span', `seg seg-${color}` + (selectedId === seg.segment_id ? ' seg-selected' : ''), text + ' ');
      span.dataset.id = seg.segment_id;
      if (ann && ann.confirmed) span.classList.add('seg-confirmed');
      span.title = ann ? `${colorLabel(color)} — ${ann.triggers.join(', ') || t('review.noTriggers')}` : '';
      span.addEventListener('click', () => selectSegment(seg.segment_id));
      transcriptBox.append(span);
    }
  }

  function selectSegment(id) {
    if (!pipeline) return;
    selectedId = id;
    renderTranscript();
    renderEditor();
    editorPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderEditor() {
    if (!pipeline || !selectedId) { editorPanel.classList.add('hidden'); return; }
    const seg = correctedFor(selectedId);
    const raw = rawFor(selectedId);
    const ann = annotationFor(selectedId);
    if (!seg) { editorPanel.classList.add('hidden'); return; }
    const edit = pipeline.edits[selectedId] || {};

    editorPanel.classList.remove('hidden');
    editorPanel.innerHTML = '';

    const head = el('div', 'editor-head');
    head.append(el('span', `seg-chip seg-${ann ? ann.color : 'green'}`, ann ? colorLabel(ann.color) : ''));
    if (ann && ann.triggers.length) head.append(el('span', 'editor-triggers', ann.triggers.join(', ')));
    const closeBtn = el('button', '', t('review.close'));
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { selectedId = null; renderTranscript(); renderEditor(); });
    head.append(closeBtn);
    editorPanel.append(head);

    if (seg.reason) editorPanel.append(el('p', 'editor-reason', t('review.reason') + seg.reason));

    const cmp = el('div', 'editor-compare');
    const rawCol = el('div', 'editor-col');
    rawCol.append(el('div', 'editor-col-label', t('review.rawCol')));
    rawCol.append(el('div', 'editor-col-text', raw ? raw.text : seg.original_text));
    const corrCol = el('div', 'editor-col');
    corrCol.append(el('div', 'editor-col-label', t('review.aiCol')));
    corrCol.append(el('div', 'editor-col-text', seg.corrected_text));
    cmp.append(rawCol, corrCol);
    editorPanel.append(cmp);

    editorPanel.append(el('label', 'editor-label', t('review.finalLabel')));
    const ta = el('textarea', 'editor-textarea');
    ta.value = (edit.action === 'reject') ? seg.original_text
      : (typeof edit.after === 'string' && edit.after.length ? edit.after : seg.corrected_text);
    editorPanel.append(ta);

    const noteIn = el('input', 'editor-note');
    noteIn.placeholder = t('review.notePlaceholder');
    noteIn.value = edit.note || '';
    editorPanel.append(noteIn);

    const actions = el('div', 'editor-actions');
    const acceptBtn = el('button', 'primary', t('review.acceptAi'));
    acceptBtn.type = 'button';
    const rejectBtn = el('button', '', t('review.rejectRaw'));
    rejectBtn.type = 'button';
    const saveBtn = el('button', 'primary', t('review.saveEdit'));
    saveBtn.type = 'button';
    const confirmBtn = el('button', '', t('review.markReviewed'));
    confirmBtn.type = 'button';
    actions.append(acceptBtn, rejectBtn, saveBtn, confirmBtn);
    editorPanel.append(actions);

    const setEdit = (patch, confirm) => {
      pipeline.edits[selectedId] = { ...(pipeline.edits[selectedId] || {}), ...patch, note: noteIn.value, at: new Date().toISOString() };
      if (confirm && ann) ann.confirmed = true;
      commit();
      renderTranscript();
      renderBanner();
      renderEditor();
    };

    acceptBtn.addEventListener('click', () => setEdit({ action: 'accept', after: undefined }, true));
    rejectBtn.addEventListener('click', () => setEdit({ action: 'reject', after: undefined }, true));
    saveBtn.addEventListener('click', () => setEdit({ action: 'edit', after: ta.value }, true));
    confirmBtn.addEventListener('click', () => setEdit({ action: pipeline.edits[selectedId]?.action || 'confirm' }, true));
  }

  function commit() {
    if (onChange) onChange(pipeline);
    updateProceedState();
  }

  function updateProceedState() {
    if (!pipeline) return;
    const s = summarizeAnnotations(pipeline.annotations);
    if (s.redOutstanding > 0) {
      proceedHint.textContent = t('review.redOutstanding', { count: s.redOutstanding });
      proceedHint.classList.remove('error');
    } else {
      proceedHint.textContent = t('review.allRedReviewed');
      proceedHint.classList.remove('error');
    }
  }

  function fullRender() {
    if (!pipeline) return;
    showRaw = false;
    toggleBtn.textContent = t('review.showRaw');
    proceedBtn.textContent = t('review.generateForm');
    renderLegend();
    refreshRuleBoxLabels();
    renderBanner();
    renderWarnings();
    renderTranscript();
    renderEditor();
    updateProceedState();
  }

  onLangChange(() => {
    if (pipeline) fullRender();
    else {
      toggleBtn.textContent = t('review.showRaw');
      proceedBtn.textContent = t('review.generateForm');
      renderLegend();
      refreshRuleBoxLabels();
    }
  });

  return {
    render(p) {
      pipeline = p;
      if (!pipeline.edits) pipeline.edits = {};
      selectedId = null;
      fullRender();
    },
    clear() {
      pipeline = null;
      selectedId = null;
      banner.innerHTML = '';
      warnings.innerHTML = '';
      transcriptBox.innerHTML = '';
      editorPanel.classList.add('hidden');
      proceedHint.textContent = '';
      proceedBtn.disabled = false;
      proceedBtn.textContent = t('review.generateForm');
      toggleBtn.textContent = t('review.showRaw');
    },
    setProceedBusy(busy, label) {
      proceedBtn.disabled = !!busy;
      if (label) proceedBtn.textContent = label;
      else if (!busy) proceedBtn.textContent = t('review.generateForm');
    },
  };
}
