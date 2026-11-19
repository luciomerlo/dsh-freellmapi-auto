/**
 * Request serialization: harness messages in, OpenAI Chat Completions out.
 *
 * The harness history is provider-neutral. This module projects it onto the one
 * dialect FreeLLMAPI's free gateways agree on, which means three unavoidable
 * lossy decisions:
 *
 *  - reasoning blocks are never sent back (no gateway accepts another model's
 *    thinking, and several reject the field outright);
 *  - image blocks become a short text marker, because this route advertises text
 *    only; the harness still keeps the image in history for a vision route;
 *  - non-leading system text is wrapped as a `<system-reminder>` user message,
 *    since only the first system message is honoured by most gateways.
 *
 * @module dsh-freellmapi-auto/payload
 */

/**
 * Flatten text blocks of one message.
 * @param {readonly any[]} blocks - content blocks.
 * @returns {string} the text.
 */
export function textOf(blocks) {
  const parts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Project one image or file block as model-visible text.
 * @param {any} block - the block.
 * @returns {string} the marker text.
 */
function markerOf(block) {
  if (block?.type === 'image') {
    const name = typeof block.attachment?.name === 'string' && block.attachment.name !== '' ? block.attachment.name : 'image'
    return `[image omitted: ${name}; this route accepts text only]`
  }
  if (block?.type === 'file') {
    const name = typeof block.attachment?.name === 'string' && block.attachment.name !== '' ? block.attachment.name : 'file'
    const bytes = typeof block.attachment?.bytes === 'number' ? block.attachment.bytes : 0
    return `[file omitted: ${name}; ${String(bytes)} bytes]`
  }
  return ''
}

/**
 * Render one user or tool-result content array as text.
 * @param {readonly any[]} blocks - content blocks.
 * @returns {string} the text.
 */
export function renderContent(blocks) {
  const parts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image' || block?.type === 'file') parts.push(markerOf(block))
  }
  return parts.join('\n')
}

/**
 * Convert harness messages into Chat Completions messages.
 * @param {object} request - the harness request.
 * @param {readonly any[]} request.messages - conversation messages.
 * @param {string} [request.system] - one-shot system prompt.
 * @returns {any[]} the wire messages.
 */
export function toChatMessages(request) {
  /** @type {any[]} */
  const messages = []
  if (typeof request.system === 'string' && request.system.trim() !== '') {
    messages.push({ role: 'system', content: request.system })
  }

  let leading = true
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.trim() === '') continue
      if (leading) messages.push({ role: 'system', content: text })
      else messages.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` })
      continue
    }
    leading = false

    if (message.role === 'developer') {
      const text = textOf(message.content)
      if (text.trim() !== '') messages.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` })
      continue
    }

    if (message.role === 'user') {
      messages.push({ role: 'user', content: renderContent(message.content) })
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content)
      const toolCalls = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== 'tool-call') continue
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: {
            name: String(block.name),
            arguments: typeof block.arguments === 'string' && block.arguments !== '' ? block.arguments : '{}',
          },
        })
      }
      if (text.trim() === '' && toolCalls.length === 0) continue
      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      })
      continue
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? ''),
        content: renderContent(message.content),
      })
    }
  }
  return messages
}

/**
 * Convert harness tool schemas into Chat Completions tools.
 * @param {readonly any[]} [tools] - tool schemas.
 * @returns {any[]} the wire tools; empty when the request declares none.
 */
export function toChatTools(tools) {
  const result = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== 'object') continue
    result.push({
      type: 'function',
      function: {
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return result
}

/**
 * Build the request body for one attempt.
 * @param {object} input - body inputs.
 * @param {object} input.request - the harness request.
 * @param {string} input.model - upstream model id.
 * @param {number} [input.maxTokens] - output cap.
 * @param {number} [input.temperature] - sampling temperature.
 * @param {boolean} [input.includeUsage] - ask the gateway to report usage in-stream.
 * @returns {Record<string, unknown>} the JSON body.
 */
export function buildChatBody({ request, model, maxTokens, temperature, includeUsage = false }) {
  const messages = toChatMessages(request)
  const tools = toChatTools(request.tools)
  const body = {
    model,
    messages,
    stream: true,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(request.stop === undefined || request.stop.length === 0 ? {} : { stop: request.stop }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
  }
  return body
}
