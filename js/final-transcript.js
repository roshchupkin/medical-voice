// Builds the final, clinician-reviewed transcript and the edit log.
//
// Three transcript versions are kept everywhere:
//   - raw       : exactly what Whisper produced (never mutated)
//   - corrected : the LLM's suggested correction
//   - final     : what the clinician accepted (the ONLY input to form filling)
//
// `edits` is a map of segment_id -> { action, after?, note?, at } where action is
// one of 'accept' | 'reject' | 'edit' | 'confirm'. A segment with no entry
// defaults to accepting the LLM correction.

function resolveFinalText(correctedSeg, edit) {
  const original = correctedSeg.original_text;
  const corrected = correctedSeg.corrected_text;
  if (!edit) return { text: corrected, source: corrected.trim() === original.trim() ? 'raw' : 'llm' };

  if (edit.action === 'reject') return { text: original, source: 'raw' };
  if (typeof edit.after === 'string' && edit.after.trim() && edit.after.trim() !== corrected.trim()) {
    return { text: edit.after, source: 'clinician' };
  }
  // accept / confirm / edit-that-matches-corrected
  return { text: corrected, source: corrected.trim() === original.trim() ? 'raw' : 'llm' };
}

// Returns { text, segments:[{id,text,source}] } for the final transcript.
export function generateFinalReviewedTranscript(correctedSegments, edits) {
  const editMap = edits instanceof Map ? edits : new Map(Object.entries(edits || {}));
  const segments = (correctedSegments || []).map((c) => {
    const { text, source } = resolveFinalText(c, editMap.get(c.segment_id));
    return { id: c.segment_id, text: text.trim(), source };
  });
  const text = segments.map((s) => s.text).filter(Boolean).join(' ').trim();
  return { text, segments };
}

// Returns a chronological edit log distinguishing LLM vs clinician changes, plus
// any rule-based pre-corrections passed in.
export function buildEditLog(correctedSegments, edits, ruleApplications = []) {
  const editMap = edits instanceof Map ? edits : new Map(Object.entries(edits || {}));
  const log = [];

  for (const r of ruleApplications) {
    log.push({
      segment_id: r.segment_id || null,
      before: r.from,
      after: r.to,
      by: 'rule',
      action: r.mode || 'replace',
      at: r.at || new Date().toISOString(),
    });
  }

  for (const c of correctedSegments || []) {
    if (c.corrected_text.trim() !== c.original_text.trim()) {
      log.push({
        segment_id: c.segment_id,
        before: c.original_text,
        after: c.corrected_text,
        by: 'llm',
        action: c.change_type || 'correction',
        reason: c.reason || '',
        at: new Date().toISOString(),
      });
    }
    const edit = editMap.get(c.segment_id);
    if (!edit) continue;
    if (edit.action === 'reject') {
      log.push({ segment_id: c.segment_id, before: c.corrected_text, after: c.original_text, by: 'clinician', action: 'reject', note: edit.note || '', at: edit.at || new Date().toISOString() });
    } else if (typeof edit.after === 'string' && edit.after.trim() && edit.after.trim() !== c.corrected_text.trim()) {
      log.push({ segment_id: c.segment_id, before: c.corrected_text, after: edit.after, by: 'clinician', action: 'edit', note: edit.note || '', at: edit.at || new Date().toISOString() });
    } else if (edit.action === 'confirm') {
      log.push({ segment_id: c.segment_id, before: c.corrected_text, after: c.corrected_text, by: 'clinician', action: 'confirm', note: edit.note || '', at: edit.at || new Date().toISOString() });
    }
  }
  return log;
}

// Resolves the full source chain for a given segment id across all versions.
// Used by the form traceability UI.

export function normalizeSegmentId(raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/^(?:segment\s*)?s?(\d+)$/i);
  if (m) return `s${m[1]}`;
  return s;
}

function findRawSegment(rawSegments, id) {
  const norm = normalizeSegmentId(id);
  if (!norm) return null;
  return (rawSegments || []).find((s) => normalizeSegmentId(s.id) === norm) || null;
}

function findCorrectedSegment(correctedSegments, id) {
  const norm = normalizeSegmentId(id);
  if (!norm) return null;
  return (correctedSegments || []).find((s) => normalizeSegmentId(s.segment_id) === norm) || null;
}

function findFinalSegment(finalSegments, id) {
  const norm = normalizeSegmentId(id);
  if (!norm) return null;
  return (finalSegments || []).find((s) => normalizeSegmentId(s.id) === norm) || null;
}

export function resolveSegmentChain(segmentId, { rawSegments, correctedSegments, finalSegments, annotations, edits }) {
  const id = normalizeSegmentId(segmentId);
  if (!id) return null;
  const raw = findRawSegment(rawSegments, id);
  const corrected = findCorrectedSegment(correctedSegments, id);
  const fin = findFinalSegment(finalSegments, id);
  const annotation = (annotations || []).find((a) => normalizeSegmentId(a.segment_id) === id) || null;
  const editMap = edits instanceof Map ? edits : new Map(Object.entries(edits || {}));
  const edit = editMap.get(id) || editMap.get(segmentId) || null;
  const edited = !!fin && fin.source === 'clinician';
  return {
    segment_id: id,
    raw: raw ? raw.text : null,
    corrected: corrected ? corrected.corrected_text : null,
    final: fin ? fin.text : null,
    color: annotation ? annotation.color : null,
    edited,
    edit,
  };
}
