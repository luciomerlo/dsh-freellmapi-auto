/**
 * Decryption of the API keys FreeLLMAPI stored.
 *
 * The desktop app encrypts every key with AES-256-GCM under a random key it
 * keeps beside the database. Reading a key therefore needs the 32-byte key file,
 * the per-row IV, and the per-row authentication tag; nothing is derived from
 * the machine, and the plaintext never leaves this process.
 *
 * @module dsh-freellmapi-auto/keys
 */

import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Size of the store's encryption key, in bytes. */
export const KEY_BYTES = 32

/**
 * Read the store encryption key.
 * @param {string} path - absolute path of the key file.
 * @returns {Buffer | undefined} the key, when the file holds a usable hex string.
 */
export function readEncryptionKey(path) {
  if (path === '') return undefined
  let raw
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_BYTES * 2) return undefined
  return Buffer.from(raw, 'hex')
}

/**
 * Decrypt one stored secret.
 *
 * The plaintext is the raw credential, not JSON and not base64, so it is returned
 * as text and trimmed: a trailing newline inside such a value is a support ticket
 * waiting to happen.
 *
 * @param {Buffer} key - the 32-byte store key.
 * @param {{encryptedKey: string, iv: string, authTag: string}} material - hex-encoded ciphertext, IV, and tag.
 * @returns {string | undefined} the secret, when authentication succeeds.
 */
export function decryptSecret(key, material) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return undefined
  const ciphertext = hexToBuffer(material?.encryptedKey)
  const iv = hexToBuffer(material?.iv)
  const authTag = hexToBuffer(material?.authTag)
  if (ciphertext === undefined || iv === undefined || authTag === undefined) return undefined
  if (iv.length === 0 || authTag.length === 0) return undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const secret = plaintext.toString('utf8').trim()
    return secret === '' ? undefined : secret
  } catch {
    // A wrong key, a rotated row, or a truncated value all land here.
    return undefined
  }
}

/**
 * Parse a hex string into bytes.
 * @param {unknown} value - the candidate value.
 * @returns {Buffer | undefined} the bytes, when the value is valid hex.
 */
export function hexToBuffer(value) {
  if (typeof value !== 'string' || value === '' || value.length % 2 !== 0) return undefined
  if (!/^[0-9a-fA-F]+$/.test(value)) return undefined
  return Buffer.from(value, 'hex')
}

/**
 * A stable, non-reversible fingerprint of one secret.
 *
 * Bucket health is keyed by it so two rows holding the same credential share one
 * quota, and so diagnostics can name a key without ever printing it.
 *
 * @param {string} secret - the credential.
 * @returns {string} a short hex digest.
 */
export function keyFingerprint(secret) {
  if (typeof secret !== 'string' || secret === '') return 'none'
  let hash = 0x811c9dc5
  for (let index = 0; index < secret.length; index += 1) {
    hash ^= secret.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
