// Dutch clinical-importance lexicon (seed data) + detection helpers.
//
// This drives the "clinical importance" component of the uncertainty score and
// the "likely medical term" detection used to flag (never silently replace)
// passages. It is intentionally a conservative starter set; Phase 2 adds rich,
// user-extensible local dictionaries on top of this.
//
// SAFETY: nothing here mutates the transcript. These helpers only *detect* and
// *score* so the system can flag passages for the clinician.

// Negation / change-of-state words: getting these wrong inverts clinical
// meaning, so any uncertainty around them is high risk.
export const NEGATION_TERMS = [
  'geen', 'niet', 'zonder', 'noch', 'nooit', 'negatief',
  'wel', 'positief',
  'toegenomen', 'afgenomen', 'verbeterd', 'verslechterd',
  'gestopt', 'gestaakt', 'hervat',
];

// Laterality: left/right confusion is a classic, high-consequence ASR error.
export const LATERALITY_TERMS = [
  'links', 'linker', 'linkszijdig', 'linkerzijde',
  'rechts', 'rechter', 'rechtszijdig', 'rechterzijde',
  'bilateraal', 'beiderzijds', 'dubbelzijdig', 'mediaan', 'centraal',
];

// Allergy cues — always high importance.
export const ALLERGY_TERMS = ['allergie', 'allergisch', 'overgevoelig', 'intolerantie', 'anafylaxie'];

// Common Dutch dosage/measurement units (lower-cased, punctuation-stripped).
export const UNIT_TERMS = [
  'mg', 'mcg', 'µg', 'ug', 'g', 'gram', 'ml', 'cc', 'l', 'liter',
  'mmol', 'mol', 'ie', 'eenheid', 'eenheden', 'tablet', 'tabletten',
  'capsule', 'capsules', 'druppel', 'druppels', 'puff', 'puffs',
  'dd', 'd.d.', 'maal', 'keer', 'x', 'per', 'kg', 'mmhg', 'bpm',
];

// A small seed of medications, anatomy, diagnoses, procedures and abbreviations.
// Used to recognise "this looks like a medical term" so near-misses can be
// flagged. NOT used for automatic replacement.
export const MEDICATIONS = [
  'paracetamol', 'ibuprofen', 'metformine', 'metoprolol', 'amlodipine',
  'simvastatine', 'atorvastatine', 'omeprazol', 'pantoprazol', 'amoxicilline',
  'augmentin', 'azitromycine', 'prednison', 'prednisolon', 'salbutamol',
  'acetylsalicylzuur', 'ascal', 'clopidogrel', 'apixaban', 'rivaroxaban',
  'enalapril', 'lisinopril', 'losartan', 'furosemide', 'hydrochloorthiazide',
  'insuline', 'levothyroxine', 'diazepam', 'oxazepam', 'tramadol', 'morfine',
  'codeine', 'fentanyl', 'gabapentine', 'pregabaline', 'sertraline',
  'citalopram', 'fluoxetine', 'nitrofurantoine', 'ciprofloxacine',
];

export const ANATOMY = [
  'knie', 'heup', 'schouder', 'elleboog', 'pols', 'enkel', 'voet', 'hand',
  'thorax', 'borst', 'buik', 'abdomen', 'rug', 'wervelkolom', 'nek', 'hoofd',
  'hart', 'long', 'longen', 'lever', 'nier', 'nieren', 'milt', 'maag',
  'darm', 'blaas', 'prostaat', 'hersenen', 'huid', 'oog', 'oor', 'keel',
];

export const DIAGNOSES = [
  'diabetes', 'hypertensie', 'astma', 'copd', 'pneumonie', 'bronchitis',
  'migraine', 'artrose', 'artritis', 'fractuur', 'infarct', 'angina',
  'depressie', 'angststoornis', 'anemie', 'hypothyreoidie', 'hyperthyreoidie',
  'dyspneu', 'dyspnoe', 'koorts', 'sepsis', 'trombose', 'embolie',
];

