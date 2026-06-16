// Segment-based correction windows with read-only contextual overlap.
// Overlap segments appear in the LLM prompt only; each segment is corrected in
// exactly one target window. Merge is by segment_id (no text deduplication).

import {
  CORRECTION_SINGLE_PASS_MAX_WORDS,
  CORRECTION_TARGET_WORDS_MIN,
  CORRECTION_TARGET_WORDS_MAX,
  CORRECTION_TARGET_DURATION_SEC,
  CORRECTION_OVERLAP_SENTENCES,
  CORRECTION_OVERLAP_WORDS_MAX,
  EXTRACT_MAX_TRANSCRIPT_CHARS,
} from './config.js';
import { analyzeClinicalImportance } from './clinical-lexicon.js';

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function segmentDuration(seg) {
  if (typeof seg.start === 'number' && typeof seg.end === 'number' && seg.end > seg.start) {
    return seg.end - seg.start;
  }
  return null;
}

function segmentsHaveTimestamps(segments) {
  return (segments || []).some((s) => segmentDuration(s) !== null);
}

export function totalWordCount(segments) {
  return (segments || []).reduce((sum, s) => sum + wordCount(s.text), 0);
}

function splitIntoTargetGroups(segments, options) {
  const {
    targetWordsMin,
    targetWordsMax,
    targetDurationSec,
  } = options;
  const useDuration = segmentsHaveTimestamps(segments);
  const groups = [];
  let current = [];
  let currentWords = 0;
  let currentDuration = 0;

  const flush = () => {
    if (!current.length) return;
    groups.push(current);
    current = [];
    currentWords = 0;
    currentDuration = 0;
  };

  for (const seg of segments) {
    const w = wordCount(seg.text);
    const d = segmentDuration(seg) || 0;

    if (current.length > 0 && currentWords + w > targetWordsMax) {
      flush();
    }

    current.push(seg);
    currentWords += w;
    currentDuration += d;

    const hitWordMin = currentWords >= targetWordsMin;
    const hitDuration = useDuration && currentDuration >= targetDurationSec;
    const hitWordMax = currentWords >= targetWordsMax;

    if (hitWordMax || (hitWordMin && (hitDuration || !useDuration))) {
      flush();
    }
  }
  flush();
  return groups;
}

function takeOverlapSegments(targetSegments, fromEnd, overlapSentences, overlapWordsMax) {
  const result = [];
  let words = 0;
  const list = fromEnd ? [...targetSegments].reverse() : targetSegments;
  for (const seg of list) {
    if (result.length >= overlapSentences) break;
    const w = wordCount(seg.text);
    if (result.length > 0 && words + w > overlapWordsMax) break;
    result.push(seg);
    words += w;
  }
  return fromEnd ? result.reverse() : result;
}

function defaultChunkOptions() {
  return {
    singlePassMaxWords: CORRECTION_SINGLE_PASS_MAX_WORDS,
    targetWordsMin: CORRECTION_TARGET_WORDS_MIN,
    targetWordsMax: CORRECTION_TARGET_WORDS_MAX,
    targetDurationSec: CORRECTION_TARGET_DURATION_SEC,
    overlapSentences: CORRECTION_OVERLAP_SENTENCES,
    overlapWordsMax: CORRECTION_OVERLAP_WORDS_MAX,
  };
}

export function buildCorrectionWindows(segments, options = {}) {
  const opts = { ...defaultChunkOptions(), ...options };
  const segs = (segments || []).filter((s) => s && s.id);
  if (!segs.length) return [];

  if (totalWordCount(segs) <= opts.singlePassMaxWords) {
    return [{
      windowIndex: 0,
      targetSegmentIds: segs.map((s) => s.id),
      prevContextIds: [],
      nextContextIds: [],
      target: [...segs],
      prevContext: [],
      nextContext: [],
    }];
  }

  const targetGroups = splitIntoTargetGroups(segs, opts);
  const windows = targetGroups.map((target, i) => ({
    windowIndex: i,
    target: [...target],
    targetSegmentIds: target.map((s) => s.id),
    prevContext: [],
    nextContext: [],
    prevContextIds: [],
    nextContextIds: [],
  }));

  for (let i = 0; i < windows.length; i++) {
    if (i > 0) {
      const prev = takeOverlapSegments(
        windows[i - 1].target,
        true,
        opts.overlapSentences,
        opts.overlapWordsMax,
      );
      windows[i].prevContext = prev;
      windows[i].prevContextIds = prev.map((s) => s.id);
    }
    if (i < windows.length - 1) {
      const next = takeOverlapSegments(
        windows[i + 1].target,
        false,
        opts.overlapSentences,
        opts.overlapWordsMax,
      );
      windows[i].nextContext = next;
      windows[i].nextContextIds = next.map((s) => s.id);
    }
  }

  return windows;
}

