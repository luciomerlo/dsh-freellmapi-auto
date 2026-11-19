import assert from 'node:assert/strict'
import test from 'node:test'

import { RouteError, codeForStatus, failureFacts, isRecoverable, retryAfterMs } from '../src/errors.js'

test('HTTP statuses map onto stable routing codes', () => {
  assert.equal(codeForStatus(429), 'RATE_LIMIT')
  assert.equal(codeForStatus(429, 'too many tokens in the window'), 'TPM_EXCEEDED')
  assert.equal(codeForStatus(413), 'PAYLOAD_TOO_LARGE')
  assert.equal(codeForStatus(400, 'This model maximum context length is 8192 tokens'), 'CONTEXT_WINDOW')
  assert.equal(codeForStatus(400, 'bad tool schema'), 'INVALID_REQUEST')
  assert.equal(codeForStatus(401), 'AUTH')
  assert.equal(codeForStatus(402), 'QUOTA')
  assert.equal(codeForStatus(403, 'quota exceeded'), 'QUOTA')
  assert.equal(codeForStatus(503), 'SERVER_ERROR')
  assert.equal(codeForStatus(418), 'PROVIDER_ERROR')
})

test('recoverable codes describe routes another provider can serve', () => {
  for (const code of ['RATE_LIMIT', 'TPM_EXCEEDED', 'PAYLOAD_TOO_LARGE', 'CONTEXT_WINDOW', 'SERVER_ERROR', 'TIMEOUT', 'STREAM_STALLED', 'EMPTY_RESPONSE']) {
    assert.equal(isRecoverable(code), true, code)
  }
  for (const code of ['AUTH', 'INVALID_REQUEST', 'ABORTED', 'UNNAMED_TOOL_CALL']) {
    assert.equal(isRecoverable(code), false, code)
  }
})

test('a RouteError round-trips into harness failure facts', () => {
  const error = new RouteError({
    message: 'cerebras: 429 slow down',
    code: 'RATE_LIMIT',
    status: 429,
    providerRetryAfterMs: 2500,
    provider: 'cerebras:1',
    model: 'qwen-3-coder',
  })
  assert.deepEqual(error.toFailure(), {
    message: 'cerebras: 429 slow down',
    code: 'RATE_LIMIT',
    status: 429,
    providerRetryAfterMs: 2500,
  })
  assert.deepEqual(failureFacts(error), error.toFailure())
})

test('aborts are reported as ABORTED even when the cause is a plain rejection', () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(failureFacts(new Error('boom'), controller.signal).code, 'ABORTED')
  assert.equal(failureFacts(Object.assign(new Error('x'), { code: 'ECONNRESET' })).code, 'ECONNRESET')
  assert.equal(failureFacts(new Error('socket timed out')).code, 'TIMEOUT')
})

test('an AbortError without a cancelled request is a transport timeout', () => {
  const abortError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' })
  assert.equal(failureFacts(abortError).code, 'TIMEOUT')
  assert.equal(failureFacts(abortError, new AbortController().signal).code, 'TIMEOUT')

  const controller = new AbortController()
  controller.abort()
  assert.equal(failureFacts(abortError, controller.signal).code, 'ABORTED')
})

test('Retry-After parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('3'), 3000)
  const future = new Date(Date.now() + 5000).toUTCString()
  const parsed = retryAfterMs(future)
  assert.ok(parsed !== undefined && parsed > 0 && parsed <= 6000)
  assert.equal(retryAfterMs(''), undefined)
  assert.equal(retryAfterMs(null), undefined)
  assert.equal(retryAfterMs('soon'), undefined)
})
