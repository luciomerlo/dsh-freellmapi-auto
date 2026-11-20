/**
 * Browser half: the FreeLLMAPI connection page in Settings.
 *
 * The page answers one question — "is this plugin talking to my FreeLLMAPI
 * install, and through which door?" — and lets the user fix the answer: pick the
 * transport, auto-detect the proxy port, or type one. Nothing here touches the
 * store or a credential; the Host resolves both and returns only status facts.
 *
 * @module dsh-freellmapi-auto/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-freellmapi-auto',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const SETTINGS_PATH = '/freellmapi-auto/settings'
    const DETECT_PATH = '/freellmapi-auto/detect'

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        font: '400 13px/1.5 ui-sans-serif, system-ui, sans-serif',
        color: 'var(--dsw-alias-text, #111827)',
        maxWidth: '720px',
        padding: '4px 2px 24px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'var(--dsw-alias-surface-raised, rgba(127,127,127,0.05))',
      },
      title: { font: '600 14px/1.4 inherit', margin: 0 },
      hint: { color: 'var(--dsw-alias-text-secondary, #6b7280)', margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      label: { minWidth: '92px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      input: {
        font: 'inherit',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        background: 'var(--dsw-alias-surface, transparent)',
        color: 'inherit',
        minWidth: '120px',
      },
      select: {
        font: 'inherit',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        background: 'var(--dsw-alias-surface, transparent)',
        color: 'inherit',
      },
      button: {
        font: 'inherit',
        padding: '5px 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        borderColor: 'var(--dsw-alias-accent, #2563eb)',
        background: 'var(--dsw-alias-accent, #2563eb)',
        color: '#fff',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      ok: { color: 'var(--dsw-alias-success, #047857)' },
      bad: { color: 'var(--dsw-alias-danger, #b91c1c)' },
      list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px' },
      notice: {
        borderLeft: '3px solid var(--dsw-alias-accent, #2563eb)',
        padding: '6px 10px',
        color: 'var(--dsw-alias-text-secondary, #6b7280)',
      },
    }

    /**
     * One labelled control row.
     * @param {object} props - row props.
     * @returns {any} a React node.
     */
    function Field({ label, children }) {
      return h('div', { style: styles.row }, [
        h('span', { key: 'label', style: styles.label }, label),
        h('span', { key: 'control', style: styles.row }, children),
      ])
    }

    /**
     * The Settings page.
     * @returns {any} a React node.
     */
    function FreeLlmapiSettings() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [transport, setTransport] = useState('direct')
      const [host, setHost] = useState('127.0.0.1')
      const [port, setPort] = useState('0')

      const load = useCallback(async () => {
        try {
          const response = await fetch(SETTINGS_PATH, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body.ok !== true) throw new Error(body.error ?? 'settings unavailable')
          setState(body)
          setTransport(body.transport)
          setHost(body.proxyHost)
          setPort(String(body.proxyPort))
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const detect = useCallback(async (useTypedPort) => {
        setBusy('detect')
        setNotice('')
        try {
          const response = await fetch(DETECT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(useTypedPort
              ? { proxyHost: host, proxyPort: Number(port) }
              : { proxyHost: host }),
          })
          const body = await response.json()
          if (body.ok !== true) throw new Error(body.error ?? 'detection failed')
          const proxy = body.proxy
          if (proxy.found) {
            setNotice(`Found a FreeLLMAPI proxy on ${proxy.host}:${String(proxy.port)} with ${String(proxy.models)} models. Save to use it.`)
            setPort(String(proxy.port))
          } else {
            setNotice('No proxy answered. Start the FreeLLMAPI app, or type the port it uses under Settings → API in the app.')
          }
          await load()
        } catch (failure) {
          setNotice(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }, [host, port, load])

      const save = useCallback(async () => {
        setBusy('save')
        setNotice('')
        try {
          const response = await fetch(SETTINGS_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ transport, proxyHost: host, proxyPort: Number(port) }),
          })
          const body = await response.json()
          if (body.ok !== true) throw new Error(body.error ?? 'save failed')
          setNotice('Saved. The plugin restarts with the new connection; the model list refreshes on the next picker load.')
          await load()
        } catch (failure) {
          setNotice(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }, [transport, host, port, load])

      const proxy = state?.proxy
      const store = state?.store
      const tried = Array.isArray(proxy?.tried) ? proxy.tried.filter((entry) => entry.ok === false).slice(0, 6) : []

      return h('section', { style: styles.page }, [
        h('h2', { key: 'title', style: styles.title }, 'FreeLLMAPI'),
        h('p', { key: 'intro', style: styles.hint },
          'How this plugin reaches FreeLLMAPI. Direct routing calls each free provider with the keys the '
          + 'FreeLLMAPI store already holds; the proxy transport sends one request to the running FreeLLMAPI '
          + 'app and lets it choose the route.'),
        error === ''
          ? null
          : h('p', { key: 'error', style: styles.bad }, error),

        h('div', { key: 'connection', style: styles.card }, [
          h('h3', { key: 'h', style: styles.title }, 'Connection'),
          h(Field, { key: 'transport', label: 'Transport' }, [
            h('select', {
              key: 'select',
              style: styles.select,
              value: transport,
              onChange: (event) => { setTransport(event.target.value) },
            }, [
              h('option', { key: 'direct', value: 'direct' }, 'Direct providers (smart routing in this plugin)'),
              h('option', { key: 'proxy', value: 'proxy' }, 'FreeLLMAPI proxy (the app routes)'),
            ]),
          ]),
          h(Field, { key: 'host', label: 'Host' }, [
            h('input', {
              key: 'input',
              style: styles.input,
              value: host,
              spellCheck: false,
              onChange: (event) => { setHost(event.target.value) },
            }),
          ]),
          h(Field, { key: 'port', label: 'Proxy port' }, [
            h('input', {
              key: 'input',
              style: styles.input,
              value: port,
              inputMode: 'numeric',
              onChange: (event) => { setPort(event.target.value.replace(/[^0-9]/gu, '')) },
            }),
            h('span', { key: 'hint', style: styles.hint }, '0 = detect automatically'),
          ]),
          h('div', { key: 'actions', style: styles.row }, [
            h('button', {
              key: 'detect',
              type: 'button',
              style: styles.button,
              disabled: busy !== '',
              onClick: () => { void detect(false) },
            }, busy === 'detect' ? 'Detecting…' : 'Detect'),
            h('button', {
              key: 'test',
              type: 'button',
              style: styles.button,
              disabled: busy !== '' || port === '0' || port === '',
              onClick: () => { void detect(true) },
            }, 'Test typed port'),
            h('button', {
              key: 'save',
              type: 'button',
              style: { ...styles.button, ...styles.primary },
              disabled: busy !== '' || state?.canSave !== true,
              onClick: () => { void save() },
            }, busy === 'save' ? 'Saving…' : 'Save'),
          ]),
          state?.canSave === false
            ? h('p', { key: 'nosave', style: styles.hint },
              'This profile cannot save plugin configuration; edit the freellmapi-auto row in cordis.patch.yml instead.')
            : null,
          notice === '' ? null : h('p', { key: 'notice', style: styles.notice }, notice),
        ]),

        h('div', { key: 'status', style: styles.card }, [
          h('h3', { key: 'h', style: styles.title }, 'Status'),
          proxy === undefined || proxy === null
            ? h('p', { key: 'loading', style: styles.hint }, 'Checking…')
            : h('ul', { key: 'list', style: styles.list }, [
              h('li', { key: 'proxy', style: proxy.found ? styles.ok : styles.bad },
                proxy.found
                  ? `Proxy reachable on ${proxy.host}:${String(proxy.port)} — ${String(proxy.models)} models published.`
                  : 'No FreeLLMAPI proxy answered on the probed ports.'),
              store === undefined
                ? null
                : h('li', { key: 'store', style: store.available ? styles.ok : styles.bad },
                  store.available
                    ? `Store readable at ${store.dbPath} — ${String(store.models)} direct routes.`
                    : `Store not readable at ${store.dbPath}.`),
              state === undefined || state === null
                ? null
                : h('li', { key: 'routes', style: styles.hint },
                  `Registered routes: ${(state.routes ?? []).join(', ')}`),
            ]),
          tried.length === 0
            ? null
            : h('p', { key: 'tried', style: styles.hint },
              `Ports tried without an answer: ${tried.map((entry) => `${String(entry.port)} (${entry.detail})`).join(', ')}`),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'freellmapi-auto',
          order: 12,
          label: 'FreeLLMAPI',
        }, FreeLlmapiSettings))
      },
    }
  },
})
