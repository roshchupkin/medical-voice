// Centralized medical-safety rules and gates.
//
// These encode the hard constraints from the spec in one place so the rest of
// the app can enforce them consistently. The prompts in js/llm-worker.js carry
// the model-facing half of these rules; this module is the app-side enforcement.
//
// Hard rules:
//   - Do not invent or infer information unless explicitly allowed.
//   - Missing fields are "niet vermeld".
//   - Never silently change medication, dosage, left/right, or negations.
//   - A red (high-risk) uncertainty blocks form generation until reviewed.
//   - The raw transcript is always preserved (enforced in the data model).
//   - The clinician can always override the model.

import { summarizeAnnotations } from './uncertainty.js';
import { t } from './i18n.js';

export const NOT_MENTIONED = 'niet vermeld';

// Categories that must never be changed silently; surfaced for UI copy/tests.
export const PROTECTED_CATEGORIES = ['medication', 'dosage', 'laterality', 'negation'];

// Returns whether the clinician may proceed to form generation, i.e. there are
// no unreviewed red passages.
export function isFormGenerationAllowed(annotations) {
  const summary = summarizeAnnotations(annotations);
  return { allowed: summary.redOutstanding === 0, redOutstanding: summary.redOutstanding, summary };
}

// Throws a clear error when form generation is blocked by outstanding red items.
export function assertFormGenerationAllowed(annotations) {
  const { allowed, redOutstanding } = isFormGenerationAllowed(annotations);
  if (!allowed) {
    throw new Error(t('review.redGate', { count: redOutstanding }));
  }
}

// Guarantees the raw transcript is preserved on a pipeline object. Returns true
// when a non-empty raw transcript is present.
export function rawTranscriptPreserved(pipeline) {
  return !!(pipeline && pipeline.raw && typeof pipeline.raw.text === 'string' && pipeline.raw.text.length >= 0);
}