function fallbackCorrectionSegment(seg, reason) {
  return {
    segment_id: seg.id,
    original_text: seg.text,
    corrected_text: seg.text,
    change_type: 'no_change',
    confidence: 'low',
    clinical_risk: 'medium',
    highlight_color: 'yellow',
    needs_clinician_review: true,
    reason: reason || 'Segment niet gecorrigeerd; handmatige controle vereist.',
  };
}

export function mergeCorrectionResults(windows, windowResults, inputSegments) {
  const byId = new Map();
  const globalWarnings = [];
  const boundaryConflicts = [];

  for (let i = 0; i < (windows || []).length; i++) {
    const wr = windowResults[i] || {};
    if (wr.failed) {
      boundaryConflicts.push({
        type: 'window_failed',
        segmentIds: [...(windows[i].targetSegmentIds || [])],
        message: `Automatische correctie mislukt voor deel ${i + 1} van ${windows.length}.`,
        severity: 'high',
      });
    }
    for (const w of wr.global_warnings || []) {
      if (typeof w === 'string' && w.trim()) globalWarnings.push(w.trim());
    }
    for (const seg of wr.segments || []) {
      if (seg && seg.segment_id) byId.set(String(seg.segment_id), seg);
    }
  }

  const segments = [];
  for (const seg of inputSegments || []) {
    const hit = byId.get(seg.id);
    if (hit) {
      segments.push(hit);
    } else {
      const isTarget = (windows || []).some((w) => w.targetSegmentIds.includes(seg.id));
      if (isTarget) {
        segments.push(fallbackCorrectionSegment(seg, 'Ontbrekend in LLM-antwoord voor dit venster.'));
        boundaryConflicts.push({
          type: 'missing_target',
          segmentIds: [seg.id],
          message: `Segment ${seg.id} ontbrak in het correctie-antwoord.`,
          severity: 'medium',
        });
      }
    }
  }

  const corrected_transcript = segments.map((s) => s.corrected_text).filter(Boolean).join(' ').trim();
  return {
    corrected_transcript,
    segments,
    global_warnings: globalWarnings,
    boundaryConflicts,
  };
}

