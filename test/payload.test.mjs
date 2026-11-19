import assert from 'node:assert/strict'
import test from 'node:test'

import { buildChatBody, renderContent, toChatMessages, toChatTools } from '../src/payload.js'

test('a leading system message stays a system message and later ones become reminders', () => {
  const messages = toChatMessages({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'new rule' }] },
    ],
  })
  assert.deepEqual(messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: '<system-reminder>\nnew rule\n</system-reminder>' },
  ])
})

test('assistant tool calls are re-serialized with raw JSON arguments', () => {
  const messages = toChatMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a file' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'contents' }] },
    ],
  })
  assert.equal(messages[1].tool_calls[0].function.name, 'read')
  assert.equal(messages[1].tool_calls[0].function.arguments, '{"path":"a.txt"}')
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call-1', content: 'contents' })
})

test('empty assistant turns are dropped instead of sent as empty content', () => {
  const messages = toChatMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }] },
    ],
  })
  assert.equal(messages.length, 1)
})

test('image and file blocks become explicit markers', () => {
  assert.equal(
    renderContent([{ type: 'image', attachment: { name: 'shot.png' } }]),
    '[image omitted: shot.png; this route accepts text only]',
  )
  assert.equal(
    renderContent([{ type: 'file', attachment: { name: 'a.pdf', bytes: 12 } }]),
    '[file omitted: a.pdf; 12 bytes]',
  )
})

test('tool schemas keep their JSON Schema object', () => {
  const tools = toChatTools([{ name: 'read', description: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } } } }])
  assert.equal(tools[0].type, 'function')
  assert.deepEqual(tools[0].function.parameters.properties.p, { type: 'string' })
})

test('the body omits optional fields it does not need', () => {
  const body = buildChatBody({ request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, model: 'auto-x' })
  assert.equal(body.model, 'auto-x')
  assert.equal(body.stream, true)
  assert.equal('tools' in body, false)
  assert.equal('stream_options' in body, false)
  assert.equal('max_tokens' in body, false)

  const full = buildChatBody({
    request: { messages: [], tools: [{ name: 't', description: '', parameters: {} }], stop: ['x'] },
    model: 'm',
    maxTokens: 64,
    temperature: 0.2,
    includeUsage: true,
  })
  assert.equal(full.max_tokens, 64)
  assert.equal(full.temperature, 0.2)
  assert.deepEqual(full.stop, ['x'])
  assert.deepEqual(full.stream_options, { include_usage: true })
  assert.equal(full.tools.length, 1)
})
