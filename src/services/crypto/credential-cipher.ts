/**
 * AES-256-GCM encryption for target-DB credentials at rest (RT-F7).
 * Uses a dedicated key (`CREDENTIAL_ENC_KEY`, 32-byte hex) separate from any
 * general app secret, a fresh random 12-byte IV per credential, and stores the
 * auth tag alongside the ciphertext. Format: base64(iv | authTag | ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENC_KEY;
  if (!hex) throw new Error('CREDENTIAL_ENC_KEY missing in env');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`CREDENTIAL_ENC_KEY must be 32 bytes (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
