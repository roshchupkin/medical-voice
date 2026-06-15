// Local correction memory: clinician-defined correction rules that stay in the
// browser. Persistent rules (user/specialty/global scope) live encrypted in
// IndexedDB; session-scoped rules live in memory only and are dropped on lock.
//
// Rule modes:
//   - replace: a clear, safe text substitution, e.g. "metformien" -> "metformine"
//   - expand:  abbreviation expansion, e.g. "ASA" -> "acetylsalicylzuur"
//   - protect: a phrase that must NOT be changed, e.g. "rechter knie". These are
//              never auto-edited; they are passed to the correction LLM as
//              do-not-change context.
//
// SAFETY: replace/expand are applied as whole-word substitutions before the LLM
// step. Anything ambiguous should be a protect rule (or no rule) so the LLM/
// clinician decides, rather than a silent replacement.

import * as db from './db.js';

// Session-scoped rules (memory only). Cleared on lock via clearSessionRules().
let sessionRules = [];

export function getSessionRules() {
  return sessionRules.slice();
}

export function addSessionRule(rule) {
  const r = normalizeRule({ ...rule, scope: 'session' });
  sessionRules.push(r);
  return r;
}

export function clearSessionRules() {
  sessionRules = [];
}

function normalizeRule(rule) {
  return {
    id: rule.id || crypto.randomUUID(),
    scope: rule.scope || 'user',
    specialty: rule.specialty || null,
    from: String(rule.from || '').trim(),
    to: rule.mode === 'protect' ? '' : String(rule.to || '').trim(),
    mode: rule.mode === 'expand' || rule.mode === 'protect' ? rule.mode : 'replace',
    note: rule.note ? String(rule.note) : '',
    createdAt: rule.createdAt || new Date().toISOString(),
  };
}

// Persistent rule CRUD (delegates encryption/storage to db.js).
export async function addPersistentRule(rule) {
  return db.saveCorrectionRule(normalizeRule(rule));
}

export async function listPersistentRules() {
  return db.listCorrectionRules();
}

export async function deletePersistentRule(id) {
  return db.deleteCorrectionRule(id);
}

// Returns all rules in effect for the current session, optionally filtered by
// specialty. Phase 1 wires session + user/global scopes; specialty rules apply
// when their specialty matches (or is unset).
export async function getActiveRules({ specialty = null } = {}) {
  let persistent = [];
  try {
    persistent = await db.listCorrectionRules();
  } catch (_) {
    persistent = [];
  }
  const applicable = persistent.filter((r) => {
    if (r.scope === 'specialty') return !specialty || !r.specialty || r.specialty === specialty;
    return true; // user / global
  });
  return [...applicable, ...sessionRules].map(normalizeRule);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, case-insensitive substitution that preserves a leading capital so
// sentence-initial corrections keep their casing.
function applySubstitution(text, from, to) {
  if (!from) return { text, count: 0 };
  const re = new RegExp('\\b' + escapeRegExp(from) + '\\b', 'gi');
  let count = 0;
  const out = text.replace(re, (match) => {
    count++;
    if (match[0] === match[0].toUpperCase() && to.length) {
      return to[0].toUpperCase() + to.slice(1);
    }
    return to;
  });
  return { text: out, count };
}

// Applies replace/expand rules to the raw transcript and collects protect terms.
// Returns the pre-LLM text plus a record of what changed (for the edit log) and
// the protected terms to hand to the correction LLM as do-not-change context.
export function applyLocalCorrectionRules(rawTranscript, rules) {
  let text = rawTranscript || '';
  const applied = [];
  const protectedTerms = [];

  for (const rule of rules || []) {
    if (rule.mode === 'protect') {
      if (rule.from) protectedTerms.push({ term: rule.from, note: rule.note || '' });
      continue;
    }
    if (!rule.from || !rule.to) continue;
    const { text: next, count } = applySubstitution(text, rule.from, rule.to);
    if (count > 0) {
      text = next;
      applied.push({ from: rule.from, to: rule.to, mode: rule.mode, count, scope: rule.scope });
    }
  }

  return { text, applied, protectedTerms };
}
