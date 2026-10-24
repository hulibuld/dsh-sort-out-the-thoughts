/**
 * dsh-sort-out-the-thoughts — 宿主半边。
 *
 * 三件事：
 *   1. 一个按会话门控的系统提示词片段：只有打开了开关的会话才进入「梳理模式」。
 *   2. 一个 sort_out_thoughts 工具，让模型把想法推进的状态存进思路库。
 *   3. 几条本机 HTTP 路由，给浏览器半边的开关和 Thoughts Center 设置页用。
 *
 * 门控的做法：系统提示词的装配上下文里 `assembly.scope` 就是发起本轮的那个 Agent，
 * 它的 `id` 是 SessionId，所以「这个会话开没开」问得出确切答案，不会串到别的对话。
 *
 * 工具不 import 宿主的 `@deepseek-ai/dsh-tools`：`ToolDefinition` 结构上就是
 * 「裸 ToolSchema + output + execute」，直接写标准 JSON Schema 就能注册，
 * 少一个解析不到的依赖，就少一种装到半死的可能。
 */
import { createStore, GENRES, normalizePhase, PHASES, STAGES } from './lib/store.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'sort-out-the-thoughts'

export const inject = ['webServer', 'tools', 'systemPrompt']

/** 按会话注入的梳理模式提示词。第一句要能独立读懂，整段控制在 600 字符内。 */
const MODE_PROMPT = [
  '你现在处在「梳理思路」模式：用户打开这个开关，是想把一个还模糊的想法，推成真能写出来、真能讲出来的东西。这个模式分三段，按顺序走，不要跳段。',
  '一、梳理：把用户自己讲的观点，和对话里新长出来的观点分开列清，让用户一眼看见哪句是他的、哪句是我们聊出来的。',
  '二、批判：一针见血地指出他方案和认知里的致命缺陷——不是给建议，是先把裂缝找出来。',
  '三、调研：把他的问题抽象成可检索的命题，跨领域大范围查证，再把结果落回他的需求。',
  '每轮只做当前这一段，最多问两三个具体问题，问完停下等回答，不要一次抛一长串。想法往前推进了，就调用 sort_out_thoughts（带 phase 和本段 notes）记录；用户说定稿用 finish 归档。',
  '每段快收尾时，先调用 sort_out_thoughts（action=advance）问一次路：它说该问，你就停下来让用户二选一——留在本段继续挖，还是进下一段；它说问过了就别再问，用户没表态就留在本段。用户自己说要进下一段，直接进。',
].join('')

const ACTION_LIST = ['save', 'list', 'get', 'advance', 'finish']

/** 配置 schema 拿不到就退化成「无 schema」，插件照常用默认值跑。 */
async function loadConfigSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const Schema = mod.default || mod
    if (!Schema || typeof Schema.object !== 'function') return undefined
    return Schema.object({
      maxThoughts: Schema.number().default(500).description('思路库条目上限；写满后会先淘汰最老的已归档条目。'),
    })
  } catch {
    return undefined
  }
}

export const Config = await loadConfigSchema()

