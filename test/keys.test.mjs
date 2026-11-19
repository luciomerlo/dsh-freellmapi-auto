import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decryptSecret, hexToBuffer, keyFingerprint, readEncryptionKey } from '../src/keys.js'

/**
 * Encrypt a secret the way the FreeLLMAPI desktop app does.
 * @param {Buffer} key - the 32-byte store key.
 * @param {string} secret - the plaintext.
 * @returns {{encryptedKey: string, iv: string, authTag: string}} the stored material.
 */
function encrypt(key, secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    encryptedKey: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  }
}

test('a stored secret decrypts back to its plaintext', () => {
  const key = randomBytes(32)
  const material = encrypt(key, 'gsk_example_credential_123')
  assert.equal(decryptSecret(key, material), 'gsk_example_credential_123')
})

test('a wrong key or a tampered tag yields no secret instead of throwing', () => {
  const key = randomBytes(32)
  const material = encrypt(key, 'secret-value')
  assert.equal(decryptSecret(randomBytes(32), material), undefined)
  assert.equal(decryptSecret(key, { ...material, authTag: '00'.repeat(16) }), undefined)
  assert.equal(decryptSecret(key, { ...material, encryptedKey: 'zz' }), undefined)
  assert.equal(decryptSecret(Buffer.alloc(16), material), undefined)
})

test('the key file must hold exactly 32 hex-encoded bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freellmapi-keys-'))
  const good = join(dir, '.encryption-key')
  writeFileSync(good, `${'ab'.repeat(32)}\n`, 'utf8')
  const key = readEncryptionKey(good)
  assert.ok(Buffer.isBuffer(key))
  assert.equal(key.length, 32)

  const short = join(dir, 'short.key')
  writeFileSync(short, 'abcd', 'utf8')
  assert.equal(readEncryptionKey(short), undefined)

  const missing = join(dir, 'nope.key')
  assert.equal(readEncryptionKey(missing), undefined)
  assert.equal(readEncryptionKey(''), undefined)
})

test('hex parsing rejects odd lengths and foreign characters', () => {
  assert.equal(hexToBuffer('abcd').length, 2)
  assert.equal(hexToBuffer('abc'), undefined)
  assert.equal(hexToBuffer('zzzz'), undefined)
  assert.equal(hexToBuffer(42), undefined)
})

test('fingerprints are stable and short enough to log', () => {
  const first = keyFingerprint('sk-same')
  assert.equal(first, keyFingerprint('sk-same'))
  assert.notEqual(first, keyFingerprint('sk-different'))
  assert.equal(first.length, 8)
  assert.equal(keyFingerprint(''), 'none')
})
