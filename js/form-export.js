// Form text export: labeled plain text, SOEP layout, clipboard, and .txt download.

import { normalizePipelineForm } from './form-review-ui.js';
import { NOT_MENTIONED } from './safety.js';
import { t } from './i18n.js';

const SOEP_GROUPS = {
  S: [
    'reden van komst', 'reason for visit', 'chief complaint', 'klacht', 'anamnese',
    'history', 'voorgeschiedenis', 'reason', 'verwijzing', 'referral reason',
  ],
  O: [
    'symptomen', 'symptoms', 'bevindingen', 'findings', 'onderzoek', 'examination',
    'observaties', 'physical', 'klacht', 'complaint', 'red flags',
  ],
  E: [
    'evaluatie', 'evaluation', 'diagnose', 'diagnosis', 'beoordeling', 'assessment',
    'conclusie', 'impression',
  ],
  P: [
    'plan', 'medicatie', 'medication', 'beleid', 'follow-up', 'vervolg', 'advies',
    'advice', 'callback', 'terugbellen',
  ],
};

function isNotMentioned(value) {
  if (!value || !String(value).trim()) return true;
  return String(value).trim().toLowerCase() === NOT_MENTIONED.toLowerCase();
}

function formatFieldBlock(field, opts = {}) {
  const { hideEmpty = false } = opts;
  if (hideEmpty && isNotMentioned(field.value)) return '';
  const value = field.value && String(field.value).trim() ? field.value : '—';
  const review = field.needs_review ? t('export.needsReview') : '';
  return `${field.field_name}:\n${value}${review}`;
}

export function formatFormLabeled(form, opts = {}) {
  const normalized = normalizePipelineForm(form);
  if (!normalized || !normalized.fields.length) return '';
  return normalized.fields
    .map((f) => formatFieldBlock(f, opts))
    .filter(Boolean)
    .join('\n\n');
}

function classifySoepSection(fieldName) {
  const lower = String(fieldName || '').toLowerCase().trim();
  for (const [section, keywords] of Object.entries(SOEP_GROUPS)) {
    if (keywords.some((kw) => lower.includes(kw))) return section;
  }
  return 'other';
}

export function formatFormSoep(form, opts = {}) {
  const normalized = normalizePipelineForm(form);
  if (!normalized || !normalized.fields.length) return '';

  const groups = { S: [], O: [], E: [], P: [], other: [] };
  for (const field of normalized.fields) {
    const block = formatFieldBlock(field, opts);
    if (!block && opts.hideEmpty) continue;
    const section = classifySoepSection(field.field_name);
    groups[section].push(block || `${field.field_name}:\n${field.value || '—'}`);
  }

  const sectionLabels = {
    S: t('form.soepS'),
    O: t('form.soepO'),
    E: t('form.soepE'),
    P: t('form.soepP'),
    other: t('form.soepOther'),
  };

  const parts = [];
  for (const key of ['S', 'O', 'E', 'P', 'other']) {
    if (!groups[key].length) continue;
    parts.push(`${sectionLabels[key]}\n${groups[key].join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export function formatSingleField(field) {
  const review = field.needs_review ? t('export.needsReview') : '';
  return `${field.field_name}:\n${field.value || '—'}${review}`;
}

export async function copyFormToClipboard(form, format = 'labeled', opts = {}) {
  const text = format === 'soep' ? formatFormSoep(form, opts) : formatFormLabeled(form, opts);
  if (!text) throw new Error('empty');
  await navigator.clipboard.writeText(text);
  return text;
}

export async function copyFieldToClipboard(field) {
  const text = formatSingleField(field);
  await navigator.clipboard.writeText(text);
  return text;
}

export function downloadFormTxt(form, filename, opts = {}) {
  const text = formatFormLabeled(form, opts);
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'form.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}
