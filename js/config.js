// Access configuration. This file is served to every browser and is safe to
// expose: the tokens below are PBKDF2+HKDF derivations of username+password
// pairs. They reveal nothing about who the users are or what their passwords
// look like, and they are not the encryption key (that is derived separately
// and never stored).
//
// To add or remove a clinician: open tools/generate-token.html (serve the app
// locally, do NOT deploy that page), enter their username and password, and
// paste the resulting token into the array below.

export const APPROVED_ACCESS_TOKENS = [
  // Demo account — username: demo / password: whisper-demo
  // REPLACE this with your own clinicians' tokens before real use.
  '70d99654b17820287cc404d338e709e56803335426cb6b4744104f6bef64d9e4',
];

// PBKDF2 work factor. Higher = slower brute-force attacks, but also a slower
// login (~0.5s at 600k on typical hardware). Changing this invalidates all
// existing tokens AND all encrypted data — set it once, before rollout.
export const PBKDF2_ITERATIONS = 600000;

// Inactivity auto-lock, in minutes. Active recording/transcription and unsaved
// audio or drafts do not count as inactivity.
export const AUTO_LOCK_MINUTES = 30;

// Default Whisper model (multilingual). Options offered in the UI:
//   'onnx-community/whisper-large-v3-turbo' — fast + accurate (default)
//   'Xenova/whisper-medium'                 — lighter, for weaker PCs
//   'Xenova/whisper-large-v3'               — best accuracy, needs a strong GPU
export const DEFAULT_MODEL = 'onnx-community/whisper-large-v3-turbo';

// Default transcription language ('nl' = Dutch). Set to 'en' for English.
export const DEFAULT_LANGUAGE = 'nl';

// Chunked LLM correction for long consults (see js/correction-chunks.js).
export const CORRECTION_SINGLE_PASS_MAX_WORDS = 500;
export const CORRECTION_TARGET_WORDS_MIN = 600;
export const CORRECTION_TARGET_WORDS_MAX = 900;
export const CORRECTION_TARGET_DURATION_SEC = 180;
export const CORRECTION_OVERLAP_SENTENCES = 3;
export const CORRECTION_OVERLAP_WORDS_MAX = 120;

// Form extraction: max numbered transcript length sent to the local LLM.
export const EXTRACT_MAX_TRANSCRIPT_CHARS = 8000;
