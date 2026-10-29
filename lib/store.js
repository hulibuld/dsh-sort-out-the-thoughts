/**
 * 思路库的落盘层。
 *
 * 只做三件事：读、写、查。不做任何 UI 或提示词决定，方便单独测。
 * 两个文件，都在 <DSH_HOME>/plugin-data/dsh-sort-out-the-thoughts/ 下面：
 *
 *   thoughts.json  { version, thoughts: Thought[] }
 *   mode.json      { activeSessions: string[] }
 *
 * 写入一律走「临时文件 + rename」，避免半截 JSON 把整个库读崩；
 * 并发写用一条 Promise 链串起来，不允许多个 save 互相覆盖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const GENRES = ['文章', '演讲稿', '自媒体文稿', '其他']

export const STAGES = ['raw', 'probing', 'shaped', 'outlined', 'drafted', 'archived']

/** 三段推进：1 梳理 → 2 批判 → 3 调研。由用户在对话里驱动，模型用工具记录当前段与本段结论。 */
export const PHASES = [
  { id: 1, label: '梳理', hint: '分清哪些是你自己的想法，哪些是对话里长出来的' },
  { id: 2, label: '批判', hint: '找出方案与认知里的致命缺陷' },
  { id: 3, label: '调研', hint: '把问题抽象成可检索的命题，跨领域查证后落回需求' },
]

export function normalizePhase(value, fallback = 1) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : fallback
}

/**
 * 每一段的「产物清单」——借鉴论衡（lunheng-article-pipeline）的交付边界：
 * 换段之前先看这一段到底留下了什么。
 *
 * 全部是机械可判的「有 / 没有」，不做语义评判：写得好不好是人的事，
 * 机器只回答「这一段有没有产出」，免得用户一点推进就把空白段带进下一段。
 */
export const PHASE_DELIVERABLES = {
  1: [
    { id: 'summary', label: '一句话主旨', has: (t) => Boolean(t.summary && String(t.summary).trim()) },
    {
      id: 'content',
      label: '当前成形的东西（提纲、骨架或一段话）',
      has: (t) => Boolean(t.content && String(t.content).trim()),
    },
    { id: 'notes', label: '第一段结论（哪些是你的观点、哪些是聊出来的）', has: (t) => Boolean(phaseNote(t, 1)) },
  ],
  2: [
    { id: 'notes', label: '第二段结论（致命缺陷清单）', has: (t) => Boolean(phaseNote(t, 2)) },
    {
      id: 'questions',
      label: '还没想清的问题（至少一条）',
      has: (t) => Array.isArray(t.openQuestions) && t.openQuestions.length > 0,
    },
  ],
  3: [
    { id: 'notes', label: '第三段结论（调研结果）', has: (t) => Boolean(phaseNote(t, 3)) },
    { id: 'content', label: '落回需求的成稿内容', has: (t) => Boolean(t.content && String(t.content).trim()) },
  ],
}

function phaseNote(thought, phase) {
  const notes = thought && thought.phaseNotes
  if (!notes || typeof notes !== 'object') return ''
  const value = notes[String(phase)]
  return typeof value === 'string' ? value.trim() : ''
}

/** 机检：这一段够不够格换到下一段。ok=false 时把缺哪几项原样交出去，让用户自己决定硬推。 */
export function checkGate(thought, phase) {
  const id = normalizePhase(phase !== undefined ? phase : thought && thought.phase)
  const items = (PHASE_DELIVERABLES[id] || []).map((deliverable) => {
    let ok = false
    try {
      ok = Boolean(deliverable.has(thought))
    } catch {
      ok = false
    }
    return { id: deliverable.id, label: deliverable.label, ok }
  })
  return { phase: id, ok: items.every((item) => item.ok), items }
}

export const STAGE_LABELS = {
  raw: '刚起念',
  probing: '追问中',
  shaped: '有骨架',
  outlined: '大纲定型',
  drafted: '成稿',
  archived: '已归档',
}

const MAX_REVISIONS = 40

function nowIso() {
  return new Date().toISOString()
}

