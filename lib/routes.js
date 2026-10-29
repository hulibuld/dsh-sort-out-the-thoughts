/**
 * 给浏览器半边用的 HTTP 路由。
 *
 * 全部挂在 /plugins/dsh-sort-out-the-thoughts/ 下，路由之间互不相交。
 * 只接受本机回环来源：这个插件没有账号体系，靠「只服务本机 GUI」当边界。
 */
import { checkGate } from './store.js'

const PREFIX = '/plugins/dsh-sort-out-the-thoughts'
const MAX_BODY = 1 << 20

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false
  const text = address.startsWith('::ffff:') ? address.slice(7) : address
  return text === '::1' || text === '127.0.0.1' || /^127\./.test(text)
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || !host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'local-only' }))
    return false
  }
  return true
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('bad-json'))
      }
    })
    req.on('error', reject)
  })
}

function query(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

export function registerRoutes(webServer, store) {
  const disposers = []

  const route = (kind, path, handler) => {
    disposers.push(
      webServer.register({
        kind,
        path: PREFIX + path,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          try {
            await handler(req, res)
          } catch (error) {
            const message = error && error.message ? error.message : 'unknown'
            if (!res.headersSent) sendJson(res, 400, { error: message })
            else res.end()
          }
        },
      }),
    )
  }

  // 当前会话的开关状态 + 概览（列表页首屏用一次拿全）
  route('exact', '/state', async (req, res) => {
    const sessionId = query(req).get('sessionId') || ''
    const thoughts = await store.list({})
    const sessionStatus = sessionId ? await store.status(sessionId) : { active: false, current: null, gate: null }
    sendJson(res, 200, {
      active: sessionStatus.active,
      current: sessionStatus.current,
      gate: sessionStatus.gate,
      thoughts: thoughts.slice(0, 20),
      total: thoughts.length,
    })
  })

  // 推进：用户点输入框旁的按钮，把当前想法换到下一段（第 3 段再点就是定稿归档）
  route('exact', '/advance', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const id = typeof body.id === 'string' ? body.id : ''
    if (!sessionId && !id) return sendJson(res, 400, { error: 'sessionId or id required' })
    const result = await store.advancePhase({ sessionId, id, force: body.force === true })
    sendJson(res, result.ok ? 200 : 409, result)
  })

  // 开关：只认 sessionId + on 两个键
  route('exact', '/toggle', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' })
    const on = body.on === true
    const next = await store.setActive(sessionId, on)
    sendJson(res, 200, { active: next })
  })

  // 列表：支持关键词与体裁筛选
  route('exact', '/thoughts', async (req, res) => {
    const params = query(req)
    const thoughts = await store.list({
      query: params.get('q') || '',
      genre: params.get('genre') || '',
    })
    sendJson(res, 200, { thoughts })
  })

  // 单条详情
  route('exact', '/thought', async (req, res) => {
    const id = query(req).get('id') || ''
    const thought = id ? await store.get(id) : null
    if (!thought) return sendJson(res, 404, { error: 'not-found' })
    sendJson(res, 200, { thought, gate: checkGate(thought, thought.phase) })
  })

  // 导出 Markdown（浏览器直接下载）
  route('exact', '/export', async (req, res) => {
    const id = query(req).get('id') || ''
    const text = id ? await store.markdown(id) : null
    if (text === null) return sendJson(res, 404, { error: 'not-found' })
    const body = Buffer.from(text, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="thought-${encodeURIComponent(id)}.md"`,
      'content-length': body.length,
    })
    res.end(body)
  })

  // 删除
  route('exact', '/delete', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return sendJson(res, 400, { error: 'id required' })
    const removed = await store.remove(id)
    sendJson(res, 200, { removed })
  })

  // ---- 随想记录本 ----

  // 全部随想，新的在前
  route('exact', '/sparks', async (req, res) => {
    const data = await store.sparkList()
    sendJson(res, 200, data)
  })

  // 记一条随想
  route('exact', '/spark/add', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const result = await store.addSpark({ text: body.text })
    sendJson(res, result.ok ? 200 : 400, result)
  })

  // 改一条随想
  route('exact', '/spark/update', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const result = await store.updateSpark({ id: body.id, text: body.text })
    sendJson(res, result.ok ? 200 : 400, result)
  })

  // 删一条随想
  route('exact', '/spark/delete', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const result = await store.removeSpark({ id: body.id })
    sendJson(res, result.ok ? 200 : 404, result)
  })

  // 从一条随想直接开一条思路，并把这个会话的开关打开
  route('exact', '/spark/start', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' })
    const result = await store.startFromSpark({ id: body.id, sessionId })
    if (!result.ok) return sendJson(res, 404, result)
    const active = await store.setActive(sessionId, true)
    sendJson(res, 200, { ...result, active })
  })

  // 偏好：目前只有「悬浮挂件显隐」一项
  route('exact', '/prefs', async (req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, store.getPrefs())
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const next = await store.setPrefs(body)
    sendJson(res, 200, next)
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时重复 dispose 不该炸 */
      }
    }
  }
}
