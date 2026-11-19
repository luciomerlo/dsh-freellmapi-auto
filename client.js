/**
 * Browser half: a compact router-status cell under the composer.
 *
 * The cell reads the Host status route this plugin owns and draws the facts a
 * user needs to trust a free-model turn: which physical route answered, how the
 * request compared with that route's per-minute budget, how many silent
 * handoffs happened, and which routes are cooling down.
 *
 * Everything is disposable: the poll interval is created in `apply` and cleared
 * with the plugin, so disabling the bundle never leaves a timer behind.
 *
 * @module dsh-freellmapi-auto/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-freellmapi-auto',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const STATUS_PATH = '/freellmapi-auto/status'
    const SYNC_PATH = '/freellmapi-auto/sync'
    const POLL_MS = 5000

    const STRINGS = {
      en: {
        cell: 'FreeLLMApi router',
        idle: 'No routed turns yet',
        serving: 'Served by',
        budget: 'budget',
        fallbacks: 'fallbacks',
        attempts: 'attempts',
        cooling: 'Cooling down',
        routes: 'reachable routes',
        sync: 'Resync inventory',
        syncing: 'Syncing…',
        unavailable: 'FreeLLMAPI store unavailable',
        noCooldown: 'Nothing cooling down',
        recent: 'Recent turns',
        degraded: 'degraded',
        collapse: 'Hide router details',
        expand: 'Show router details',
      },
      es: {
        cell: 'Enrutador FreeLLMApi',
        idle: 'Todavía no hay turnos enrutados',
        serving: 'Atendido por',
        budget: 'presupuesto',
        fallbacks: 'conmutaciones',
        attempts: 'intentos',
        cooling: 'En enfriamiento',
        routes: 'rutas alcanzables',
        sync: 'Resincronizar inventario',
        syncing: 'Sincronizando…',
        unavailable: 'Almacén de FreeLLMAPI no disponible',
        noCooldown: 'Nada en enfriamiento',
        recent: 'Turnos recientes',
        degraded: 'degradado',
        collapse: 'Ocultar detalles del enrutador',
        expand: 'Mostrar detalles del enrutador',
      },
    }

    /**
     * Pick the dictionary for the active page language.
     * @returns {Record<string, string>} the active strings.
     */
    function strings() {
      const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : 'en'
      return language.startsWith('es') ? STRINGS.es : STRINGS.en
    }

    /**
     * Compact token count.
     * @param {number} value - token count.
     * @returns {string} the formatted value.
     */
    function tokens(value) {
      if (!Number.isFinite(value)) return '?'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(Math.round(value))
    }

    /**
     * Compact duration.
     * @param {number} ms - milliseconds.
     * @returns {string} the formatted value.
     */
    function duration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0s'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${String(seconds)}s`
      return `${String(Math.round(seconds / 60))}m`
    }

    const styles = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        font: '400 12px/1.4 ui-sans-serif, system-ui, sans-serif',
        color: 'var(--dsw-alias-text-secondary, #6b7280)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        padding: '2px 0',
      },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-accent, #2563eb)',
        flex: '0 0 auto',
      },
      dotIdle: { background: 'var(--dsw-alias-text-tertiary, #9ca3af)' },
      dotBad: { background: 'var(--dsw-alias-danger, #dc2626)' },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        borderRadius: '8px',
        padding: '8px 10px',
        background: 'var(--dsw-alias-surface-raised, rgba(127,127,127,0.06))',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      muted: { opacity: 0.75 },
      list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '3px' },
      action: {
        alignSelf: 'flex-start',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        borderRadius: '6px',
        padding: '2px 8px',
        cursor: 'pointer',
      },
    }

    /**
     * One line describing the last routed turn.
     * @param {any} turn - the turn record.
     * @param {Record<string, string>} t - the active strings.
     * @returns {any} a React node.
     */
    function turnLine(turn, t) {
      const served = turn.served
      const route = served === null || served === undefined
        ? '—'
        : `${served.platform} → ${served.modelId}`
      return h('li', { key: `${String(turn.at)}-${route}`, style: styles.row }, [
        h('span', { key: 'route', style: styles.mono }, route),
        h('span', { key: 'tokens', style: styles.muted }, `${tokens(turn.estTokens)}/${turn.tpm === null ? '?' : tokens(turn.tpm)}`),
        h('span', { key: 'attempts', style: styles.muted }, `${String(turn.attempts)} ${t.attempts}`),
        turn.ok ? null : h('span', { key: 'err', style: styles.mono }, turn.errorCode || 'error'),
        turn.degraded ? h('span', { key: 'deg', style: styles.muted }, t.degraded) : null,
      ])
    }

    /**
     * The dock cell.
     * @returns {any} a React node.
     */
    function RouterStatus() {
      const t = useMemo(strings, [])
      const [state, setState] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`status ${String(response.status)}`)
          setState(await response.json())
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const resync = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(SYNC_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) setState(await response.json())
        } catch {
          // The next poll reports the failure.
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [load])

      const counters = state?.counters ?? { turns: 0, fallbacks: 0, failures: 0 }
      const lastTurn = state?.recentTurns?.[0]
      const inventory = state?.inventory ?? { available: false, models: 0 }
      const buckets = Array.isArray(state?.buckets) ? state.buckets : []
      const cooling = buckets.filter((bucket) => bucket.coolingMs > 0)
      const serving = lastTurn?.served

      const headline = serving === null || serving === undefined
        ? t.idle
        : `${t.serving} ${serving.platform} → ${serving.modelId}`
      const budget = lastTurn === undefined
        ? ''
        : `${tokens(lastTurn.estTokens)} / ${lastTurn.tpm === null ? '?' : tokens(lastTurn.tpm)} ${t.budget}`

      return h('div', { style: styles.wrap }, [
        h('div', { key: 'row', style: styles.row }, [
          h('button', {
            key: 'toggle',
            type: 'button',
            style: styles.button,
            'aria-expanded': open,
            'aria-label': open ? t.collapse : t.expand,
            onClick: () => { setOpen((value) => !value) },
          }, [
            h('span', {
              key: 'dot',
              style: {
                ...styles.dot,
                ...(error !== '' || inventory.available === false ? styles.dotBad : {}),
                ...(counters.turns === 0 && error === '' ? styles.dotIdle : {}),
              },
            }),
            h('span', { key: 'label', style: styles.mono }, t.cell),
            h('span', { key: 'headline' }, headline),
            budget === '' ? null : h('span', { key: 'budget', style: styles.muted }, budget),
            h('span', { key: 'fallbacks', style: styles.muted }, `${String(counters.fallbacks)} ${t.fallbacks}`),
            cooling.length === 0
              ? null
              : h('span', { key: 'cooling', style: styles.muted }, `${String(cooling.length)} ${t.cooling.toLowerCase()}`),
          ]),
          open ? h('button', {
            key: 'resync',
            type: 'button',
            style: styles.action,
            disabled: busy,
            onClick: () => { void resync() },
          }, busy ? t.syncing : t.sync) : null,
        ]),
        open ? h('div', { key: 'panel', style: styles.panel }, [
          h('div', { key: 'summary', style: styles.row }, [
            h('span', { key: 'routes', style: styles.muted }, `${String(inventory.models)} ${t.routes}`),
            h('span', { key: 'turns', style: styles.muted }, `${String(counters.turns)} turns`),
            h('span', { key: 'fails', style: styles.muted }, `${String(counters.failures)} failures`),
            inventory.available === false
              ? h('span', { key: 'unavailable', style: styles.mono }, t.unavailable)
              : null,
          ]),
          h('div', { key: 'cool', style: styles.row }, [
            h('strong', { key: 'label' }, t.cooling),
            cooling.length === 0
              ? h('span', { key: 'none', style: styles.muted }, t.noCooldown)
              : h('span', { key: 'list', style: styles.mono }, cooling
                .slice(0, 6)
                .map((bucket) => `${bucket.bucket} ${duration(bucket.coolingMs)} ${bucket.cooldownCode}`)
                .join(' · ')),
          ]),
          h('div', { key: 'recentTitle', style: styles.muted }, t.recent),
          h('ul', { key: 'recent', style: styles.list },
            (state?.recentTurns ?? []).slice(0, 6).map((turn) => turnLine(turn, t))),
          error === ''
            ? null
            : h('div', { key: 'error', style: styles.mono }, `${t.unavailable}: ${error}`),
        ]) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'freellmapi-status',
          order: 2,
        }, RouterStatus))
      },
    }
  },
})
