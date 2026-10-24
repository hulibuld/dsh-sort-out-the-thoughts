/**
 * dsh-sort-out-the-thoughts — 浏览器半边。
 *
 * 只挂两个位置：
 *   conversation.input.left  输入框左边的「梳理」开关（session 作用域，宿主给 sessionId）
 *   settings.section         设置里的 Thoughts Center 页
 *
 * 不 import 宿主包，只用注入的 react，所以换宿主版本时炸的机会最小。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sort-out-the-thoughts',
  factory(require, module, exports) {
    const out = exports || (module && module.exports) || {}
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback } = React

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

      // 开着的时候隔几秒对一次账：AI 在会话里把段推进了，按钮不能还停在上一段。
      useEffect(() => {
        if (!sessionId || !on || !ready) return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh()
        }
        const timer = setInterval(tick, 2500)
        const onFocus = () => refresh()
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
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

      if (on && current) {
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

      return h(
        'div',
        { style: { color: C.text } },
        h('h2', { style: { fontSize: 15, fontWeight: 650, margin: '0 0 4px' } }, 'Thoughts Center'),
        h(
          'p',
          { style: { fontSize: 12, color: C.muted, margin: '0 0 14px', lineHeight: 1.65 } },
          '梳理过的想法都在这里，按体裁归档。每条都能看到它从一句模糊的话长到成稿的轨迹，也能接着往下追问。',
        ),

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
      )
    }

    // ============================================================
    // 挂载
    // ============================================================

    function apply(ctx) {
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
    }

    out.apply = apply
    out.inject = ['slots']
    return out
  },
})
