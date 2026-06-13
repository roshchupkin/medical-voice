// AES-GCM helpers for encrypting records at rest, bound to the current
// login session's key. A fresh random 96-bit IV is used per record, stored
// alongside the ciphertext (the IV is not secret).

import { getSession } from './auth.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomIv() {
  return crypto.getRandomValues(new Uint8Array(12));
}

export async function encryptBytes(arrayBuffer) {
  const { key } = getSession();
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  return { iv, ciphertext };
}

export async function decryptBytes(iv, ciphertext) {
  const { key } = getSession();
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

export async function encryptJSON(value) {
  return encryptBytes(textEncoder.encode(JSON.stringify(value)));
}

export async function decryptJSON(iv, ciphertext) {
  const plain = await decryptBytes(iv, ciphertext);
  return JSON.parse(textDecoder.decode(plain));
}

export async function encryptBlob(blob) {
  return encryptBytes(await blob.arrayBuffer());
}

export async function decryptBlob(iv, ciphertext, mimeType) {
  const plain = await decryptBytes(iv, ciphertext);
  return new Blob([plain], { type: mimeType || 'application/octet-stream' });
}
