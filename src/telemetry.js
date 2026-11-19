/**
 * Bounded, credential-free telemetry for the plugin's status surface.
 *
 * Only facts a user needs to explain a turn are kept: which physical route
 * answered, how big the request was against that route's budget, how many
 * silent handoffs happened, and why a route is cooling down. Prompts, responses,
 * and credentials never enter this buffer.
 *
 * @module dsh-freellmapi-auto/telemetry
 */

/** How many turns the status surface keeps. */
const TURN_LIMIT = 40

export class Telemetry {
  /**
   * @param {object} [options] - construction options.
   * @param {number} [options.turnLimit] - how many turns to keep.
   * @param {() => number} [options.now] - clock override for tests.
   */
  constructor({ turnLimit = TURN_LIMIT, now = () => Date.now() } = {}) {
    this.turnLimit = turnLimit
    this.now = now
    /** @type {any[]} */
    this.turns = []
    this.counters = {
      turns: 0,
      successes: 0,
      failures: 0,
      attempts: 0,
      fallbacks: 0,
      degradedTurns: 0,
    }
    this.syncedAt = 0
    this.syncReason = 'never'
    this.inventory = { available: false, models: 0, dbPath: '', warnings: [] }
    this.routes = []
  }

  /**
   * Record the inventory state published by the last sync.
   * @param {object} input - sync facts.
   * @param {string} input.reason - why the sync ran.
   * @param {boolean} input.available - whether a usable store was read.
   * @param {number} input.models - how many routes are callable.
   * @param {string} input.dbPath - the store path, for diagnostics.
   * @param {string[]} input.warnings - non-fatal problems.
   * @returns {void}
   */
  noteSync({ reason, available, models, dbPath, warnings }) {
    this.syncedAt = this.now()
    this.syncReason = reason
    this.inventory = {
      available,
      models,
      dbPath,
      warnings: Array.isArray(warnings) ? warnings.slice(0, 8) : [],
    }
  }

  /**
   * Record the routes the adapter advertises.
   * @param {Array<{id: string, name: string, models: number}>} routes - route summary.
   * @returns {void}
   */
  noteRoutes(routes) {
    this.routes = routes
  }

  /**
   * Record one finished model request.
   * @param {object} turn - the turn summary.
   * @param {string} turn.route - the harness route id.
   * @param {string} turn.model - the harness model id.
   * @param {{platform: string, modelId: string, bucket: string} | null} turn.served - the physical route that answered.
   * @param {number} turn.attempts - how many provider attempts ran.
   * @param {number} turn.estTokens - the estimated request size.
   * @param {number | null} turn.tpm - the served route's TPM cap.
   * @param {number | null} turn.contextWindow - the served route's context capacity.
   * @param {number} turn.ttftMs - time to first token.
   * @param {number} turn.totalMs - wall time.
   * @param {boolean} turn.ok - whether a surface answer was produced.
   * @param {string} [turn.errorCode] - the terminal failure code.
   * @param {boolean} turn.degraded - whether the plan came from the degrade step.
   * @param {Record<string, number>} turn.refused - filter refusal counts.
   * @returns {void}
   */
  recordTurn(turn) {
    this.counters.turns += 1
    this.counters.attempts += Math.max(0, turn.attempts)
    this.counters.fallbacks += Math.max(0, turn.attempts - 1)
    if (turn.ok) this.counters.successes += 1
    else this.counters.failures += 1
    if (turn.degraded) this.counters.degradedTurns += 1

    this.turns.push({
      at: this.now(),
      route: turn.route,
      model: turn.model,
      served: turn.served,
      attempts: turn.attempts,
      estTokens: turn.estTokens,
      tpm: turn.tpm,
      contextWindow: turn.contextWindow,
      ttftMs: Math.max(0, Math.round(turn.ttftMs)),
      totalMs: Math.max(0, Math.round(turn.totalMs)),
      ok: turn.ok,
      errorCode: turn.errorCode ?? '',
      degraded: turn.degraded,
      refused: turn.refused,
    })
    while (this.turns.length > this.turnLimit) this.turns.shift()
  }

  /**
   * A detached snapshot for the HTTP status route.
   * @param {{buckets: object[]}} extra - live quota state.
   * @returns {Record<string, unknown>} the status document.
   */
  state(extra = { buckets: [] }) {
    const recent = this.turns.slice(-12).reverse()
    return {
      plugin: 'dsh-freellmapi-auto',
      updatedAt: this.now(),
      counters: { ...this.counters },
      inventory: { ...this.inventory, syncedAt: this.syncedAt, reason: this.syncReason },
      routes: this.routes,
      buckets: extra.buckets,
      recentTurns: recent,
    }
  }
}