/** 标题兜底：没给标题就拿主旨第一句，再不行给「未命名想法」。 */
function deriveTitle(patch, previous) {
  const given = typeof patch.title === 'string' ? patch.title.trim() : ''
  if (given) return given.slice(0, 120)
  if (previous && previous.title) return previous.title
  const summary = typeof patch.summary === 'string' ? patch.summary.trim() : ''
  const firstLine = summary.split(/\r?\n/).find((line) => line.trim()) || ''
  const cut = firstLine.replace(/^#+\s*/, '').slice(0, 40)
  if (cut) return cut
  return '未命名想法'
}

function normalizeGenre(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (GENRES.includes(text)) return text
  return fallback || GENRES[0]
}

function normalizeStage(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (STAGES.includes(text)) return text
  return fallback || 'raw'
}

/** 把工具传进来的一行一条问题串成数组，去空去重。 */
function normalizeQuestions(value, fallback) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
  }
  if (typeof value === 'string') {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\d.、\s]+/, '').trim())
      .filter(Boolean)
    if (lines.length) return lines.slice(0, 20)
  }
  return Array.isArray(fallback) ? fallback : []
}

export function createStore({ dir, maxThoughts = 500 } = {}) {
  const base = dir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-data', 'dsh-sort-out-the-thoughts')
  const thoughtsFile = join(base, 'thoughts.json')
  const modeFile = join(base, 'mode.json')
  const sparksFile = join(base, 'sparks.json')
  const prefsFile = join(base, 'prefs.json')
  const MAX_SPARKS = 500

  const PREF_DEFAULTS = { dockHidden: false }

  let data = null
  let mode = null
  let sparkBox = null
  let prefs = null
  let chain = Promise.resolve()

  function serialize(task) {
    const run = chain.then(task, task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function ensureDir() {
    await mkdir(base, { recursive: true })
  }

  async function atomicWrite(file, payload) {
    await ensureDir()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, file)
  }

  async function loadThoughts() {
    if (data) return data
    try {
      const raw = await readFile(thoughtsFile, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.thoughts) ? parsed.thoughts : []
      data = { version: 1, thoughts: list.filter((item) => item && typeof item.id === 'string') }
    } catch {
      data = { version: 1, thoughts: [] }
    }
    return data
  }

  async function loadSparks() {
    if (sparkBox) return sparkBox
    try {
      const raw = await readFile(sparksFile, 'utf8')
      const parsed = JSON.parse(raw)
      sparkBox = { version: 1, sparks: Array.isArray(parsed && parsed.sparks) ? parsed.sparks : [] }
    } catch {
      sparkBox = { version: 1, sparks: [] }
    }
    sparkBox.sparks = sparkBox.sparks.filter((item) => item && typeof item.id === 'string')
    return sparkBox
  }

  /**
   * 同步读一次开关状态。
   *
   * 提示词装配是同步的，等不了 await；如果这里走异步，进程刚起来的那几毫秒里
   * 「上个会话开着开关」就会读成关，第一句话白丢。文件只有几十字节，同步读值得。
   */
  function loadMode() {
    if (mode) return mode
    try {
      const parsed = JSON.parse(readFileSync(modeFile, 'utf8'))
      mode = { activeSessions: Array.isArray(parsed && parsed.activeSessions) ? parsed.activeSessions : [] }
    } catch {
      mode = { activeSessions: [] }
    }
    return mode
  }

  // ---------- 读 ----------

  function list({ query, genre, includeArchived = true } = {}) {
    return serialize(async () => {
      const store = await loadThoughts()
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
      const rows = store.thoughts
        .filter((item) => (includeArchived ? true : item.stage !== 'archived'))
        .filter((item) => (genre && GENRES.includes(genre) ? item.genre === genre : true))
        .filter((item) => {
          if (!needle) return true
          const haystack = `${item.title || ''}\n${item.summary || ''}\n${item.content || ''}`.toLowerCase()
          return haystack.includes(needle)
        })
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map((item) => ({
          id: item.id,
          title: item.title,
          genre: item.genre,
          stage: item.stage,
          phase: normalizePhase(item.phase),
          summary: item.summary || '',
          updatedAt: item.updatedAt || item.createdAt || '',
          openQuestions: Array.isArray(item.openQuestions) ? item.openQuestions.length : 0,
          archived: item.stage === 'archived',
        }))
      return rows
    })
  }

  function get(id) {
    return serialize(async () => {
      const store = await loadThoughts()
      const found = store.thoughts.find((item) => item.id === id)
      if (found && (!found.advanceAsked || typeof found.advanceAsked !== 'object')) found.advanceAsked = {}
      return found || null
    })
  }

  // ---------- 写 ----------

  function save(patch = {}) {
    return serialize(async () => {
      const store = await loadThoughts()
      const existing = patch.id ? store.thoughts.find((item) => item.id === patch.id) : null
      const timestamp = nowIso()

      if (existing) {
        if (typeof patch.title === 'string') existing.title = deriveTitle(patch, existing)
        if (typeof patch.genre === 'string') existing.genre = normalizeGenre(patch.genre, existing.genre)
        if (typeof patch.stage === 'string') existing.stage = normalizeStage(patch.stage, existing.stage)
        if (patch.phase !== undefined) {
          // 模型有时会拿着旧上下文把段位写回更靠前的一段，这里只准往前，
          // 倒退只能靠人手点按钮（或 advance 工具），不然按钮和会话就打架。
          const asked = normalizePhase(patch.phase, existing.phase)
          existing.phase = Math.max(Number(existing.phase) || 1, asked)
        }
        if (typeof patch.summary === 'string') existing.summary = patch.summary.trim()
        if (typeof patch.content === 'string') existing.content = patch.content
        if (patch.openQuestions !== undefined) {
          existing.openQuestions = normalizeQuestions(patch.openQuestions, existing.openQuestions)
        }
        if (typeof patch.notes === 'string' && patch.notes.trim()) {
          if (!existing.phaseNotes || typeof existing.phaseNotes !== 'object') existing.phaseNotes = {}
          existing.phaseNotes[String(existing.phase || 1)] = patch.notes.trim()
        }
        if (typeof patch.sessionId === 'string' && patch.sessionId) existing.sessionId = patch.sessionId
        existing.updatedAt = timestamp
        pushRevision(existing, timestamp)
        await atomicWrite(thoughtsFile, store)
        return existing
      }

      if (store.thoughts.length >= maxThoughts) {
        // 满了就先删最老的已归档条目，别让用户在保存时才撞墙。
        const victim = store.thoughts
          .filter((item) => item.stage === 'archived')
          .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))[0]
        if (victim) store.thoughts = store.thoughts.filter((item) => item.id !== victim.id)
      }

      const created = {
        id: patch.id || `thought_${randomUUID().slice(0, 8)}`,
        title: deriveTitle(patch, null),
        genre: normalizeGenre(patch.genre, GENRES[0]),
        stage: normalizeStage(patch.stage, 'raw'),
        phase: normalizePhase(patch.phase, 1),
        phaseNotes: {},
        advanceAsked: {},
        summary: typeof patch.summary === 'string' ? patch.summary.trim() : '',
        content: typeof patch.content === 'string' ? patch.content : '',
        openQuestions: normalizeQuestions(patch.openQuestions, []),
        sessionId: typeof patch.sessionId === 'string' ? patch.sessionId : '',
        createdAt: timestamp,
        updatedAt: timestamp,
        revisions: [],
      }
      if (typeof patch.notes === 'string' && patch.notes.trim()) {
        created.phaseNotes[String(created.phase)] = patch.notes.trim()
      }
      pushRevision(created, timestamp)
      store.thoughts.push(created)
      await atomicWrite(thoughtsFile, store)
      return created
    })
  }

  function pushRevision(thought, timestamp) {
    if (!Array.isArray(thought.revisions)) thought.revisions = []
    const last = thought.revisions[thought.revisions.length - 1]
    const snapshot = {
      at: timestamp,
      stage: thought.stage,
      phase: normalizePhase(thought.phase),
      summary: thought.summary,
      title: thought.title,
    }
    if (last && last.stage === snapshot.stage && last.phase === snapshot.phase && last.summary === snapshot.summary && last.title === snapshot.title) {
      return
    }
    thought.revisions.push(snapshot)
    if (thought.revisions.length > MAX_REVISIONS) {
      thought.revisions = thought.revisions.slice(-MAX_REVISIONS)
    }
  }

  function remove(id) {
    return serialize(async () => {
      const store = await loadThoughts()
      const before = store.thoughts.length
      store.thoughts = store.thoughts.filter((item) => item.id !== id)
      if (store.thoughts.length === before) return false
      await atomicWrite(thoughtsFile, store)
      return true
    })
  }

  // ---------- 导出 ----------

  function markdown(id) {
    return serialize(async () => {
      const store = await loadThoughts()
      const item = store.thoughts.find((row) => row.id === id)
      if (!item) return null
      const lines = []
      lines.push(`# ${item.title || '未命名想法'}`)
      lines.push('')
      lines.push(`- 体裁：${item.genre}`)
      lines.push(`- 阶段：${STAGE_LABELS[item.stage] || item.stage}`)
      lines.push(`- 创建：${item.createdAt || ''}`)
      lines.push(`- 最近更新：${item.updatedAt || ''}`)
      lines.push('')
      if (item.summary) {
        lines.push('## 主旨')
        lines.push('')
        lines.push(item.summary)
        lines.push('')
      }
      if (Array.isArray(item.openQuestions) && item.openQuestions.length) {
        lines.push('## 还没想清的问题')
        lines.push('')
        for (const question of item.openQuestions) lines.push(`- ${question}`)
        lines.push('')
      }
      if (item.content) {
        lines.push('## 当前成形的内容')
        lines.push('')
        lines.push(item.content)
        lines.push('')
      }
      const asked = item.advanceAsked || {}
      const askedText = PHASES.map((p) => `${p.id}段${asked[String(p.id)] ? '已问' : '未问'}`).join('、')
      lines.push(`- 推进提醒：${askedText}`)
      const notes = item.phaseNotes || {}
      const filled = PHASES.filter((p) => typeof notes[String(p.id)] === 'string' && notes[String(p.id)].trim())
      if (filled.length) {
        lines.push('## 三段推进')
        lines.push('')
        for (const p of PHASES) {
          const body = notes[String(p.id)]
          if (!body || !String(body).trim()) continue
          lines.push(`### ${p.id}. ${p.label}——${p.hint}`)
          lines.push('')
          lines.push(String(body).trim())
          lines.push('')
        }
      }
      if (Array.isArray(item.revisions) && item.revisions.length > 1) {
        lines.push('## 演化轨迹')
        lines.push('')
        for (const rev of item.revisions) {
          const label = STAGE_LABELS[rev.stage] || rev.stage
          lines.push(`- ${rev.at} · ${label} · 第${rev.phase || 1}段 · ${rev.summary || rev.title || ''}`.trimEnd())
        }
        lines.push('')
      }
      return lines.join('\n')
    })
  }

  // ---------- 会话开关 ----------

  function isActive(sessionId) {
    if (!sessionId) return false
    return loadMode().activeSessions.includes(sessionId)
  }

  async function hydrateMode() {
    return loadMode()
  }

  function activeSessions() {
    return loadMode().activeSessions.slice()
  }

  function setActive(sessionId, on) {
    return serialize(async () => {
      if (!sessionId) return false
      const current = loadMode()
      const has = current.activeSessions.includes(sessionId)
      if (on && !has) current.activeSessions.push(sessionId)
      if (!on && has) current.activeSessions = current.activeSessions.filter((id) => id !== sessionId)
      await atomicWrite(modeFile, current)
      return current.activeSessions.includes(sessionId)
    })
  }


  /**
   * 「这一段该收尾了」的提醒闸门：同一段只放行一次。
   * 返回 shouldAsk=false 时，调用方必须闭嘴——不能再问第二次。
   */
  function markAdvanceAsked(id, phase) {
    return serialize(async () => {
      const store = await loadThoughts()
      const found = store.thoughts.find((item) => item.id === id)
      if (!found) return null
      const from = normalizePhase(phase !== undefined ? phase : found.phase)
      if (!found.advanceAsked || typeof found.advanceAsked !== 'object') found.advanceAsked = {}
      const already = Boolean(found.advanceAsked[String(from)])
      if (!already) {
        found.advanceAsked[String(from)] = true
        found.updatedAt = nowIso()
        await atomicWrite(thoughtsFile, store)
      }
      return { shouldAsk: !already, from, to: from < 3 ? from + 1 : 0 }
    })
  }

  // ---------- 当前想法 / 换段 ----------

  /** 一个会话里只有一条「正在推进」的想法：最近更新、且没归档的那条。 */
  function pickCurrent(thoughts, sessionId) {
    if (!sessionId) return null
    const rows = thoughts
      .filter((item) => item && item.sessionId === sessionId && item.stage !== 'archived')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    return rows[0] || null
  }

  function currentThought(sessionId) {
    return serialize(async () => {
      const store = await loadThoughts()
      return pickCurrent(store.thoughts, sessionId)
    })
  }

  /**
   * 同步版：系统提示词装配是同步的，等不了 await。
   * 只在内存里已经载入过思路库时才有值，载入前返回 null——最多第一轮少一行进度提示。
   */
  function currentThoughtSync(sessionId) {
    if (!sessionId || !data) return null
    return pickCurrent(data.thoughts, sessionId)
  }

  async function hydrateThoughts() {
    return loadThoughts()
  }

  /**
   * 用户点「推进」：把当前想法换到下一段。
   *
   * force=false 时先过机检，缺产物就不动、把缺哪几项交回去；
   * force=true 是用户看完清单仍然要硬推，那就推。
   * 已经在第 3 段时，推进 = 定稿归档。
   */
  function advancePhase({ sessionId, id, force = false } = {}) {
    return serialize(async () => {
      const store = await loadThoughts()
      let found = null
      if (id) found = store.thoughts.find((item) => item.id === id) || null
      if (!found) found = pickCurrent(store.thoughts, sessionId)
      if (!found) return { ok: false, reason: 'no-thought' }

      const phase = normalizePhase(found.phase)
      const gate = checkGate(found, phase)

      if (found.stage === 'archived') return { ok: false, reason: 'archived', id: found.id, phase, gate }
      if (!force && !gate.ok) return { ok: false, reason: 'gate', id: found.id, phase, gate }

      const at = nowIso()
      if (!Array.isArray(found.advanceHistory)) found.advanceHistory = []

      if (phase >= 3) {
        found.stage = 'archived'
        found.updatedAt = at
        found.advanceHistory.push({ from: 3, to: 0, at, forced: Boolean(force) })
        pushRevision(found, at)
        await atomicWrite(thoughtsFile, store)
        return { ok: true, id: found.id, phase: 3, archived: true, gate, forced: Boolean(force) }
      }

      const to = phase + 1
      found.phase = to
      found.updatedAt = at
      if (!found.advanceAsked || typeof found.advanceAsked !== 'object') found.advanceAsked = {}
      // 进了新的一段，就重新给模型一次「该收尾了」的提醒额度。
      delete found.advanceAsked[String(to)]
      found.advanceHistory.push({ from: phase, to, at, forced: Boolean(force) })
      pushRevision(found, at)
      await atomicWrite(thoughtsFile, store)
      return { ok: true, id: found.id, phase: to, archived: false, gate, forced: Boolean(force) }
    })
  }

  /**
   * 这条想法里到底有没有东西。
   * 刚点「去研究」建出来的那条是空的——那会儿还一句话都没聊，
   * 前端不该把「推进到第 N 段」摆出来，等真落下东西再说。
   */
  function hasMaterial(thought) {
    if (!thought) return false
    if (String(thought.content || '').trim()) return true
    const notes = thought.phaseNotes || {}
    for (const phase of PHASES) {
      if (typeof notes[String(phase.id)] === 'string' && notes[String(phase.id)].trim()) return true
    }
    if (Array.isArray(thought.openQuestions) && thought.openQuestions.length > 0) return true
    return false
  }

  /** 给前端一次拿全：开关、当前想法、这段的产物机检。 */
  function status(sessionId) {
    return serialize(async () => {
      const store = await loadThoughts()
      const current = pickCurrent(store.thoughts, sessionId)
      return {
        active: isActive(sessionId),
        current: current
          ? {
              id: current.id,
              title: current.title,
              stage: current.stage,
              phase: normalizePhase(current.phase),
              genre: current.genre,
              filled: hasMaterial(current),
            }
          : null,
        gate: current ? checkGate(current, current.phase) : null,
      }
    })
  }

  // ---- 随想记录本 ----
  // 想法还碎的时候先丢进这里，别逼用户当场给它起标题、定体裁。

  function sparkList() {
    return serialize(async () => {
      const box = await loadSparks()
      const sorted = [...box.sparks].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      return { sparks: sorted }
    })
  }

  function addSpark({ text } = {}) {
    return serialize(async () => {
      const value = String(text || '').trim()
      if (!value) return { ok: false, reason: 'empty' }
      const box = await loadSparks()
      const at = nowIso()
      const spark = {
        id: `spark_${randomUUID().slice(0, 8)}`,
        text: value.slice(0, 2000),
        createdAt: at,
        updatedAt: at,
        thoughtId: '',
      }
      box.sparks.unshift(spark)
      if (box.sparks.length > MAX_SPARKS) box.sparks = box.sparks.slice(0, MAX_SPARKS)
      await atomicWrite(sparksFile, box)
      return { ok: true, spark }
    })
  }

  function updateSpark({ id, text } = {}) {
    return serialize(async () => {
      const box = await loadSparks()
      const spark = box.sparks.find((item) => item.id === id)
      if (!spark) return { ok: false, reason: 'not-found' }
      const value = String(text || '').trim()
      if (!value) return { ok: false, reason: 'empty' }
      spark.text = value.slice(0, 2000)
      spark.updatedAt = nowIso()
      await atomicWrite(sparksFile, box)
      return { ok: true, spark }
    })
  }

  function removeSpark({ id } = {}) {
    return serialize(async () => {
      const box = await loadSparks()
      const before = box.sparks.length
      box.sparks = box.sparks.filter((item) => item.id !== id)
      if (box.sparks.length === before) return { ok: false, reason: 'not-found' }
      await atomicWrite(sparksFile, box)
      return { ok: true }
    })
  }

  /**
   * 从一条随想直接开一条思路。
   * 注意：这里不能把 save() 套进 serialize() 里——save 自己也会排队，套起来就是自己等自己。
   * 所以拆成「读随想 → 存思路 → 回写随想」三段顺序 await。
   */
  function startFromSpark({ id, sessionId } = {}) {
    return (async () => {
      const found = await serialize(async () => {
        const box = await loadSparks()
        const spark = box.sparks.find((item) => item.id === id)
        return spark ? { id: spark.id, text: spark.text } : null
      })
      if (!found) return { ok: false, reason: 'not-found' }

      const thought = await save({
        sessionId: sessionId || '',
        summary: found.text,
        stage: 'raw',
        phase: 1,
      })

      const at = nowIso()
      await serialize(async () => {
        const box = await loadSparks()
        const spark = box.sparks.find((item) => item.id === id)
        if (spark) {
          spark.thoughtId = thought.id
          spark.usedAt = at
          spark.updatedAt = at
        }
        await atomicWrite(sparksFile, box)
      })

      return {
        ok: true,
        spark: { id: found.id },
        thought: { id: thought.id, title: thought.title, phase: normalizePhase(thought.phase) },
      }
    })()
  }

  // ---------------- 偏好（挂件显隐） ----------------

  function loadPrefs() {
    if (prefs) return prefs
    try {
      const parsed = JSON.parse(readFileSync(prefsFile, 'utf8'))
      prefs = { dockHidden: parsed && parsed.dockHidden === true }
    } catch {
      prefs = { ...PREF_DEFAULTS }
    }
    return prefs
  }

  function getPrefs() {
    return { ...loadPrefs() }
  }

  function setPrefs(patch) {
    return serialize(async () => {
      const current = { ...loadPrefs() }
      if (patch && typeof patch.dockHidden === 'boolean') current.dockHidden = patch.dockHidden
      prefs = current
      await atomicWrite(prefsFile, current)
      return { ...current }
    })
  }

  return {
    dir: base,
    markAdvanceAsked,
    list,
    get,
    save,
    remove,
    markdown,
    hydrateMode,
    hydrateThoughts,
    isActive,
    activeSessions,
    setActive,
    currentThought,
    currentThoughtSync,
    advancePhase,
    status,
    sparkList,
    addSpark,
    updateSpark,
    removeSpark,
    startFromSpark,
    getPrefs,
    setPrefs,
  }
}
