// Segmentation + heuristic ASR-confidence extraction.
//
// Whisper's high-level pipeline does not expose true token log-probabilities or
// no-speech probabilities, so we approximate per-segment confidence from the
// segment timestamps it does provide (timing anomalies, speaking rate, repeated
// tokens). This heuristic is ONE of three uncertainty signals (see
// js/uncertainty.js) and is never used as the sole gate for clinical safety.

const SENTENCE_END = /[.!?]+["')\]]?\s*$/;

function newSegment(id) {
  return { id, text: '', start: null, end: null, words: [], asrConfidence: null };
}

// Splits the raw transcript into sentence-level segments. When Whisper returns
// timestamped chunks we accumulate them into sentences and keep timing; without
// chunks we fall back to punctuation-based splitting (no timing, confidence
// unknown). The returned segments preserve the raw text exactly (joined chunks
// or sentence slices) — the raw transcript itself is never mutated here.
export function splitIntoSegments(rawText, chunks) {
  const text = (rawText || '').trim();
  if (Array.isArray(chunks) && chunks.length) {
    return segmentsFromChunks(chunks);
  }
  return segmentsFromText(text);
}

function segmentsFromChunks(chunks) {
  const segments = [];
  let current = newSegment('s1');
  let hasContent = false;

  const flush = () => {
    if (!hasContent) return;
    current.text = current.text.trim();
    if (current.text) {
      current.asrConfidence = scoreSegment(current);
      segments.push(current);
    }
    current = newSegment('s' + (segments.length + 1));
    hasContent = false;
  };

  for (const chunk of chunks) {
    const piece = (chunk && chunk.text) || '';
    if (!piece.trim()) continue;
    const ts = chunk && Array.isArray(chunk.timestamp) ? chunk.timestamp : null;
    const start = ts && typeof ts[0] === 'number' ? ts[0] : null;
    const end = ts && typeof ts[1] === 'number' ? ts[1] : null;

    if (current.start === null && start !== null) current.start = start;
    if (end !== null) current.end = end;
    current.text += piece;
    current.words.push({ w: piece.trim(), start, end });
    hasContent = true;

    if (SENTENCE_END.test(piece)) flush();
  }
  flush();

  // If nothing ended with punctuation we still want a single segment.
  if (!segments.length && chunks.some((c) => c && c.text && c.text.trim())) {
    const joined = chunks.map((c) => c.text || '').join('').trim();
    const seg = newSegment('s1');
    seg.text = joined;
    const first = chunks.find((c) => c && Array.isArray(c.timestamp));
    const last = [...chunks].reverse().find((c) => c && Array.isArray(c.timestamp));
    seg.start = first ? first.timestamp[0] : null;
    seg.end = last ? last.timestamp[1] : null;
    seg.asrConfidence = scoreSegment(seg);
    segments.push(seg);
  }
  return segments;
}

function segmentsFromText(text) {
  if (!text) return [];
  // Split on sentence boundaries while keeping the terminator with the sentence.
  const parts = text.match(/[^.!?]+[.!?]+["')\]]?|\S[^.!?]*$/g) || [text];
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((t, i) => ({ id: 's' + (i + 1), text: t, start: null, end: null, words: [], asrConfidence: null }));
}

// Heuristic confidence in [0,1]. Starts at a neutral-high baseline and applies
// penalties for timing/text anomalies that correlate with recognition errors.
// Returns null when there is no timing information to reason about.
function scoreSegment(seg) {
  const text = (seg.text || '').trim();
  if (!text) return null;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  let conf = 0.9;

  const hasTiming = typeof seg.start === 'number' && typeof seg.end === 'number';
  if (hasTiming) {
    const duration = seg.end - seg.start;
    if (duration <= 0) {
      conf -= 0.25; // zero/negative duration: timing is unreliable
    } else {
      const charsPerSec = text.length / duration;
      const wordsPerSec = wordCount / duration;
      if (charsPerSec > 28) conf -= 0.2;        // unrealistically fast = likely garbled
      else if (charsPerSec > 22) conf -= 0.1;
      if (charsPerSec < 2 && wordCount > 1) conf -= 0.1; // dragged out / silence-padded
      if (wordsPerSec > 6) conf -= 0.15;        // implausible speaking rate
    }
  } else {
    conf -= 0.05; // no timing to corroborate; mild penalty
  }

  // Immediate token repetition is a classic Whisper hallucination signature.
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  let maxRun = 1, run = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) { run++; maxRun = Math.max(maxRun, run); }
    else run = 1;
  }
  if (maxRun >= 3) conf -= 0.25;
  else if (maxRun === 2) conf -= 0.1;

  // Very short fragments carry little context and are easier to mis-hear.
  if (wordCount <= 1) conf -= 0.1;

  return Math.max(0, Math.min(1, Number(conf.toFixed(3))));
}

// Recomputes per-segment confidence for an already-built segment list (used when
// segments are reconstructed from storage). Mutates and returns the list.
export function extractWhisperConfidence(segments) {
  for (const seg of segments || []) {
    if (seg.asrConfidence === null || seg.asrConfidence === undefined) {
      seg.asrConfidence = scoreSegment(seg);
    }
  }
  return segments;
}