export function apply(ctx, config = {}) {
  const configured = Number(config && config.maxThoughts)
  const store = createStore({ maxThoughts: configured > 0 ? configured : 500 })
  // 开关状态要在第一轮提示词装配前就位，但不该因为读盘慢挡住整棵树：
  // 先放出去，读失败也只是「开关暂时算关」。
  store.hydrateMode().catch(() => {})
  // 提示词里要报「当前第几段」，也得先把思路库读进内存；读不到就只是少一行进度。
  store.hydrateThoughts().catch(() => {})

  // ---- 1. 按会话门控的系统提示词 ----
  try {
    ctx.systemPrompt.section({
      name: 'sort-out-the-thoughts:mode',
      order: 60,
      text: (assembly) => {
        try {
          // scope 在 agent loop 里就是发起本轮的那个 Agent；也兼容直接给会话 id 字符串。
          const scope = assembly && assembly.scope
          const sessionId =
            typeof scope === 'string' ? scope : scope && typeof scope.id === 'string' ? scope.id : ''
          if (!sessionId) return ''
          if (!store.isActive(sessionId)) return ''

          // 当前想到哪一段，每轮重新算：用户可能刚点过输入框旁的「推进」。
          const current = store.currentThoughtSync(sessionId)
          if (!current) return MODE_PROMPT
          const phase = normalizePhase(current.phase)
          const meta = PHASES.find((item) => item.id === phase) || PHASES[0]
          return (
            MODE_PROMPT +
            `当前进度：第${phase}段「${meta.label}」，想法叫《${current.title || '未命名'}》。` +
            '用户随时可以点输入框旁的「推进」按钮手动换段，那表示他认为这一段够了：你从下一段接着做，不要再回头补上一段。'
          )
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    ctx.logger?.warn?.('sort-out-the-thoughts: 系统提示词注册失败 %s', error && error.message ? error.message : error)
  }

  // ---- 2. sort_out_thoughts 工具 ----
  const toolSpec = {
    name: 'sort_out_thoughts',
    description:
      '把「梳理思路」的进展存进思路库，或读回已经存过的思路。只在梳理模式里用：save 用来在讨论推进后落一次状态（主旨、当前结构、还没想清的问题），finish 用来在用户说定稿时归档，list/get 用来回看之前的想法。三段推进时，phase 记当前在第几段，notes 记这一段的结论。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTION_LIST,
          description: 'save=新建或更新一条思路；advance=这一段该收尾了，问一次要不要换段（同一段只放行一次）；finish=归档这条思路；list=列出已有思路；get=读某一条。默认 save。',
        },
        id: { type: 'string', description: '已有思路的 id。save 时不传表示新建；get 和 finish 必传。' },
        title: { type: 'string', description: '这条思路的标题，可以后改。' },
        genre: { type: 'string', enum: GENRES, description: '体裁：文章 / 演讲稿 / 自媒体文稿 / 其他。' },
        stage: {
          type: 'string',
          enum: STAGES,
          description:
            '推进到哪一步：raw 刚起念、probing 追问中、shaped 有骨架、outlined 大纲定型、drafted 成稿、archived 已归档。',
        },
        phase: {
          type: 'number',
          enum: [1, 2, 3],
          description: '当前推进到第几段：1 梳理、2 批判、3 调研。不给就是保持原样（新条目默认 1）。',
        },
        from: {
          type: 'number',
          enum: [1, 2, 3],
          description: '要收尾的那一段（1–3）。只在 action=advance 时用；不给就用这条思路当前的段。',
        },
        notes: {
          type: 'string',
          description: '这一段做出来的结论，Markdown。会按当前 phase 分别存进「三段推进」，换段不会覆盖上一段。',
        },
        summary: { type: 'string', description: '一句话说清这条思路的核心主张，给未来的自己看。' },
        content: {
          type: 'string',
          description:
            '当前成形的东西，Markdown。可以是一句核心句、一份提纲或一段正文；它代表「现在最好的一版」。',
        },
        open_questions: { type: 'string', description: '还没想清的问题，一行一条。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          stage: { type: 'string' },
          phase: { type: 'number' },
          shouldAsk: { type: 'boolean' },
          from: { type: 'number' },
          to: { type: 'number' },
          total: { type: 'number' },
          thoughts: { type: 'array', items: { type: 'string' } },
          detail: { type: 'string' },
        },
        required: ['ok', 'action'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? value.action === 'list'
              ? `思路库共 ${value.total} 条。\n${(value.thoughts || []).join('\n')}`
              : value.action === 'advance'
                ? value.shouldAsk
                  ? `第 ${value.from} 段可以收尾了。停下来只问用户一次：这一段还要继续往下挖，还是进第 ${value.to} 段？（问完这次，同一段不再提醒。）`
                  : `第 ${value.from} 段的推进提醒已经问过了，不要再问；用户没表态就留在这一段继续。`
              : value.action === 'get'
                ? String(value.detail || '')
                : `已${value.action === 'finish' ? '归档' : '保存'}「${value.title || '未命名'}」（${value.stage || ''}，第 ${value.phase || 1} 段，id: ${value.id || '?'}）。后续要更新或归档这条，把 id 传回来。`
            : '操作没有完成。',
        },
      ],
    },
    async execute(args, exec) {
      const action = ACTION_LIST.includes(args && args.action) ? args.action : 'save'
      const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : ''

      try {
        if (action === 'list') {
          const rows = await store.list({})
          return {
            ok: true,
            action,
            total: rows.length,
            thoughts: rows.map((row) => `- ${row.id} [${row.genre}/${row.stage}/${row.phase}] ${row.title}`),
          }
        }

        if (action === 'get') {
          if (!args.id) return { ok: false, action }
          const thought = await store.get(args.id)
          if (!thought) return { ok: false, action }
          return {
            ok: true,
            action,
            id: thought.id,
            title: thought.title,
            stage: thought.stage,
            detail: await store.markdown(thought.id),
          }
        }

        if (action === 'advance') {
          if (!args.id) return { ok: false, action }
          const gate = await store.markAdvanceAsked(args.id, args.from)
          if (!gate) return { ok: false, action }
          return { ok: true, action, id: args.id, shouldAsk: gate.shouldAsk, from: gate.from, to: gate.to }
        }

        const patch = {
          id: args.id || undefined,
          title: args.title,
          genre: args.genre,
          stage: action === 'finish' ? 'archived' : args.stage,
          phase: args.phase,
          notes: args.notes,
          summary: args.summary,
          content: args.content,
          openQuestions: args.open_questions,
          sessionId,
        }
        if (action === 'finish' && !patch.id) return { ok: false, action }

        const saved = await store.save(patch)
        return { ok: true, action, id: saved.id, title: saved.title, stage: saved.stage, phase: saved.phase }
      } catch (error) {
        return { ok: false, action, detail: error && error.message ? error.message : 'unknown' }
      }
    },
  }

  try {
    ctx.tools.register(toolSpec)
  } catch (error) {
    ctx.logger?.warn?.('sort-out-the-thoughts: 工具注册失败 %s', error && error.message ? error.message : error)
  }

  // ---- 3. 本机 HTTP 路由 ----
  try {
    ctx.effect(() => registerRoutes(ctx.webServer, store), 'sort-out-the-thoughts: 本机路由')
  } catch (error) {
    ctx.logger?.warn?.('sort-out-the-thoughts: 路由注册失败 %s', error && error.message ? error.message : error)
  }

  ctx.logger?.info?.('sort-out-the-thoughts 已就绪：思路库在 %s', store.dir)
}
