// Uncertainty scoring: merges the three signals into a single green/yellow/red
// annotation per segment.
//
//   1. ASR confidence   - heuristic from Whisper timing (js/segments.js)
//   2. LLM semantic      - the correction model's own confidence / risk / flags
//   3. Clinical importance - lexicon-based weight of what the passage is about
//
// The hard rules from the spec always win (e.g. an unclear negation or
// laterality is red regardless of the numeric blend), so clinically dangerous
// uncertainty can never be downgraded to green by an averaging effect.

import { analyzeClinicalImportance } from './clinical-lexicon.js';

const HIGH_RISK_TRIGGERS = new Set(['negation', 'laterality', 'medication', 'dosage', 'allergy']);

function asrBand(asr) {
  if (asr === null || asr === undefined) return 'unknown';
  if (asr >= 0.75) return 'high';
  if (asr >= 0.5) return 'medium';
  return 'low';
}

function llmUncertaintyValue(confidence) {
  if (confidence === 'high') return 0;
  if (confidence === 'low') return 1;
  return 0.5; // medium / unknown
}

function colorRank(color) {
  return color === 'red' ? 3 : color === 'yellow' ? 2 : color === 'green' ? 1 : 0;
}

function maxColor(a, b) {
  return colorRank(a) >= colorRank(b) ? a : b;
}

// Produces an Annotation[] aligned to the input segments.
// `correctedSegments` is the normalised output of the correction LLM.
export function annotateTranscriptUncertainty(segments, correctedSegments) {
  const correctedById = new Map();
  for (const c of correctedSegments || []) correctedById.set(String(c.segment_id), c);

  return (segments || []).map((seg) => {
    const c = correctedById.get(seg.id) || null;
    const correctedText = c ? c.corrected_text : seg.text;
    const changed = !!c && correctedText.trim() !== seg.text.trim();

    // Clinical importance from both the original and corrected text (a change to
    // a high-risk word matters even if only one side mentions it).
    const impOrig = analyzeClinicalImportance(seg.text);
    const impCorr = analyzeClinicalImportance(correctedText);
    const triggers = [...new Set([...impOrig.triggers, ...impCorr.triggers])];
    const importance = Math.max(impOrig.importance, impCorr.importance);

    const asr = seg.asrConfidence;
    const aband = asrBand(asr);
    const llmConf = c ? c.confidence : 'medium';
    const llmRisk = c ? c.clinical_risk : 'low';
    const needsReviewLLM = c ? c.needs_clinician_review : false;
    const llmColor = c ? c.highlight_color : null;

    const hasHighRisk = triggers.some((t) => HIGH_RISK_TRIGGERS.has(t));
    const hasNumberish = triggers.includes('number') || triggers.includes('date') || triggers.includes('dosage');

    // --- Numeric blend (for ordering / tie-breaking) ---
    const asrUncertainty = asr === null || asr === undefined ? 0.4 : 1 - asr;
    const score = Math.min(1,
      0.4 * importance +
      0.3 * asrUncertainty +
      0.3 * llmUncertaintyValue(llmConf));

    // --- Color from the blend ---
    let color = score >= 0.6 ? 'red' : score >= 0.33 ? 'yellow' : 'green';

    // --- Hard safety overrides (spec rules) ---
    // Low ASR confidence on a high-risk passage -> red.
    if (aband === 'low' && hasHighRisk) color = 'red';
    // Any unclear negation or laterality -> red. "Unclear" = changed, low LLM
    // confidence, flagged by the LLM, or low ASR.
    const unclear = changed || llmConf === 'low' || needsReviewLLM || aband === 'low' || llmRisk === 'high';
    if ((triggers.includes('negation') || triggers.includes('laterality')) && unclear) color = 'red';
    // Any unclear dosage / number -> red.
    if (hasNumberish && unclear) color = 'red';
    // High LLM-rated clinical risk -> at least red.
    if (llmRisk === 'high') color = 'red';
    // A changed medication/allergy that the model wasn't fully sure about -> red.
    if ((triggers.includes('medication') || triggers.includes('allergy')) && changed && llmConf !== 'high') color = 'red';

    // Possible medical term with only medium certainty -> at least yellow.
    if (color === 'green') {
      const medishTrigger = ['medication', 'anatomy', 'diagnosis', 'procedure'].some((t) => triggers.includes(t));
      if ((medishTrigger && llmConf === 'medium') || aband === 'low') color = 'yellow';
      if (changed && (c?.change_type === 'medical_term')) color = 'yellow';
    }

    // The LLM's own color is a floor, never let the blend soften it below.
    if (llmColor) color = maxColor(color, llmColor);

    const needsReview = color === 'red' || needsReviewLLM;

    return {
      segment_id: seg.id,
      color,
      score: Number(score.toFixed(3)),
      triggers,
      asrConfidence: asr,
      asrBand: aband,
      llmConfidence: llmConf,
      clinicalRisk: llmRisk,
      changed,
      needsReview,
      confirmed: false,
    };
  });
}

// Convenience: count annotations by color, plus how many red items are still
// outstanding (not yet confirmed/reviewed by the clinician).
export function summarizeAnnotations(annotations) {
  const summary = { green: 0, yellow: 0, red: 0, redOutstanding: 0 };
  for (const a of annotations || []) {
    summary[a.color] = (summary[a.color] || 0) + 1;
    if (a.color === 'red' && !a.confirmed) summary.redOutstanding++;
  }
  return summary;
}
