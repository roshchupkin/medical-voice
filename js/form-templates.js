// Form template library: built-in presets + user-saved custom templates.

import * as db from './db.js';
import { t, getDefaultTemplate } from './i18n.js';

export const BUILTIN_STANDARD_ID = 'builtin:standard-consult';

let libraryState = null;
let activeFields = [];

function cloneFields(fields) {
  return fields.map((f) => ({ name: String(f.name || ''), hint: String(f.hint || '') }));
}

function builtinCatalog() {
  return [
    {
      id: BUILTIN_STANDARD_ID,
      nameKey: 'templates.standardConsult',
      categoryKey: 'templates.catConsult',
      fields: () => getDefaultTemplate(),
    },
    {
      id: 'builtin:follow-up',
      nameKey: 'templates.followUp',
      categoryKey: 'templates.catChronic',
      fields: () => [
        { name: t('templates.followUpAnamnesis'), hint: t('templates.followUpAnamnesisHint') },
        { name: t('templates.followUpMeds'), hint: t('templates.followUpMedsHint') },
        { name: t('templates.followUpAdherence'), hint: t('templates.followUpAdherenceHint') },
        { name: t('templates.plan'), hint: t('templates.planHint') },
      ],
    },
    {
      id: 'builtin:referral',
      nameKey: 'templates.referral',
      categoryKey: 'templates.catReferral',
      fields: () => [
        { name: t('templates.referralReason'), hint: t('templates.referralReasonHint') },
        { name: t('templates.referralHistory'), hint: t('templates.referralHistoryHint') },
        { name: t('templates.findings'), hint: t('templates.findingsHint') },
        { name: t('templates.referralQuestion'), hint: t('templates.referralQuestionHint') },
      ],
    },
    {
      id: 'builtin:telephone-triage',
      nameKey: 'templates.telephoneTriage',
      categoryKey: 'templates.catTriage',
      fields: () => [
        { name: t('templates.triageComplaint'), hint: t('templates.triageComplaintHint') },
        { name: t('templates.triageRedFlags'), hint: t('templates.triageRedFlagsHint') },
        { name: t('templates.triageAdvice'), hint: t('templates.triageAdviceHint') },
        { name: t('templates.triageCallback'), hint: t('templates.triageCallbackHint') },
      ],
    },
  ];
}

export function getBuiltinTemplates() {
  return builtinCatalog().map((b) => ({
    id: b.id,
    name: t(b.nameKey),
    category: t(b.categoryKey),
    nameKey: b.nameKey,
    categoryKey: b.categoryKey,
    builtin: true,
    fields: cloneFields(b.fields()),
  }));
}

export function resolveBuiltinTemplate(id) {
  const entry = builtinCatalog().find((b) => b.id === id);
  if (!entry) return null;
  return {
    id: entry.id,
    name: t(entry.nameKey),
    category: t(entry.categoryKey),
    builtin: true,
    fields: cloneFields(entry.fields()),
  };
}

export function getActiveTemplateId() {
  return libraryState?.activeTemplateId || BUILTIN_STANDARD_ID;
}

export function getActiveFields() {
  return activeFields.map((f) => ({ ...f }));
}

export function syncActiveFields(fields) {
  activeFields = cloneFields(fields);
}

export function getActiveTemplateMeta() {
  const id = getActiveTemplateId();
  const custom = (libraryState?.custom || []).find((c) => c.id === id);
  if (custom) {
    return { id: custom.id, name: custom.name, category: custom.category || '', builtin: false };
  }
  const builtin = resolveBuiltinTemplate(id);
  if (builtin) return { id: builtin.id, name: builtin.name, category: builtin.category, builtin: true };
  const fallback = resolveBuiltinTemplate(BUILTIN_STANDARD_ID);
  return { id: fallback.id, name: fallback.name, category: fallback.category, builtin: true };
}

export function listAllTemplates() {
  const builtins = getBuiltinTemplates();
  const custom = (libraryState?.custom || []).map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category || t('templates.catCustom'),
    builtin: false,
    fields: cloneFields(c.fields || []),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    source: c.source || 'custom',
  }));
  return { builtins, custom };
}

function defaultLibraryState() {
  return { activeTemplateId: BUILTIN_STANDARD_ID, custom: [] };
}

async function persistLibrary() {
  if (!libraryState) return;
  await db.saveFormTemplateLibrary(libraryState);
  await db.saveFormTemplate(activeFields);
}

