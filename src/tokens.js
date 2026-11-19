/**
 * Request-size estimation used by the context and TPM filters.
 *
 * Exact tokenization is provider-specific, so this estimator answers a different
 * question: "is this request plausibly too large for that route?" It deliberately
 * over-estimates, because under-estimating sends an oversized prompt to a small
 * free tier and spends an attempt on a predictable 413.
 *
 * The harness exposes `tokenMeter.estimateMessage`, and when it is available the
 * estimator defers to it for messages; the local arithmetic stays as the
 * fallback so the plugin also works mounted on its own.
 *
 * @module dsh-freellmapi-auto/tokens
 */

/** Characters per token assumed when nothing better is known; English code and prose both average below 4. */
export const DEFAULT_CHARS_PER_TOKEN = 0.25

/**
 * Estimate the tokens of one string.
 * @param {string} text - the text.
 * @param {number} charsPerToken - tokens per character.
 * @returns {number} a non-negative integer.
 */
export function estimateText(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  if (typeof text !== 'string' || text === '') return 0
  return Math.max(0, Math.ceil(text.length * charsPerToken))
}

/**
 * Estimate the tokens of one content-block array.
 * @param {readonly any[]} blocks - content blocks in request order.
 * @param {{charsPerToken: number, imageTokens: number, fileCharsPerToken: number}} options - estimator knobs.
 * @returns {number} estimated tokens.
 */
export function estimateBlocks(blocks, options) {
  let total = 0
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') {
      total += estimateText(block.text, options.charsPerToken)
    } else if (block.type === 'reasoning') {
      total += estimateText(block.text, options.charsPerToken)
    } else if (block.type === 'tool-call') {
      total += estimateText(block.name, options.charsPerToken) + estimateText(block.arguments, options.charsPerToken)
    } else if (block.type === 'image') {
      // Vision tokens depend on the provider's tiling; a flat conservative
      // estimate is enough to keep an image turn off a tiny text-only quota.
      total += options.imageTokens
    } else if (block.type === 'file') {
      const bytes = typeof block.attachment?.bytes === 'number' ? block.attachment.bytes : 0
      total += Math.ceil(bytes * options.fileCharsPerToken)
    }
  }
  return total
}

/**
 * Estimate the tokens of a full request.
 * @param {object} request - the harness `GenerateOptions`-shaped request.
 * @param {readonly any[]} request.messages - conversation messages.
 * @param {string} [request.system] - one-shot system prompt.
 * @param {readonly any[]} [request.tools] - tool schemas.
 * @param {object} [options] - estimator knobs.
 * @param {number} [options.charsPerToken] - tokens per character.
 * @param {number} [options.toolTokenOverhead] - fixed tokens per tool declaration.
 * @param {number} [options.imageTokens] - tokens per image block.
 * @param {number} [options.fileCharsPerToken] - tokens per attachment byte.
 * @param {{estimateMessage?: (message: any) => number} | undefined} [options.tokenMeter] - harness estimator, when mounted.
 * @returns {number} estimated total tokens.
 */
export function estimateRequestTokens(request, options = {}) {
  const knobs = {
    charsPerToken: options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    toolTokenOverhead: options.toolTokenOverhead ?? 12,
    imageTokens: options.imageTokens ?? 1024,
    fileCharsPerToken: options.fileCharsPerToken ?? 0.25,
  }
  let total = estimateText(request?.system ?? '', knobs.charsPerToken)

  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (typeof options.tokenMeter?.estimateMessage === 'function') {
      try {
        const measured = options.tokenMeter.estimateMessage(message)
        if (Number.isFinite(measured) && measured >= 0) {
          total += measured
          continue
        }
      } catch {
        // Fall through to the local estimator.
      }
    }
    total += estimateBlocks(message.content, knobs)
    // Role, source, and framing overhead the content itself does not pay for.
    total += 4
    if (message.role === 'tool') total += estimateText(message.toolCallId ?? '', knobs.charsPerToken)
  }

  for (const tool of Array.isArray(request?.tools) ? request.tools : []) {
    if (tool === null || typeof tool !== 'object') continue
    total += estimateText(tool.name, knobs.charsPerToken)
      + estimateText(tool.description, knobs.charsPerToken)
      + estimateText(JSON.stringify(tool.parameters ?? {}), knobs.charsPerToken)
      + knobs.toolTokenOverhead
  }

  return Math.max(1, total)
}

/**
 * Describe what one request needs from a route.
 * @param {object} request - the harness request.
 * @param {object} [options] - estimator knobs, plus `margin`.
 * @returns {{tokens: number, needsTools: boolean, needsVision: boolean}} request facts.
 */
export function requestFacts(request, options = {}) {
  const tokens = estimateRequestTokens(request, options) + (options.margin ?? 0)
  const tools = Array.isArray(request?.tools) ? request.tools : []
  let needsVision = false
  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image') {
        needsVision = true
        break
      }
    }
    if (needsVision) break
  }
  return { tokens, needsTools: tools.length > 0, needsVision }
}
