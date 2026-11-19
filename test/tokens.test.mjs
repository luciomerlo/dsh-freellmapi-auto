import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateBlocks, estimateRequestTokens, estimateText, requestFacts } from '../src/tokens.js'

test('text estimation scales with length and never returns a fraction', () => {
  assert.equal(estimateText('', 0.25), 0)
  assert.equal(estimateText('abcd', 0.25), 1)
  assert.equal(estimateText('a'.repeat(100), 0.25), 25)
})

test('a request estimate counts system, messages, tools, and images', () => {
  const request = {
    system: 'a'.repeat(400),
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'b'.repeat(400) }] },
      { role: 'user', content: [{ type: 'text', text: 'c'.repeat(400) }, { type: 'image', attachment: { bytes: 10 } }] },
    ],
    tools: [{
      name: 'read',
      description: 'd'.repeat(40),
      parameters: { type: 'object', properties: {} },
    }],
  }
  const tokens = estimateRequestTokens(request, { charsPerToken: 0.25, toolTokenOverhead: 12, imageTokens: 1000 })
  // 100 (system) + 100 (message) + 100 + 1000 (image) + 8 framing + tool text + overhead
  assert.ok(tokens > 1300, String(tokens))
  assert.ok(tokens < 1400, String(tokens))
})

test('the harness token meter wins over the local estimate when it answers', () => {
  const request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }] }
  const withMeter = estimateRequestTokens(request, {
    charsPerToken: 0.25,
    tokenMeter: { estimateMessage: () => 7 },
  })
  assert.equal(withMeter, 7)

  const withBrokenMeter = estimateRequestTokens(request, {
    charsPerToken: 0.25,
    tokenMeter: { estimateMessage: () => { throw new Error('no') } },
  })
  assert.equal(withBrokenMeter, 1000 + 4)
})

test('request facts report tool and vision needs', () => {
  const facts = requestFacts({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }],
    tools: [{ name: 'x', description: '', parameters: {} }],
  })
  assert.equal(facts.needsTools, true)
  assert.equal(facts.needsVision, true)
  assert.ok(facts.tokens > 0)
})

test('file blocks are priced by attachment size', () => {
  const tokens = estimateBlocks([{ type: 'file', attachment: { bytes: 4000 } }], {
    charsPerToken: 0.25,
    imageTokens: 0,
    fileCharsPerToken: 0.25,
  })
  assert.equal(tokens, 1000)
})