export async function initTemplateLibrary() {
  libraryState = await db.getFormTemplateLibrary();
  if (!libraryState) libraryState = defaultLibraryState();

  const legacyFields = await db.getFormTemplate();
  if (Array.isArray(legacyFields) && legacyFields.length && !libraryState.custom.length) {
    const now = new Date().toISOString();
    const imported = {
      id: crypto.randomUUID(),
      name: t('templates.myTemplate'),
      category: t('templates.catCustom'),
      fields: cloneFields(legacyFields),
      createdAt: now,
      updatedAt: now,
      source: 'legacy',
    };
    libraryState.custom.push(imported);
    libraryState.activeTemplateId = imported.id;
    await db.saveFormTemplateLibrary(libraryState);
  }

  await applyTemplateById(libraryState.activeTemplateId || BUILTIN_STANDARD_ID, { skipPersist: true });
}

export async function applyTemplateById(id, opts = {}) {
  const custom = (libraryState?.custom || []).find((c) => c.id === id);
  if (custom) {
    activeFields = cloneFields(custom.fields);
    libraryState.activeTemplateId = id;
  } else {
    const builtin = resolveBuiltinTemplate(id);
    if (!builtin) return false;
    activeFields = cloneFields(builtin.fields);
    libraryState.activeTemplateId = id;
  }
  if (!opts.skipPersist) await persistLibrary();
  return true;
}

export async function setActiveFields(fields) {
  activeFields = cloneFields(fields);
  const id = getActiveTemplateId();
  const custom = (libraryState?.custom || []).find((c) => c.id === id);
  if (custom) {
    custom.fields = cloneFields(activeFields);
    custom.updatedAt = new Date().toISOString();
  }
  await persistLibrary();
}

export async function saveCustomTemplate({ name, category, sourceId }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('name required');
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: trimmed,
    category: String(category || '').trim() || t('templates.catCustom'),
    fields: cloneFields(activeFields),
    createdAt: now,
    updatedAt: now,
    source: sourceId || getActiveTemplateId(),
  };
  libraryState.custom.push(entry);
  libraryState.activeTemplateId = entry.id;
  await persistLibrary();
  return entry;
}

export async function renameCustomTemplate(id, name) {
  const entry = libraryState.custom.find((c) => c.id === id);
  if (!entry) throw new Error('not found');
  entry.name = String(name || '').trim();
  if (!entry.name) throw new Error('name required');
  entry.updatedAt = new Date().toISOString();
  await persistLibrary();
  return entry;
}

export async function deleteCustomTemplate(id) {
  const idx = libraryState.custom.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error('not found');
  libraryState.custom.splice(idx, 1);
  if (libraryState.activeTemplateId === id) {
    libraryState.activeTemplateId = BUILTIN_STANDARD_ID;
    await applyTemplateById(BUILTIN_STANDARD_ID, { skipPersist: true });
  }
  await persistLibrary();
}

export async function duplicateTemplate(id) {
  const custom = libraryState.custom.find((c) => c.id === id);
  const builtin = resolveBuiltinTemplate(id);
  const source = custom || builtin;
  if (!source) throw new Error('not found');
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: custom ? `${custom.name} (${t('templates.copySuffix')})` : `${builtin.name} (${t('templates.copySuffix')})`,
    category: source.category || t('templates.catCustom'),
    fields: cloneFields(source.fields || custom?.fields),
    createdAt: now,
    updatedAt: now,
    source: id,
  };
  libraryState.custom.push(entry);
  libraryState.activeTemplateId = entry.id;
  activeFields = cloneFields(entry.fields);
  await persistLibrary();
  return entry;
}

export function exportTemplateJson(template) {
  const payload = {
    name: template.name,
    category: template.category || '',
    fields: cloneFields(template.fields),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (template.name || 'template').replace(/\s+/g, '_') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importTemplateFromJson(obj) {
  if (!obj || !Array.isArray(obj.fields) || !obj.fields.length) {
    throw new Error('invalid template');
  }
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: String(obj.name || t('templates.imported')).trim() || t('templates.imported'),
    category: String(obj.category || '').trim() || t('templates.catCustom'),
    fields: cloneFields(obj.fields),
    createdAt: now,
    updatedAt: now,
    source: 'import',
  };
  libraryState.custom.push(entry);
  libraryState.activeTemplateId = entry.id;
  activeFields = cloneFields(entry.fields);
  await persistLibrary();
  return entry;
}

export function moveField(index, direction) {
  const next = index + direction;
  if (next < 0 || next >= activeFields.length) return false;
  const [item] = activeFields.splice(index, 1);
  activeFields.splice(next, 0, item);
  return true;
}
