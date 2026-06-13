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

// Inactivity auto-lock, in minutes. Active recording/transcription does not
// count as inactivity.
export const AUTO_LOCK_MINUTES = 5;
