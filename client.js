/**
 * dsh-sort-out-the-thoughts — 浏览器半边。
 *
 * 只挂两个位置：
 *   conversation.input.left  输入框左边的「梳理」开关（session 作用域，宿主给 sessionId）
 *   settings.section         设置里的 Thoughts Center 页
 *   shell.overlay            随想悬浮球 + 草稿本挂件（整框之上，不会被会话内容压住）
 *
 * 不 import 宿主包，只用注入的 react，所以换宿主版本时炸的机会最小。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sort-out-the-thoughts',
  factory(require, module, exports) {
    const out = exports || (module && module.exports) || {}
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore } = React

    const API = '/plugins/dsh-sort-out-the-thoughts'
    const GENRES = ['文章', '演讲稿', '自媒体文稿', '其他']
    const PHASE_LABELS = { 1: '梳理', 2: '批判', 3: '调研' }
    const STAGE_LABELS = {
      raw: '刚起念',
      probing: '追问中',
      shaped: '有骨架',
      outlined: '大纲定型',
      drafted: '成稿',
      archived: '已归档',
    }

    // 主题色一律走宿主变量，取不到就退到一套能看的中性色。
    const C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      muted: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))',
      faint: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.62))',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.14))',
      surface: 'var(--dsw-alias-bg-elevated, rgba(128,128,128,0.06))',
      accent: 'var(--dsw-alias-brand-primary, #4D6BFE)',
    }

    async function apiGet(path) {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    function formatTime(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    // ============================================================
    // 随想记录本：碎想法先丢进来。做成一颗悬浮球，点开是一本带横线的草稿本。
    // ============================================================

    const DOCK_STORAGE_KEY = 'dsh-sort-out-the-thoughts:dock:v5'
    const DOCK_WIDTH = 372
    const BALL_SIZE = 58
    const NOTE_LINE = 28
    const PANEL_SHORT = 332
    const PANEL_TALL = 592
    const HAND_FONT = '"Kaiti SC","STKaiti","KaiTi","Songti SC","STSong",serif'

    const LINES_RULE =
      'repeating-linear-gradient(to bottom, transparent 0 ' + (NOTE_LINE - 1) + 'px, var(--st-line) ' +
      (NOTE_LINE - 1) + 'px ' + NOTE_LINE + 'px)'
    const MARGIN_RULE = {
      position: 'absolute',
      left: 34,
      top: 0,
      bottom: 0,
      width: 1,
      background: 'var(--st-margin)',
      pointerEvents: 'none',
    }

    // 四种纸色。球和本子共用一套，换色是换整本。
    const THEMES = [
      {
        id: 'paper',
        name: '纸米黄',
        swatch: '#F0E4C4',
        base: '#FBF6E4',
        sheet: '#F1E9D1',
        line: 'rgba(128, 96, 56, 0.22)',
        margin: 'rgba(196, 86, 74, 0.42)',
        ink: '#453C30',
        faint: '#8D7F64',
        cover: '#EADCB8',
        coverEdge: '#D6C49B',
        ring: '#B3A181',
        accent: '#B4553C',
      },
      {
        id: 'green',
        name: '护眼绿',
        swatch: '#CFE3C6',
        base: '#E9F2E1',
        sheet: '#DDEBD2',
        line: 'rgba(74, 108, 66, 0.20)',
        margin: 'rgba(180, 92, 74, 0.36)',
        ink: '#2F3A2C',
        faint: '#75866F',
        cover: '#D3E4C8',
        coverEdge: '#BFD3B2',
        ring: '#93A98A',
        accent: '#A7573F',
      },
      {
        id: 'white',
        name: '白纸',
        swatch: '#FFFFFF',
        base: '#FFFFFF',
        sheet: '#F2F4F7',
        line: 'rgba(88, 104, 128, 0.20)',
        margin: 'rgba(96, 132, 190, 0.34)',
        ink: '#2A3038',
        faint: '#8B939E',
        cover: '#F4F6F9',
        coverEdge: '#DCE1E8',
        ring: '#B7C0CB',
        accent: '#3B6FD4',
      },
      {
        id: 'dark',
        name: '黑（深灰）',
        swatch: '#3A3F46',
        base: '#2E3238',
        sheet: '#33383F',
        line: 'rgba(255, 255, 255, 0.11)',
        margin: 'rgba(255, 128, 112, 0.40)',
        ink: '#E7E9EC',
        faint: '#9BA2AB',
        cover: '#3B4047',
        coverEdge: '#4C525A',
        ring: '#7B838D',
        accent: '#E8937C',
      },
    ]

    const THEME_BY_ID = {}
    THEMES.forEach((theme) => {
      THEME_BY_ID[theme.id] = theme
    })

    function readDockState() {
      const fallback = { x: null, y: null, px: null, py: null, open: false, theme: 'paper', expanded: false }
      try {
          let raw = window.localStorage.getItem(DOCK_STORAGE_KEY)
        if (!raw) raw = window.localStorage.getItem('dsh-sort-out-the-thoughts:dock:v4')
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return fallback
        const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
        return {
          x: num(parsed.x),
          y: num(parsed.y),
          px: num(parsed.px),
          py: num(parsed.py),
          open: parsed.open === true,
          theme: typeof parsed.theme === 'string' && THEME_BY_ID[parsed.theme] ? parsed.theme : 'paper',
          expanded: parsed.expanded === true,
        }
      } catch (error) {
        return fallback
      }
    }

    function writeDockState(state) {
      try {
        window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state))
      } catch (error) {
        /* 存不上不影响用 */
      }
    }

    function viewportSize() {
      return {
        w: typeof window === 'undefined' ? 1440 : window.innerWidth,
        h: typeof window === 'undefined' ? 900 : window.innerHeight,
      }
    }

    const VIEW_MARGIN = 12

    function clampToViewport(x, y, width, height) {
      const view = viewportSize()
      return {
        x: Math.min(Math.max(VIEW_MARGIN, x), Math.max(VIEW_MARGIN, view.w - width - VIEW_MARGIN)),
        y: Math.min(Math.max(VIEW_MARGIN, y), Math.max(VIEW_MARGIN, view.h - height - VIEW_MARGIN)),
      }
    }

    // 根作用域的组件拿不到会话 id，改从客户端 uiSession 绑定里读当前会话。
    function useCurrentSession(binding) {
      const subscribe = useCallback(
        (listener) => (binding && typeof binding.subscribe === 'function' ? binding.subscribe(listener) : () => {}),
        [binding],
      )
      const getSnapshot = useCallback(() => {
        if (!binding || typeof binding.getSnapshot !== 'function') return ''
        const value = binding.getSnapshot()
        const key = value && typeof value === 'object' ? value.key : undefined
        return typeof key === 'string' ? key : ''
      }, [binding])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    // ============================================================
    // 「去研究」：新开一条会话，把随想直接写进那条会话的输入框
    // ============================================================
    // 客户端服务只有在 apply(ctx) 里拿得到，而组件是纯函数，所以留一个模块级引用，
    // 点到按钮的那一刻再去取服务，不把服务对象一路当 props 传下去。
    let runtimeCtx = null

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function sessionCatalog(ctx) {
      try {
        const list = ctx && ctx.sessions && ctx.sessions.list
        const snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
        return snap && snap.byId && typeof snap.byId === 'object' ? snap.byId : {}
      } catch (error) {
        return {}
      }
    }

    // 主区当前显示哪条会话：catalog 的行上带 retainedBy.mainView 计数。
    function mainViewSessionId(byId) {
      for (const row of Object.values(byId || {})) {
        if (row && typeof row.id === 'string' && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0) return row.id
      }
      return ''
    }

    // 固定模板：每条随想进新会话时，前面是那句原文，后面跟同一句固定的开场话。
    // 不按会话、不按内容拼变量，省掉所有算出来的部分，点下去就能开。
    const RESEARCH_OPENING = '先把这条想法梳理清楚：它到底在说什么，哪里还含糊，下一步该往哪儿想。'

    function researchDraft(spark) {
      const body = String((spark && spark.text) || '').trim()
      if (!body) return RESEARCH_OPENING
      return body + '\n\n' + RESEARCH_OPENING
    }

    // 开关状态变了（比如刚点过「去研究」），让所有还挂着的开关都去对一次账。
    function announceModeChanged() {
      try {
        window.dispatchEvent(new CustomEvent('dsh-sort-out-the-thoughts:mode'))
      } catch (error) {
        /* 老浏览器没有 CustomEvent 就靠轮询兜 */
      }
    }

    // startSession 是官方的“新会话”，可以顺带把初始内容（prompt）写进草稿；
    // 但它不返回 id，只能盯着会话清单里新冒出来的那一条。
    async function waitForNewSession(ctx, before) {
      for (let i = 0; i < 10; i += 1) {
        const byId = sessionCatalog(ctx)
        const fresh = Object.keys(byId).filter((id) => !before.has(id))
        if (fresh.length > 0) {
          const shown = mainViewSessionId(byId)
          return fresh.includes(shown) ? shown : fresh[fresh.length - 1]
        }
        await sleep(60)
      }
      return ''
    }

    function composerOf(ctx, sessionId) {
      const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
      const input = conversation && conversation.input
      if (!input || typeof input.for !== 'function') return null
      const scope = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
      if (scope === undefined || scope === null) return null
      try {
        return input.for(scope)
      } catch (error) {
        return null
      }
    }

    function draftOf(ctx, sessionId) {
      const composer = composerOf(ctx, sessionId)
      if (!composer || !composer.state || typeof composer.state.getSnapshot !== 'function') return null
      try {
        const snapshot = composer.state.getSnapshot()
        return snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : null
      } catch (error) {
        return null
      }
    }

    // 官方通道偶尔还没把字落进 composer。只补一次，不在这儿死等：
    // 草稿本身不是关键，真丢了用户也能从本子里复制，宁可快一点。
    async function ensureDraft(ctx, sessionId, text) {
      if (draftOf(ctx, sessionId) === text) return ''
      const composer = composerOf(ctx, sessionId)
      if (composer && typeof composer.setDraft === 'function') {
        try {
          composer.setDraft(text)
        } catch (error) {
          /* 落不下去就交给用户手填 */
        }
      }
      await sleep(60)
      return draftOf(ctx, sessionId) === text ? '' : '输入框没能自动填上，本子里那句话可以直接复制'
    }

    // 返回 { ok, sessionId, reason }；reason 只在要提示用户时给。
    async function openResearchSession(spark) {
      const ctx = runtimeCtx
      if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: '插件还没挂好' }

      const uiWorkspace = ctx.get('uiWorkspace')
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        return { ok: false, reason: '这个版本不支持新建会话' }
      }
      if (!ctx.sessions || typeof ctx.sessions.scope !== 'function') {
        return { ok: false, reason: '会话服务没就绪，再点一次' }
      }

      const registry = ctx.get('workspaces')
      const before = new Set(Object.keys(sessionCatalog(ctx)))
      const here = mainViewSessionId(sessionCatalog(ctx))

      let workspaceId = ''
      try {
        const snap = registry && registry.list ? registry.list.getSnapshot() : null
        const items = snap && Array.isArray(snap.items) ? snap.items : []
        const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(here))
        const target = owner || items[0]
        if (target) workspaceId = target.workspaceId || target.id || ''
      } catch (error) {
        workspaceId = ''
      }
      if (!workspaceId) return { ok: false, reason: '先打开一个工作区' }

      const text = researchDraft(spark)

      // 官方“新会话”通道自带草稿初始化：prompt 就是输入框里的内容。
      try {
        uiWorkspace.startSession(workspaceId, { prompt: text, clearPreviousDraft: true, whenDraftExists: 'replace' })
      } catch (error) {
        /* 降级到下面的兜底 */
      }

      let sessionId = await waitForNewSession(ctx, before)
      // 复用当前那条空白会话时不会冒出新 id，此时目标就是它本身。
      if (!sessionId) sessionId = mainViewSessionId(sessionCatalog(ctx)) || here
      if (!sessionId && typeof uiWorkspace.connectWorkspace === 'function') {
        try {
          const value = await uiWorkspace.connectWorkspace(workspaceId)
          if (typeof value === 'string') sessionId = value
        } catch (error) {
          sessionId = ''
        }
      }
      if (!sessionId) return { ok: false, reason: '新会话没建成，再点一次' }

      // 把这条会话的梳理开关打开、把随想记成一条思路，
      // 这样用户按回车那一轮已经带着梳理提示词。
      // 这一步必须成功——开关没跟着亮，用户就得自己再点一次。
      try {
        const data = await apiPost('/spark/start', { id: spark.id, sessionId })
        if (!data || data.active !== true) {
          // 服务端没回报 active，再补一次显式开关，别让按钮停在「关」。
          await apiPost('/toggle', { sessionId, on: true })
        }
      } catch (error) {
        try {
          await apiPost('/toggle', { sessionId, on: true })
        } catch (inner) {
          /* 真开不了也得把输入框填上，用户自己点开关 */
        }
      }
      // 先把界面切过去，用户马上就能看到新会话；开开关、填草稿都在后面并行做。
      try {
        if (typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(sessionId)
      } catch (error) {
        /* 已经在新会话里就算了 */
      }

      // 把这条会话的梳理开关打开、把随想记成一条思路，
      // 这样用户按回车那一轮已经带着梳理提示词。
      // 这一步必须成功——开关没跟着亮，用户就得自己再点一次。
      try {
        const data = await apiPost('/spark/start', { id: spark.id, sessionId })
        if (!data || data.active !== true) {
          // 服务端没回报 active，再补一次显式开关，别让按钮停在「关」。
          await apiPost('/toggle', { sessionId, on: true })
        }
      } catch (error) {
        try {
          await apiPost('/toggle', { sessionId, on: true })
        } catch (inner) {
          /* 真开不了也得把输入框填上，用户自己点开关 */
        }
      }
      announceModeChanged()

      const problem = await ensureDraft(ctx, sessionId, text)
      return { ok: true, sessionId, reason: problem }
    }

    // 随想的读写与状态，挂件页和整页共用一套。
    function useSparkBook() {
      const [text, setText] = useState('')
      const [items, setItems] = useState([])
      const [busy, setBusy] = useState('')
      const [flash, setFlash] = useState('')
      const [loaded, setLoaded] = useState(false)

      const load = useCallback(
        () =>
          apiGet('/sparks')
            .then((data) => setItems(data && Array.isArray(data.sparks) ? data.sparks : []))
            .catch(() => {})
            .then(() => setLoaded(true)),
        [],
      )

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(''), 2800)
        return () => clearTimeout(timer)
      }, [flash])

      const add = useCallback(() => {
        const value = text.trim()
        if (!value || busy) return
        setBusy('add')
        apiPost('/spark/add', { text: value })
          .then(() => {
            setText('')
            return load().then(() => setFlash('记下了'))
          })
          .catch(() => setFlash('没记上，再试一次'))
          .then(() => setBusy(''))
      }, [text, busy, load])

      const remove = useCallback(
        (id) => {
          if (busy) return
          setBusy(id)
          apiPost('/spark/delete', { id })
            .then(() => load())
            .catch(() => setFlash('没删掉'))
            .then(() => setBusy(''))
        },
        [busy, load],
      )

      // 从这条随想开一条新会话，把话写进新会话的输入框，并顺手开好梳理开关。
      const start = useCallback(
        (id, onDone) => {
          if (busy) return
          const spark = (items || []).find((item) => item.id === id)
          if (!spark) return
          setBusy(id)
          openResearchSession(spark)
            .then((result) => {
              if (result && result.ok) {
                setFlash(result.reason || '新会话开好了，输入框里已经写好')
                load()
                if (onDone) onDone()
              } else {
                setFlash((result && result.reason) || '没开成，再试一次')
              }
            })
            .catch(() => setFlash('没开成，再试一次'))
            .then(() => setBusy(''))
        },
        [busy, items, load],
      )

      return { text, setText, items, busy, flash, loaded, add, remove, start }
    }

    function SparkComposer(props) {
      const { text, setText, add, busy, flash } = props
      const ready = Boolean(text.trim()) && !busy
      return h(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
            minHeight: 0,
            padding: '2px 14px 6px 44px',
            backgroundImage: LINES_RULE,
            backgroundAttachment: 'local',
          },
        },
        h('div', { 'aria-hidden': 'true', style: MARGIN_RULE }),
        h('textarea', {
          value: text,
          rows: props.rows || 3,
          placeholder: '想到什么就写下来，一句话也行',
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              add()
            }
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--st-ink)',
            fontFamily: HAND_FONT,
            fontSize: 14,
            lineHeight: NOTE_LINE + 'px',
            padding: 0,
            flex: '1 1 auto',
            minHeight: 56,
          },
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 } },
          h(
            'button',
            {
              type: 'button',
              onClick: add,
              disabled: !ready,
              style: {
                padding: '0 10px',
                borderRadius: 3,
                fontFamily: HAND_FONT,
                fontSize: 12.5,
                lineHeight: '20px',
                cursor: ready ? 'pointer' : 'default',
                border: '1px solid var(--st-edge)',
                background: 'var(--st-cover)',
                color: 'var(--st-ink)',
                opacity: ready ? 1 : 0.5,
              },
            },
            busy === 'add' ? '记着呢' : '记下',
          ),
          flash ? h('span', { style: { fontFamily: HAND_FONT, fontSize: 11.5, color: 'var(--st-faint)' } }, flash) : null,
        ),
      )
    }

    function SparkRows(props) {
      const { items, busy, sessionId, loaded, onStart, onRemove } = props
      if (!items.length) {
        return h(
          'div',
          { style: { fontFamily: HAND_FONT, fontSize: 13, lineHeight: NOTE_LINE + 'px', color: 'var(--st-faint)', paddingTop: 4 } },
          loaded ? '还空着。想到什么先写一句。' : '翻页中…',
        )
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        items.map((spark) =>
          h(
            'div',
            { key: spark.id, style: { paddingTop: 2 } },
            h(
              'div',
              {
                style: {
                  fontFamily: HAND_FONT,
                  fontSize: 14,
                  lineHeight: NOTE_LINE + 'px',
                  color: 'var(--st-ink)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              spark.text,
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => onStart(spark.id),
                  disabled: Boolean(busy),
                  title: '新开一条会话，把这条随想写进输入框，并打开梳理模式',
                  style: {
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--st-accent)',
                    fontFamily: HAND_FONT,
                    fontSize: 12.5,
                    lineHeight: '20px',
                    cursor: busy ? 'progress' : 'pointer',
                    textDecoration: 'underline',
                    textDecorationStyle: 'dotted',
                  },
                },
                spark.thoughtId ? '再研究一次 →' : '去研究 →',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => onRemove(spark.id),
                  disabled: Boolean(busy),
                  style: {
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--st-faint)',
                    fontFamily: HAND_FONT,
                    fontSize: 11,
                    lineHeight: '20px',
                    cursor: 'pointer',
                  },
                },
                '撕掉',
              ),
              sessionId ? null : h('span', { style: { fontSize: 10, color: 'var(--st-faint)' } }, '（先开个对话）'),
              h(
                'span',
                { style: { marginLeft: 'auto', fontFamily: HAND_FONT, fontSize: 10.5, color: 'var(--st-faint)' } },
                formatTime(spark.createdAt),
              ),
            ),
          ),
        ),
      )
    }

    // 悬浮挂件：同一颗东西两种形态。球 ↔ 本子，位置共享，收起来就变回球。
    function SparkDock(props) {
      const sessionId = useCurrentSession(props.currentSession)
      const book = useSparkBook()
      const [state, setState] = useState(readDockState)
      const [drag, setDrag] = useState(null)
      const gesture = useRef(null)
      const shown = useRef({ x: 0, y: 0 })
      const panelDragged = useRef(false)

      const theme = THEME_BY_ID[state.theme] || THEMES[0]
      const panelHeight = state.expanded ? PANEL_TALL : PANEL_SHORT

      // 球和本子各记各的位置：收起时球回到它自己原来待的地方，不会跟着本子的左上角跑。
      const fallbackAt = { x: viewportSize().w - BALL_SIZE - 26, y: viewportSize().h - BALL_SIZE - 96 }
      const ballAt = clampToViewport(
        state.x === null ? fallbackAt.x : state.x,
        state.y === null ? fallbackAt.y : state.y,
        BALL_SIZE,
        BALL_SIZE,
      )
      const panelAt = clampToViewport(
        state.px === null ? ballAt.x : state.px,
        state.py === null ? ballAt.y : state.py,
        DOCK_WIDTH,
        panelHeight,
      )
      shown.current = state.open ? { x: panelAt.x, y: panelAt.y } : { x: ballAt.x, y: ballAt.y }

      useEffect(() => {
        writeDockState(state)
      }, [state])

      useEffect(() => {
        if (!drag) return undefined
        const move = (event) => {
          const dx = event.clientX - drag.atX
          const dy = event.clientY - drag.atY
          const size = drag.kind === 'ball' ? BALL_SIZE : panelHeight
          const width = drag.kind === 'ball' ? BALL_SIZE : DOCK_WIDTH
          const next = clampToViewport(drag.fromX + dx, drag.fromY + dy, width, size)
          if (drag.kind === 'panel') panelDragged.current = true
          setState((prev) =>
            drag.kind === 'ball' ? { ...prev, x: next.x, y: next.y } : { ...prev, px: next.x, py: next.y },
          )
        }
        const up = () => {
          const moved = gesture.current ? gesture.current.moved : 99
          gesture.current = null
          setDrag(null)
          if (drag.kind === 'ball' && moved < 6) {
            // 球当场摊开成本子：原地长，长不下就往左/往上借空间，仍然贴着球原来的位置。
            const from = shown.current
            const view = viewportSize()
            const fitsRight = from.x + DOCK_WIDTH <= view.w - VIEW_MARGIN
            const fitsDown = from.y + panelHeight <= view.h - VIEW_MARGIN
            const anchorX = fitsRight ? from.x : from.x + BALL_SIZE - DOCK_WIDTH
            const anchorY = fitsDown ? from.y : from.y + BALL_SIZE - panelHeight
            const next = clampToViewport(anchorX, anchorY, DOCK_WIDTH, panelHeight)
            panelDragged.current = false
            setState((prev) => ({ ...prev, open: true, px: next.x, py: next.y }))
          }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
      }, [drag, panelHeight])

      const startDrag = (kind, event) => {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('[data-no-drag]')) return
        gesture.current = { moved: 0 }
        setDrag({ kind, atX: event.clientX, atY: event.clientY, fromX: shown.current.x, fromY: shown.current.y })
        event.preventDefault()
      }

      const track = () => {
        if (gesture.current) gesture.current.moved += 1
      }

      const vars = {
        '--st-base': theme.base,
        '--st-sheet': theme.sheet,
        '--st-line': theme.line,
        '--st-margin': theme.margin,
        '--st-ink': theme.ink,
        '--st-faint': theme.faint,
        '--st-cover': theme.cover,
        '--st-edge': theme.coverEdge,
        '--st-ring': theme.ring,
        '--st-accent': theme.accent,
      }

      if (!state.open) {
        return h(
          'div',
          {
            onPointerDown: (event) => startDrag('ball', event),
            onPointerMove: track,
            title: '随想记录本：想到什么先记下来',
            role: 'button',
            'aria-label': '打开随想记录本',
            'aria-expanded': 'false',
            style: {
              ...vars,
              position: 'fixed',
              left: ballAt.x,
              top: ballAt.y,
              width: BALL_SIZE,
              height: BALL_SIZE,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'radial-gradient(circle at 32% 26%, color-mix(in srgb, ' + theme.base + ' 92%, white) 0%, ' + theme.base + ' 46%, ' + theme.coverEdge + ' 100%)',
              border: '1px solid ' + theme.coverEdge,
              boxShadow: '0 10px 24px rgba(40,32,20,0.26), inset 0 1px 0 rgba(255,255,255,0.7)',
              cursor: drag ? 'grabbing' : 'grab',
              zIndex: 950,
              touchAction: 'none',
              userSelect: 'none',
            },
          },
          h('span', { 'aria-hidden': 'true', style: { fontSize: 26, lineHeight: 1 } }, '📒'),
          book.items.length
            ? h(
                'span',
                {
                  style: {
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    minWidth: 18,
                    height: 18,
                    padding: '0 4px',
                    borderRadius: 9,
                    background: theme.accent,
                    color: '#FFF8EC',
                    fontSize: 10,
                    lineHeight: '18px',
                    textAlign: 'center',
                    fontWeight: 600,
                  },
                },
                String(book.items.length),
              )
            : null,
        )
      }

      const rings = h(
        'div',
        {
          'aria-hidden': 'true',
          onPointerDown: (event) => startDrag('panel', event),
          onPointerMove: track,
          title: '按住这里拖本子',
          style: {
            cursor: drag ? 'grabbing' : 'grab',
            touchAction: 'none',
            display: 'flex',
            justifyContent: 'space-evenly',
            alignItems: 'center',
            height: 16,
            padding: '0 14px',
            background: 'linear-gradient(' + theme.cover + ', ' + theme.coverEdge + ')',
            borderBottom: '1px solid ' + theme.line,
          },
        },
        [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
          h('span', {
            key: index,
            style: {
              width: 11,
              height: 11,
              borderRadius: '50%',
              border: '2px solid ' + theme.ring,
              background: 'linear-gradient(160deg, ' + theme.base + ', ' + theme.sheet + ')',
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.18)',
            },
          }),
        ),
      )

      const swatches = THEMES.map((candidate) =>
        h(
          'button',
          {
            key: candidate.id,
            type: 'button',
            'data-no-drag': 'true',
            onClick: () => setState((prev) => ({ ...prev, theme: candidate.id })),
            title: candidate.name,
            'aria-label': '纸色：' + candidate.name,
            'aria-pressed': candidate.id === theme.id ? 'true' : 'false',
            style: {
              width: 15,
              height: 15,
              padding: 0,
              borderRadius: '50%',
              cursor: 'pointer',
              background: candidate.swatch,
              border: candidate.id === theme.id ? '2px solid ' + theme.accent : '1px solid ' + theme.coverEdge,
              boxShadow: candidate.id === theme.id ? '0 0 0 2px color-mix(in srgb, ' + theme.accent + ' 22%, transparent)' : 'none',
            },
          },
        ),
      )

      const head = h(
        'div',
        {
          onPointerDown: (event) => startDrag('panel', event),
          onPointerMove: track,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px 6px 16px',
            cursor: drag ? 'grabbing' : 'grab',
            userSelect: 'none',
            touchAction: 'none',
          },
        },
        h('span', { style: { fontFamily: HAND_FONT, fontSize: 15.5, fontWeight: 700, letterSpacing: '0.04em', color: theme.ink } }, '随想记录本'),
        h('div', { 'data-no-drag': 'true', style: { display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' } }, swatches),
        h(
          'button',
          {
            type: 'button',
            'data-no-drag': 'true',
            onClick: () => {
              const at = shown.current
              if (!panelDragged.current) {
                // 没动过本子：球原地回来，位置一点不变。
                setState((prev) => ({ ...prev, open: false }))
                return
              }
              // 本子被拖走过：球跟到本子的右下角，别让它在老地方凭空冒出来。
              const back = clampToViewport(
                at.x + DOCK_WIDTH - BALL_SIZE,
                at.y + panelHeight - BALL_SIZE,
                BALL_SIZE,
                BALL_SIZE,
              )
              panelDragged.current = false
              setState((prev) => ({ ...prev, open: false, x: back.x, y: back.y }))
            },
            title: '收起（变回球）',
            style: {
              width: 22,
              height: 22,
              marginLeft: 4,
              border: '1px solid ' + theme.coverEdge,
              borderRadius: 11,
              background: 'transparent',
              color: theme.faint,
              fontSize: 13,
              lineHeight: 1,
              cursor: 'pointer',
            },
          },
          '×',
        ),
      )

      const toggleRow = h(
        'button',
        {
          type: 'button',
          'data-no-drag': 'true',
          onClick: () => setState((prev) => ({ ...prev, expanded: !prev.expanded })),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '2px 14px 8px 44px',
            border: 'none',
            background: 'transparent',
            color: theme.faint,
            fontFamily: HAND_FONT,
            fontSize: 12,
            lineHeight: '22px',
            cursor: 'pointer',
            textAlign: 'left',
          },
        },
        h('span', { 'aria-hidden': 'true', style: { fontSize: 10 } }, state.expanded ? '▾' : '▸'),
        '随想记录',
        h('span', { style: { color: theme.ink } }, String(book.items.length)),
        h('span', null, '条'),
        h('span', { style: { marginLeft: 'auto', fontSize: 11 } }, state.expanded ? '收起' : '展开'),
      )

      return h(
        'div',
        {
          style: {
            ...vars,
            position: 'fixed',
            left: panelAt.x,
            top: panelAt.y,
            width: DOCK_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            height: panelHeight,
            maxHeight: 'calc(100vh - 16px)',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 6,
            background: theme.base,
            border: '1px solid ' + theme.coverEdge,
            boxShadow:
              '0 2px 0 ' + theme.sheet + ', 0 3px 0 ' + theme.base + ', 0 4px 0 ' + theme.sheet +
              ', 0 20px 44px rgba(30,24,14,0.34)',
            overflow: 'hidden',
            color: theme.ink,
            font: 'inherit',
            zIndex: 951,
          },
        },
        rings,
        head,
        h(SparkComposer, { text: book.text, setText: book.setText, add: book.add, busy: book.busy, flash: book.flash }),
        toggleRow,
        state.expanded
          ? h(
              'div',
              {
                style: {
                  padding: '0 14px 6px 44px',
                  color: 'var(--st-faint)',
                  fontFamily: HAND_FONT,
                  fontSize: 11.5,
                  lineHeight: '17px',
                },
              },
              '点「去研究」会新开一条会话，这句话已经写进输入框；想定方向就在最后补一句。',
            )
          : null,
        state.expanded
          ? h(
              'div',
              {
                style: {
                  position: 'relative',
                  flex: 1,
                  minHeight: 0,
                  overflow: 'auto',
                  padding: '0 14px 12px 44px',
                  backgroundImage: LINES_RULE,
                  backgroundAttachment: 'local',
                },
              },
              h('div', { 'aria-hidden': 'true', style: MARGIN_RULE }),
              h(SparkRows, {
                items: book.items,
                busy: book.busy,
                loaded: book.loaded,
                sessionId,
                onStart: (id) => book.start(id),
                onRemove: book.remove,
              }),
            )
          : null,
      )
    }

    // ============================================================
    // 输入框左边的开关
    // ============================================================

    function ThoughtsToggle(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [on, setOn] = useState(false)
      const [busy, setBusy] = useState(false)
      const [ready, setReady] = useState(false)
      const [current, setCurrent] = useState(null)
      const [pending, setPending] = useState(null)
      const [flash, setFlash] = useState('')

      // 段位有两个来源：用户点按钮改一次，AI 自己调工具又改一次。
      // 所以本地不自己算段位，一律以 /state 为准，跟宿主对不上就重新拉。
      const applyState = useCallback((data) => {
        setOn(data && data.active === true)
        setCurrent(data && data.current ? data.current : null)
        setReady(true)
      }, [])

      const refresh = useCallback(() => {
        if (!sessionId) return Promise.resolve()
        return apiGet('/state?sessionId=' + encodeURIComponent(sessionId))
          .then(applyState)
          .catch(() => {})
      }, [sessionId, applyState])

      useEffect(() => {
        if (!sessionId) return undefined
        let dead = false
        apiGet('/state?sessionId=' + encodeURIComponent(sessionId))
          .then((data) => {
            if (!dead) applyState(data)
          })
          .catch(() => {
            if (!dead) setReady(true)
          })
        return () => {
          dead = true
        }
      }, [sessionId, applyState])

      // 隔几秒对一次账：AI 在会话里把段推进了，按钮不能还停在上一段；
      // 关着的时候也要查——点过「去研究」之后，开关是服务端替它打开的，
      // 本地不主动查就会一直显示「关」。
      useEffect(() => {
        if (!sessionId || !ready) return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh()
        }
        const timer = setInterval(tick, on ? 2500 : 4000)
        const onFocus = () => refresh()
        const onMode = () => refresh()
        window.addEventListener('focus', onFocus)
        window.addEventListener('dsh-sort-out-the-thoughts:mode', onMode)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('dsh-sort-out-the-thoughts:mode', onMode)
        }
      }, [sessionId, on, ready, refresh])

      useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(''), 2600)
        return () => clearTimeout(timer)
      }, [flash])

      const toggle = useCallback(() => {
        if (!sessionId || busy) return
        const next = !on
        setOn(next)
        if (!next) {
          setPending(null)
          setCurrent(null)
        }
        setBusy(true)
        apiPost('/toggle', { sessionId, on: next })
          .then((data) => setOn(data && data.active === true))
          .catch(() => setOn(!next))
          .then(() => setBusy(false))
          .then(() => refresh())
      }, [sessionId, on, busy, refresh])

      // 用户自己判断「这一段够了」，点一下就换段，不用等 AI 来问。
      // 第一次点先过机检；缺东西就把缺的摆出来，再点一次仍然可以硬推。
      const advance = useCallback(() => {
        if (!sessionId || busy) return
        const force = Boolean(pending)
        setBusy(true)
        fetch(API + '/advance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, force }),
        })
          .then((res) =>
            res
              .json()
              .then((data) => ({ data }))
              .catch(() => ({ data: {} })),
          )
          .then(({ data }) => {
            if (data && data.ok) {
              setPending(null)
              setFlash(data.archived ? '已归档' : '进第 ' + (Number(data.phase) || 1) + ' 段')
              refresh()
            } else if (data && data.reason === 'gate') {
              setPending(data.gate || { items: [] })
              setFlash('')
              refresh()
            } else if (data && data.reason === 'no-thought') {
              setFlash('先聊几句，让 AI 存一次')
            } else if (data && data.reason === 'archived') {
              setFlash('这条已经归档了')
            } else {
              setFlash('没成功，再试一次')
            }
          })
          .catch(() => setFlash('没成功，再试一次'))
          .then(() => setBusy(false))
      }, [sessionId, busy, pending, refresh])

      // 拿不到 sessionId 就不显示：宁缺勿错，别把开关的状态写到别的会话上。
      if (!sessionId) return null

      const phase = current ? Number(current.phase) || 1 : 0
      const missing = pending && Array.isArray(pending.items) ? pending.items.filter((item) => !item.ok) : []
      const advanceLabel = !current
        ? ''
        : pending
          ? `还差 ${missing.length} 项 · 仍要推进`
          : phase >= 3
            ? '定稿归档'
            : `推进到第${phase + 1}段`

      const advanceTitle = !current
        ? ''
        : pending
          ? '这一段还缺：' + missing.map((item) => item.label).join('；') + '。再点一次就不管这些直接推进。'
          : phase >= 3
            ? '三段的活都干完了：点一下把这条想法定稿归档，之后可以在 设置 → Thoughts Center 回看。'
            : `你觉得第${phase}段「${PHASE_LABELS[phase] || ''}」聊够了就点这里，不用等 AI 来问。`

      const parts = []

      parts.push(
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            onClick: toggle,
            disabled: busy || !ready,
            title: on
              ? '梳理模式已开：AI 会用提问和质疑帮你把想法推成成稿，并记进 Thoughts Center。再点一下关掉。'
              : '开启梳理模式：把模糊的想法聊成一个能写出来、能讲出来的完整东西。',
            'aria-pressed': on ? 'true' : 'false',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 10px',
              borderRadius: 13,
              cursor: busy ? 'progress' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              border: '1px solid ' + (on ? C.accent : C.border),
              background: on ? 'color-mix(in srgb, ' + C.accent + ' 16%, transparent)' : 'transparent',
              color: on ? C.accent : C.muted,
              transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
              opacity: ready ? 1 : 0.6,
            },
          },
          h('span', { 'aria-hidden': 'true', style: { fontSize: 12 } }, '💭'),
          on ? '梳理 开' : '梳理 关',
        ),
      )

      // 刚开的新会话里，想法还是空的，这时候不该摆「推进到第 N 段」——
      // 一句都还没聊，哪来的「这一段够了」。
      if (on && current && current.filled) {
        parts.push(
          h(
            'button',
            {
              key: 'advance',
              type: 'button',
              onClick: advance,
              disabled: busy,
              title: advanceTitle,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: 26,
                padding: '0 10px',
                borderRadius: 13,
                cursor: busy ? 'progress' : 'pointer',
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1,
                whiteSpace: 'nowrap',
                border: '1px dashed ' + (pending ? '#d9534f' : C.border),
                background: 'transparent',
                color: pending ? '#d9534f' : C.muted,
                opacity: busy ? 0.6 : 1,
              },
            },
            advanceLabel,
            ' →',
          ),
        )
      }

      if (flash) {
        parts.push(
          h('span', { key: 'flash', style: { fontSize: 10, color: C.faint, whiteSpace: 'nowrap' } }, flash),
        )
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, parts)
    }

    // ============================================================
    // 设置里的 Thoughts Center
    // ============================================================

    function Chip(props) {
      const active = props.active === true
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            padding: '3px 10px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: 1.6,
            cursor: 'pointer',
            border: '1px solid ' + (active ? C.accent : C.border),
            background: active ? 'color-mix(in srgb, ' + C.accent + ' 14%, transparent)' : 'transparent',
            color: active ? C.accent : C.muted,
            fontWeight: active ? 600 : 400,
          },
        },
        props.label,
      )
    }

    function ThoughtCard(props) {
      const row = props.row
      return h(
        'button',
        {
          type: 'button',
          onClick: () => props.onOpen(row.id),
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid ' + C.borderSoft,
            background: C.surface,
            color: C.text,
            cursor: 'pointer',
            font: 'inherit',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || '未命名想法'),
          h(
            'span',
            {
              style: {
                flex: 'none',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 999,
                border: '1px solid ' + C.borderSoft,
                color: row.archived ? C.faint : C.accent,
              },
            },
            (STAGE_LABELS[row.stage] || row.stage) + ' · ' + (PHASE_LABELS[row.phase] || '第1段'),
          ),
        ),
        row.summary
          ? h(
              'div',
              {
                style: {
                  fontSize: 12,
                  color: C.muted,
                  lineHeight: 1.55,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                },
              },
              row.summary,
            )
          : null,
        h(
          'div',
          { style: { marginTop: 6, fontSize: 10, color: C.faint, display: 'flex', gap: 10 } },
          h('span', null, formatTime(row.updatedAt)),
          row.openQuestions ? h('span', null, `${row.openQuestions} 个待解问题`) : null,
        ),
      )
    }

    function ThoughtDetail(props) {
      const [thought, setThought] = useState(null)
      const [gate, setGate] = useState(null)
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        let dead = false
        apiGet('/thought?id=' + encodeURIComponent(props.id))
          .then((data) => {
            if (!dead) {
              setThought(data && data.thought ? data.thought : null)
              setGate(data && data.gate ? data.gate : null)
            }
          })
          .catch(() => {
            if (!dead) setFailed(true)
          })
        return () => {
          dead = true
        }
      }, [props.id])

      const remove = useCallback(() => {
        if (!thought) return
        const sure = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(`删除「${thought.title}」？删了就找不回来了。`)
          : true
        if (!sure) return
        apiPost('/delete', { id: thought.id })
          .then(() => props.onDeleted(thought.id))
          .catch(() => setFailed(true))
      }, [thought, props.onDeleted])

      const sectionStyle = { marginTop: 16 }
      const h3Style = { fontSize: 11, fontWeight: 600, color: C.faint, margin: '0 0 6px', letterSpacing: '0.04em' }

      if (failed) {
        return h('div', { style: { fontSize: 12, color: C.muted } }, '这条想法读不出来，可能已经被删了。')
      }
      if (!thought) {
        return h('div', { style: { fontSize: 12, color: C.faint } }, '读取中…')
      }

      const revisions = Array.isArray(thought.revisions) ? thought.revisions.slice(-12) : []

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          h('button', {
            type: 'button',
            onClick: props.onBack,
            style: {
              padding: '3px 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
              fontSize: 11,
            },
          }, '← 全部'),
          h('span', { style: { fontSize: 10, color: C.faint } }, `${thought.genre} · ${STAGE_LABELS[thought.stage] || thought.stage} · ${PHASE_LABELS[thought.phase] || '梳理'} · ${formatTime(thought.updatedAt)}`),
          h('span', { style: { flex: '1 1 auto' } }),
          h('a', {
            href: API + '/export?id=' + encodeURIComponent(thought.id),
            download: `thought-${thought.id}.md`,
            style: { fontSize: 11, color: C.accent, textDecoration: 'none' },
          }, '导出 .md'),
          h('button', {
            type: 'button',
            onClick: remove,
            style: {
              padding: '3px 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
              fontSize: 11,
            },
          }, '删除'),
        ),
        h('h2', { style: { fontSize: 17, fontWeight: 650, margin: '0 0 10px', color: C.text, lineHeight: 1.35 } }, thought.title || '未命名想法'),

        thought.summary
          ? h(
              'div',
              { style: sectionStyle },
              h('div', { style: h3Style }, '主旨'),
              h('div', { style: { fontSize: 13, lineHeight: 1.7, color: C.text } }, thought.summary),
            )
          : null,

        h(
          'div',
          { style: { fontSize: 11, color: C.faint, marginBottom: 12 } },
          '推进提醒：' + [1, 2, 3].map((id) => `${id}段${(thought.advanceAsked || {})[String(id)] ? '已问' : '未问'}`).join(' · '),
        ),

        gate && Array.isArray(gate.items) && gate.items.length
          ? h(
              'div',
              { style: { marginBottom: 12 } },
              h('div', { style: h3Style }, `第${gate.phase}段的产物清单（换段前先看这里）`),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                gate.items.map((item) =>
                  h(
                    'div',
                    { key: item.id, style: { fontSize: 11.5, lineHeight: 1.6, color: item.ok ? C.muted : C.text } },
                    (item.ok ? '✓ ' : '○ ') + item.label,
                  ),
                ),
              ),
            )
          : null,

        (() => {
          const notes = (thought && thought.phaseNotes) || {}
          const ids = [1, 2, 3].filter((id) => notes[String(id)] && String(notes[String(id)]).trim())
          if (!ids.length) return null
          const current = Number(thought.phase) || 1
          return h(
            'div',
            { style: sectionStyle },
            h('div', { style: h3Style }, '三段推进'),
            ids.map((id) =>
              h(
                'div',
                { key: id, style: { marginBottom: 10 } },
                h(
                  'div',
                  { style: { fontSize: 11.5, fontWeight: 600, color: id === current ? C.accent : C.muted, marginBottom: 4 } },
                  `${id}. ${PHASE_LABELS[id] || id}${id === current ? '（当前）' : ''}`,
                ),
                h(
                  'div',
                  { style: { fontSize: 12.5, lineHeight: 1.75, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                  String(notes[String(id)]).trim(),
                ),
              ),
            ),
          )
        })(),

        Array.isArray(thought.openQuestions) && thought.openQuestions.length
          ? h(
              'div',
              { style: sectionStyle },
              h('div', { style: h3Style }, '还没想清的问题'),
              h(
                'ul',
                { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8, color: C.text } },
                thought.openQuestions.map((question, index) => h('li', { key: index }, question)),
              ),
            )
          : null,

        thought.content
          ? h(
              'div',
              { style: sectionStyle },
              h('div', { style: h3Style }, '当前成形的内容'),
              h(
                'pre',
                {
                  style: {
                    margin: 0,
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: '1px solid ' + C.borderSoft,
                    background: C.surface,
                    fontSize: 12.5,
                    lineHeight: 1.75,
                    color: C.text,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    maxHeight: 460,
                    overflow: 'auto',
                  },
                },
                thought.content,
              ),
            )
          : null,

        revisions.length > 1
          ? h(
              'div',
              { style: sectionStyle },
              h('div', { style: h3Style }, '演化轨迹'),
              h(
                'ol',
                { style: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.9, color: C.muted } },
                revisions.map((rev, index) =>
                  h('li', { key: index }, `${formatTime(rev.at)} · ${STAGE_LABELS[rev.stage] || rev.stage} · 第${rev.phase || 1}段 · ${rev.summary || rev.title || ''}`),
                ),
              ),
            )
          : null,
      )
    }

    function ThoughtsCenter(props) {
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [genre, setGenre] = useState('')
      const [openId, setOpenId] = useState('')
      const [tab, setTab] = useState('thoughts')
      const [sparks, setSparks] = useState(null)

      const loadSparks = useCallback(() => {
        apiGet('/sparks')
          .then((data) => setSparks(Array.isArray(data.sparks) ? data.sparks : []))
          .catch(() => setSparks([]))
      }, [])

      useEffect(() => {
        loadSparks()
      }, [loadSparks])

      const load = useCallback(() => {
        apiGet('/thoughts')
          .then((data) => {
            setRows(Array.isArray(data.thoughts) ? data.thoughts : [])
            setError('')
          })
          .catch(() => {
            setRows([])
            setError('读不到思路库，插件服务可能没起来。')
          })
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const filtered = useMemo(() => {
        const list = Array.isArray(rows) ? rows : []
        const needle = query.trim().toLowerCase()
        return list
          .filter((row) => (genre ? row.genre === genre : true))
          .filter((row) => {
            if (!needle) return true
            return `${row.title || ''}\n${row.summary || ''}`.toLowerCase().includes(needle)
          })
      }, [rows, query, genre])

      const grouped = useMemo(() => {
        const buckets = new Map()
        for (const row of filtered) {
          const key = row.genre || '其他'
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key).push(row)
        }
        const order = GENRES.filter((item) => buckets.has(item))
        for (const key of buckets.keys()) if (!order.includes(key)) order.push(key)
        return order.map((key) => ({ genre: key, items: buckets.get(key) }))
      }, [filtered])

      if (openId) {
        return h(ThoughtDetail, {
          id: openId,
          onBack: () => {
            setOpenId('')
            load()
          },
          onDeleted: () => {
            setOpenId('')
            load()
          },
        })
      }

      const tabRow = h(
        'div',
        { style: { display: 'flex', gap: 6, margin: '0 0 14px' } },
        h(Chip, { label: '思路', active: tab === 'thoughts', onClick: () => setTab('thoughts') }),
        h(Chip, {
          label: sparks === null ? '随想' : '随想 · ' + sparks.length,
          active: tab === 'sparks',
          onClick: () => {
            setTab('sparks')
            loadSparks()
          },
        }),
      )

      const sparksBody = h(
        'div',
        null,
        h(
          'p',
          { style: { fontSize: 12, color: C.muted, margin: '0 0 12px', lineHeight: 1.65 } },
          '悬浮挂件里记下的随想都在这儿。点「去研究」会新开一个对话，把那条随想当成起点。',
        ),
        sparks === null
          ? h('div', { style: { fontSize: 12, color: C.faint, padding: '18px 0' } }, '读取中…')
          : sparks.length === 0
            ? h(
                'div',
                {
                  style: {
                    padding: '26px 18px',
                    borderRadius: 12,
                    border: '1px dashed ' + C.border,
                    textAlign: 'center',
                    color: C.muted,
                    fontSize: 12.5,
                    lineHeight: 1.8,
                  },
                },
                '还是一条随想都没有。右下角那颗小球点开，先记一句。',
              )
            : h(
                'div',
                { style: { display: 'grid', gap: 8 } },
                sparks.map((spark) =>
                  h(
                    'div',
                    {
                      key: spark.id,
                      style: {
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid ' + C.borderSoft,
                        background: C.surface,
                      },
                    },
                    h(
                      'div',
                      { style: { fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                      spark.text,
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11, color: C.faint } },
                      h('span', null, formatTime(spark.createdAt)),
                      spark.thoughtId ? h('span', { style: { color: C.accent } }, '已开过思路') : h('span', null, '还没研究过'),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => {
                            apiPost('/spark/delete', { id: spark.id })
                              .then(loadSparks)
                              .catch(() => {})
                          },
                          style: {
                            marginLeft: 'auto',
                            padding: 0,
                            border: 'none',
                            background: 'transparent',
                            color: C.faint,
                            fontSize: 11,
                            cursor: 'pointer',
                          },
                        },
                        '删掉',
                      ),
                    ),
                  ),
                ),
              ),
      )

      const headParts = [
        h('h2', { style: { fontSize: 15, fontWeight: 650, margin: '0 0 4px' } }, 'Thoughts Center'),
        h(
          'p',
          { style: { fontSize: 12, color: C.muted, margin: '0 0 12px', lineHeight: 1.65 } },
          '梳理过的想法都在这里，按体裁归档。每条都能看到它从一句模糊的话长到成稿的轨迹，也能接着往下追问。',
        ),
        tabRow,
      ]

      const thoughtsBody = [
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 } },
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜标题或主旨…',
            style: {
              flex: '1 1 180px',
              minWidth: 140,
              height: 30,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.surface,
              color: C.text,
              fontSize: 12,
              outline: 'none',
            },
          }),
          h(Chip, { label: '全部', active: genre === '', onClick: () => setGenre('') }),
          GENRES.map((item) =>
            h(Chip, { key: item, label: item, active: genre === item, onClick: () => setGenre(item) }),
          ),
        ),

        error ? h('div', { style: { fontSize: 12, color: '#d9534f', marginBottom: 10 } }, error) : null,

        rows === null
          ? h('div', { style: { fontSize: 12, color: C.faint, padding: '18px 0' } }, '读取中…')
          : filtered.length === 0
            ? h(
                'div',
                {
                  style: {
                    padding: '26px 18px',
                    borderRadius: 12,
                    border: '1px dashed ' + C.border,
                    textAlign: 'center',
                    color: C.muted,
                    fontSize: 12.5,
                    lineHeight: 1.8,
                  },
                },
                rows.length === 0
                  ? '还没有存下来的想法。去对话框左边打开「梳理」开关，一边聊，它会把推进中的思路记下来。'
                  : '没有符合条件的想法，换个关键词或体裁试试。',
              )
            : grouped.map((group) =>
                h(
                  'div',
                  { key: group.genre, style: { marginBottom: 18 } },
                  h(
                    'div',
                    { style: { fontSize: 11, fontWeight: 600, color: C.faint, marginBottom: 8, letterSpacing: '0.04em' } },
                    `${group.genre} · ${group.items.length}`,
                  ),
                  h(
                    'div',
                    { style: { display: 'grid', gap: 8 } },
                    group.items.map((row) => h(ThoughtCard, { key: row.id, row, onOpen: setOpenId })),
                  ),
                ),
              ),
      ]

      return h('div', { style: { color: C.text } }, ...headParts, tab === 'sparks' ? sparksBody : thoughtsBody)
    }

    // ============================================================
    // 挂载
    // ============================================================

    function apply(ctx) {
      runtimeCtx = ctx

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'sort-out-thoughts-toggle',
                order: 45,
                label: '梳理思路',
              },
              ThoughtsToggle,
            ),
          ),
        'sort-out-the-thoughts: 输入框梳理开关',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'sort-out-thoughts-center',
                order: 150,
                label: 'Thoughts Center',
              },
              ThoughtsCenter,
            ),
          ),
        'sort-out-the-thoughts: Thoughts Center 设置页',
      )

      // 悬浮挂件挂在整框浮层，高于所有栏目，不会被会话内容盖住。
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'sort-out-thoughts-dock',
                order: 70,
                label: '随想记录本',
                inject: () => ({ currentSession: ctx.uiSession.adapter.current }),
              },
              SparkDock,
            ),
          ),
        'sort-out-the-thoughts: 随想悬浮挂件',
      )

    }

    out.apply = apply
    out.inject = ['slots', 'uiSession', 'sessions']
    return out
  },
})
