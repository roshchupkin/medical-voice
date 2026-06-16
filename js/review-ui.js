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

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const COLOR_LABEL = { green: 'Betrouwbaar', yellow: 'Controleer', red: 'Hoog risico' };

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
  const toggleBtn = el('button', '', 'Toon ruwe transcriptie');
  toggleBtn.type = 'button';
  const legend = el('div', 'review-legend');
  legend.innerHTML =
    '<span class="seg-chip seg-green">groen: betrouwbaar</span>' +
    '<span class="seg-chip seg-yellow">geel: controleer</span>' +
    '<span class="seg-chip seg-red">rood: hoog risico</span>';
  toolbar.append(toggleBtn, legend);

  const transcriptBox = el('div', 'review-transcript');
  const editorPanel = el('div', 'review-editor hidden');
  const ruleBox = buildRuleBox();
  const proceedRow = el('div', 'review-proceed-row');
  const proceedBtn = el('button', 'primary', 'Genereer formulier');
  proceedBtn.type = 'button';
  const proceedHint = el('p', 'hint', '');
  proceedRow.append(proceedBtn, proceedHint);

  root.append(banner, warnings, toolbar, transcriptBox, editorPanel, ruleBox.wrap, proceedRow);

  toggleBtn.addEventListener('click', () => {
    if (!pipeline || !pipeline.correction) return;
    showRaw = !showRaw;
    toggleBtn.textContent = showRaw ? 'Toon gecorrigeerde transcriptie' : 'Toon ruwe transcriptie';
    renderTranscript();
  });

  proceedBtn.addEventListener('click', () => {
    if (!pipeline) return;
    if (proceedBtn.disabled) return;
    const summary = summarizeAnnotations(pipeline.annotations);
    if (summary.redOutstanding > 0) {
      const msg = `Review all ${summary.redOutstanding} red passage(s) before generating the form. Click each red highlight and confirm or edit it.`;
      proceedHint.textContent = msg;
      proceedHint.classList.add('error');
      if (onNotify) onNotify(msg, 6000);
      return;
    }
    if (onProceed) onProceed(pipeline);
  });

  function buildRuleBox() {
    const wrap = el('details', 'review-rule-box');
    const summary = el('summary', '', 'Correctieregel toevoegen (lokaal)');
    const rowFrom = el('div', 'rule-row');
    const fromIn = el('input'); fromIn.placeholder = 'van (bijv. metformien)';
    const toIn = el('input'); toIn.placeholder = 'naar (bijv. metformine)';
    const modeSel = el('select');
    [['replace', 'vervang'], ['expand', 'afkorting uitbreiden'], ['protect', 'beschermen (niet wijzigen)']]
      .forEach(([v, t]) => { const o = el('option', '', t); o.value = v; modeSel.append(o); });
    const scopeSel = el('select');
    [['session', 'deze sessie'], ['user', 'mijn account']]
      .forEach(([v, t]) => { const o = el('option', '', t); o.value = v; scopeSel.append(o); });
    const addBtn = el('button', '', 'Opslaan'); addBtn.type = 'button';
    rowFrom.append(fromIn, toIn, modeSel, scopeSel, addBtn);
    const note = el('p', 'hint', 'Vervang/afkorting wordt vóór de AI-correctie toegepast. Beschermde termen worden nooit gewijzigd.');
    wrap.append(summary, rowFrom, note);

    addBtn.addEventListener('click', async () => {
      const rule = {
        from: fromIn.value.trim(),
        to: toIn.value.trim(),
        mode: modeSel.value,
        scope: scopeSel.value,
      };
      if (!rule.from || (rule.mode !== 'protect' && !rule.to)) return;
      if (onAddRule) await onAddRule(rule);
      fromIn.value = ''; toIn.value = '';
      note.textContent = 'Regel opgeslagen. Klik op "Verbeter opnieuw" om hem toe te passen.';
    });
    return { wrap };
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
    banner.innerHTML =
      `Deze transcriptie bevat <strong>${s.green}</strong> groene correctie(s), ` +
      `<strong>${s.yellow}</strong> gele onzekere passage(s) en ` +
      `<strong class="${s.red ? 'banner-red' : ''}">${s.red}</strong> rode hoog-risico passage(s). ` +
      (s.redOutstanding > 0
        ? `Beoordeel alle rode passages voordat u het formulier genereert (${s.redOutstanding} resterend).`
        : 'Alle rode passages zijn beoordeeld.');
  }

  function renderWarnings() {
    if (!pipeline) return;
    const list = (pipeline.correction && pipeline.correction.globalWarnings) || [];
    const conflicts = (pipeline.correction && pipeline.correction.boundaryConflicts) || [];
    if (!list.length && !conflicts.length) { warnings.innerHTML = ''; return; }
    warnings.innerHTML = '';
    if (list.length) {
      const head = el('strong', '', 'Waarschuwingen:');
      warnings.append(head);
      const ul = el('ul');
      for (const w of list) ul.append(el('li', '', w));
      warnings.append(ul);
    }
    if (conflicts.length) {
      const head = el('strong', '', 'Grenzen tussen correctiedelen:');
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
      span.title = ann ? `${COLOR_LABEL[color]} — ${ann.triggers.join(', ') || 'geen specifieke triggers'}` : '';
      span.addEventListener('click', () => selectSegment(seg.segment_id));
      transcriptBox.append(span);
    }
  }

  function selectSegment(id) {
    if (!pipeline) return;
    selectedId = id;
    renderTranscript();
    renderEditor();
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
    head.append(el('span', `seg-chip seg-${ann ? ann.color : 'green'}`, ann ? COLOR_LABEL[ann.color] : ''));
    if (ann && ann.triggers.length) head.append(el('span', 'editor-triggers', ann.triggers.join(', ')));
    const closeBtn = el('button', '', 'Sluiten'); closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { selectedId = null; renderTranscript(); renderEditor(); });
    head.append(closeBtn);
    editorPanel.append(head);

    if (seg.reason) editorPanel.append(el('p', 'editor-reason', 'Reden: ' + seg.reason));

    const cmp = el('div', 'editor-compare');
    const rawCol = el('div', 'editor-col');
    rawCol.append(el('div', 'editor-col-label', 'Ruwe transcriptie (Whisper)'));
    rawCol.append(el('div', 'editor-col-text', raw ? raw.text : seg.original_text));
    const corrCol = el('div', 'editor-col');
    corrCol.append(el('div', 'editor-col-label', 'AI-correctie'));
    corrCol.append(el('div', 'editor-col-text', seg.corrected_text));
    cmp.append(rawCol, corrCol);
    editorPanel.append(cmp);

    editorPanel.append(el('label', 'editor-label', 'Definitieve tekst'));
    const ta = el('textarea', 'editor-textarea');
    ta.value = (edit.action === 'reject') ? seg.original_text
      : (typeof edit.after === 'string' && edit.after.length ? edit.after : seg.corrected_text);
    editorPanel.append(ta);

    const noteIn = el('input', 'editor-note');
    noteIn.placeholder = 'Notitie (optioneel)';
    noteIn.value = edit.note || '';
    editorPanel.append(noteIn);

    const actions = el('div', 'editor-actions');
    const acceptBtn = el('button', 'primary', 'Accepteer AI-correctie'); acceptBtn.type = 'button';
    const rejectBtn = el('button', '', 'Verwerp (gebruik ruwe tekst)'); rejectBtn.type = 'button';
    const saveBtn = el('button', 'primary', 'Sla bewerking op'); saveBtn.type = 'button';
    const confirmBtn = el('button', '', 'Markeer als gecontroleerd'); confirmBtn.type = 'button';
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
      proceedHint.textContent = `${s.redOutstanding} rode passage(s) nog te beoordelen.`;
      proceedHint.classList.remove('error');
    } else {
      proceedHint.textContent = 'Alle rode passages beoordeeld — u kunt het formulier genereren.';
      proceedHint.classList.remove('error');
    }
  }

  return {
    render(p) {
      pipeline = p;
      if (!pipeline.edits) pipeline.edits = {};
      selectedId = null;
      showRaw = false;
      toggleBtn.textContent = 'Toon ruwe transcriptie';
      renderBanner();
      renderWarnings();
      renderTranscript();
      renderEditor();
      updateProceedState();
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
      proceedBtn.textContent = 'Genereer formulier';
    },
    setProceedBusy(busy, label) {
      proceedBtn.disabled = !!busy;
      if (label) proceedBtn.textContent = label;
      else if (!busy) proceedBtn.textContent = 'Genereer formulier';
    },
  };
}