const SENTENCE_END = /[.!?]+["')\]]?\s*$/;

function hasLateralityConflict(textA, textB) {
  const lat = ['links', 'linker', 'rechts', 'rechter'];
  const tokensA = new Set(String(textA || '').toLowerCase().split(/\s+/));
  const tokensB = new Set(String(textB || '').toLowerCase().split(/\s+/));
  const aLat = lat.filter((t) => tokensA.has(t));
  const bLat = lat.filter((t) => tokensB.has(t));
  if (!aLat.length || !bLat.length) return false;
  const aLeft = aLat.some((t) => t.startsWith('link'));
  const aRight = aLat.some((t) => t.startsWith('recht'));
  const bLeft = bLat.some((t) => t.startsWith('link'));
  const bRight = bLat.some((t) => t.startsWith('recht'));
  return (aLeft && bRight) || (aRight && bLeft);
}

function crossBoundaryRisk(segA, segB) {
  const impA = analyzeClinicalImportance(segA.corrected_text || segA.original_text || '');
  const impB = analyzeClinicalImportance(segB.corrected_text || segB.original_text || '');
  const changedA = (segA.corrected_text || '').trim() !== (segA.original_text || '').trim();
  const changedB = (segB.corrected_text || '').trim() !== (segB.original_text || '').trim();
  const riskTypes = new Set(['medication', 'laterality', 'negation', 'dosage', 'allergy']);
  const triggersA = impA.triggers.filter((t) => riskTypes.has(t));
  const triggersB = impB.triggers.filter((t) => riskTypes.has(t));
  if (!triggersA.length && !triggersB.length) return null;
  if (hasLateralityConflict(segA.corrected_text, segB.corrected_text)) {
    return 'Tegenstrijdige links/rechts aan venstergrens.';
  }
  if ((changedA || changedB) && triggersA.length && triggersB.length) {
    const overlap = triggersA.filter((t) => triggersB.includes(t));
    if (!overlap.length && (changedA && changedB)) {
      return 'Aangrenzende segmenten aan venstergrens hebben verschillende klinische wijzigingen.';
    }
  }
  return null;
}

export function detectBoundaryConflicts(mergedSegments, windows) {
  const conflicts = [];
  if (!windows || windows.length < 2) return conflicts;

  const byId = new Map((mergedSegments || []).map((s) => [s.segment_id, s]));

  for (let w = 0; w < windows.length - 1; w++) {
    const lastId = windows[w].targetSegmentIds[windows[w].targetSegmentIds.length - 1];
    const firstId = windows[w + 1].targetSegmentIds[0];
    const segA = byId.get(lastId);
    const segB = byId.get(firstId);
    if (!segA || !segB) continue;

    const riskMsg = crossBoundaryRisk(segA, segB);
    if (riskMsg) {
      conflicts.push({
        type: 'cross_boundary_inconsistency',
        segmentIds: [lastId, firstId],
        message: riskMsg,
        severity: 'medium',
      });
    }

    const textA = (segA.original_text || '').trim();
    const textB = (segB.original_text || '').trim();
    if (textA && textB && !SENTENCE_END.test(textA)) {
      const startsLower = /^[a-zà-ÿ]/.test(textB);
      if (startsLower) {
        conflicts.push({
          type: 'sentence_boundary_break',
          segmentIds: [lastId, firstId],
          message: `Mogelijke zinsplitsing tussen ${lastId} en ${firstId} aan venstergrens.`,
          severity: 'low',
        });
      }
    }
  }

  return conflicts;
}

function hintKeywords(schema) {
  const words = new Set();
  if (!schema || !schema.properties) return words;
  for (const def of Object.values(schema.properties)) {
    const desc = def && def.description ? String(def.description) : '';
    for (const w of desc.toLowerCase().split(/\W+/)) {
      if (w.length > 3) words.add(w);
    }
  }
  return words;
}

function segmentExtractScore(seg, hintWords) {
  const text = (seg.text || '').toLowerCase();
  let score = analyzeClinicalImportance(seg.text).importance;
  for (const w of hintWords) {
    if (text.includes(w)) score += 0.5;
  }
  return score;
}

function numberedLength(segments) {
  return segments.map((s) => `${s.id}: ${s.text}`).join('\n').length;
}

export function filterSegmentsForExtract(segments, schema, maxChars = EXTRACT_MAX_TRANSCRIPT_CHARS) {
  const segs = (segments || []).filter((s) => s && s.id && (s.text || '').trim());
  if (!segs.length) return { segments: [], filtered: false };
  if (numberedLength(segs) <= maxChars) return { segments: segs, filtered: false };

  const hints = hintKeywords(schema);
  const scored = segs.map((seg, index) => ({
    seg,
    index,
    score: segmentExtractScore(seg, hints),
  }));

  const mustInclude = new Set();
  for (let i = 0; i < Math.min(2, segs.length); i++) mustInclude.add(segs[i].id);
  for (let i = Math.max(0, segs.length - 2); i < segs.length; i++) mustInclude.add(segs[i].id);

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = new Map();
  const addSeg = (seg) => {
    if (!picked.has(seg.id)) picked.set(seg.id, seg);
  };

  for (const id of mustInclude) {
    const seg = segs.find((s) => s.id === id);
    if (seg) addSeg(seg);
  }

  for (const { seg } of scored) {
    if (picked.size >= segs.length) break;
    const trial = [...picked.values(), seg].sort(
      (a, b) => segs.findIndex((s) => s.id === a.id) - segs.findIndex((s) => s.id === b.id),
    );
    if (numberedLength(trial) <= maxChars) addSeg(seg);
  }

  const ordered = segs.filter((s) => picked.has(s.id));
  if (!ordered.length) {
    const fallback = segs.slice(0, 1);
    return { segments: fallback, filtered: true };
  }
  return { segments: ordered, filtered: ordered.length < segs.length };
}