export const PROCEDURES = [
  'echo', 'rontgen', 'röntgen', 'ct', 'mri', 'scopie', 'gastroscopie',
  'colonoscopie', 'biopt', 'biopsie', 'operatie', 'punctie', 'katheter',
  'infuus', 'bloedonderzoek', 'ecg', 'spirometrie',
];

// Common Dutch medical abbreviations -> meaning (context-dependent, so we expand
// only via explicit correction rules, never automatically here).
export const ABBREVIATIONS = {
  rr: 'bloeddruk (Riva-Rocci)',
  asa: 'acetylsalicylzuur',
  cva: 'cerebrovasculair accident',
  copd: 'chronic obstructive pulmonary disease',
  dm: 'diabetes mellitus',
  ecg: 'elektrocardiogram',
  hb: 'hemoglobine',
  crp: 'C-reactief proteïne',
  pob: 'pijn op de borst',
  vg: 'voorgeschiedenis',
  dd: 'differentiaaldiagnose / per dag',
};

const MEDICAL_SET = new Set(
  [...MEDICATIONS, ...ANATOMY, ...DIAGNOSES, ...PROCEDURES].map((t) => t.toLowerCase()),
);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[.,;:!?()[\]"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function hasAny(tokens, list) {
  const set = list instanceof Set ? list : new Set(list.map((t) => String(t).toLowerCase()));
  return tokens.some((t) => set.has(t));
}

const NUMBER_RE = /\b\d+([.,]\d+)?\b/;
const DOSAGE_RE = new RegExp(
  '\\b\\d+([.,]\\d+)?\\s*(' +
    UNIT_TERMS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')\\b',
  'i',
);
const DATE_RE = /\b(\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?|\d{1,2}\s+(jan|feb|maart|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)[a-z]*)\b/i;

// Inspects a passage and returns which clinically important categories it
// touches, plus an overall importance score in [0,1]. Higher = more dangerous
// to get wrong, so more deserving of a red/yellow flag when uncertain.
export function analyzeClinicalImportance(text) {
  const tokens = tokenize(text);
  const triggers = [];

  if (hasAny(tokens, NEGATION_TERMS)) triggers.push('negation');
  if (hasAny(tokens, LATERALITY_TERMS)) triggers.push('laterality');
  if (hasAny(tokens, ALLERGY_TERMS)) triggers.push('allergy');
  if (DOSAGE_RE.test(text)) triggers.push('dosage');
  else if (hasAny(tokens, UNIT_TERMS)) triggers.push('dosage');
  if (DATE_RE.test(text)) triggers.push('date');
  else if (NUMBER_RE.test(text)) triggers.push('number');
  if (hasAny(tokens, new Set(MEDICATIONS.map((t) => t.toLowerCase())))) triggers.push('medication');
  if (hasAny(tokens, new Set(ANATOMY.map((t) => t.toLowerCase())))) triggers.push('anatomy');
  if (hasAny(tokens, new Set(DIAGNOSES.map((t) => t.toLowerCase())))) triggers.push('diagnosis');
  if (hasAny(tokens, new Set(PROCEDURES.map((t) => t.toLowerCase())))) triggers.push('procedure');

  // Weight categories by clinical consequence of an error.
  const weights = {
    negation: 1.0, laterality: 1.0, medication: 0.9, dosage: 0.9, allergy: 0.9,
    diagnosis: 0.7, number: 0.6, date: 0.5, anatomy: 0.5, procedure: 0.4,
  };
  let score = 0;
  for (const t of triggers) score = Math.max(score, weights[t] || 0.3);

  return { triggers, importance: score };
}

// True if the token looks like a medical term we recognise (used to detect
// likely-misheard medical words for flagging, never auto-replacement).
export function isLikelyMedicalTerm(word) {
  return MEDICAL_SET.has(String(word || '').toLowerCase());
}

// Returns recognised dictionary terms present in the text, so they can be passed
// to the correction LLM as "known correct spellings" context.
export function findKnownTerms(text) {
  const tokens = tokenize(text);
  const found = new Set();
  for (const t of tokens) if (MEDICAL_SET.has(t)) found.add(t);
  return [...found];
}
