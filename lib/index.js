// Host half: the HTTP route the Share button calls, plus two model-facing tools.
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pack, unpack, seal, unseal, isSealed, buildBrief, decodeSessionBuffer, renderTranscriptBrief, describe } from './core.js'
import { upload, download } from './relay.js'

export const name = 'dsh-share-pack'
export const inject = ['tools', 'webServer']

const ROUTE_PREFIX = '/dsh-share'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function sessionRoot() {
  return join(dshHome(), 'sessions')
}

/** Append one line to the boot log so a failed load leaves evidence behind. */
function bootLog(line) {
  try {
    appendFileSync(join(dshHome(), 'dsh-share-pack.boot.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch {
    // A read-only home must never break the plugin itself.
  }
}

// Module-level marker: if this line never lands, the module failed to import and
// apply() was never reached at all (as opposed to apply() throwing on its own).
bootLog('module: imported')

const DEFAULTS = { secret: '', providers: ['pastes.dev', 'paste.rs', 'mclo.gs'], timeoutMs: 15000 }

let appliedConfig = null

function configPath() {
  return process.env.DSH_SHARE_PACK_CONFIG || join(dshHome(), 'dsh-share-pack.json')
}

/** Read machine config on every use, so editing the file needs no restart. */
function currentConfig() {
  const merged = { ...DEFAULTS, ...(appliedConfig || {}) }
  try {
    const file = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (file && typeof file === 'object') Object.assign(merged, file)
  } catch {
    // A missing config file is the normal case.
  }
  return merged
}

/** Turn a packed result into a short URL, falling back to the self-contained link. */
async function publish(result) {
  const config = currentConfig()
  const sealed = seal(result.token, config.secret)
  try {
    const sent = await upload(sealed, { providers: config.providers, timeoutMs: config.timeoutMs })
    return { link: sent.link, short: true, provider: sent.provider, sealed: Boolean(config.secret) }
  } catch (error) {
    return {
      link: result.link,
      short: false,
      provider: '',
      sealed: false,
      uploadError: String((error && error.message) || error),
    }
  }
}

/** Accept a short URL, a dshshare:// link, a bare token, or text containing one. */
async function readPack(input) {
  const text = String(input == null ? '' : input)
  const config = currentConfig()
  const url = text.match(/https?:\/\/[^\s"'<>）)]+/)
  if (url) {
    const body = (await download(url[0], { timeoutMs: config.timeoutMs })).trim()
    return unpack(isSealed(body) ? unseal(body, config.secret) : body)
  }
  return unpack(text)
}

/** Find one session's persisted transcript, either by id or by most recent write. */
function readSessionBytes(sessionId) {
  const root = sessionRoot()
  let buckets
  try {
    buckets = readdirSync(root)
  } catch {
    throw new Error('找不到 DSH 会话目录: ' + root)
  }
  let newest = null
  for (const bucket of buckets) {
    const bucketDir = join(root, bucket)
    let dirs
    try {
      dirs = readdirSync(bucketDir)
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.startsWith('session-')) continue
      if (sessionId && dir !== sessionId && 'session-' + sessionId !== dir) continue
      const dirPath = join(bucketDir, dir)
      for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const filePath = join(dirPath, file)
        let stat
        try {
          stat = statSync(filePath)
        } catch {
          continue
        }
        if (!sessionId) {
          if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { mtimeMs: stat.mtimeMs, filePath }
        } else {
          return readFileSync(filePath)
        }
      }
    }
  }
  if (newest) return readFileSync(newest.filePath)
  throw new Error('找不到会话: ' + (sessionId || '(最新会话)'))
}

function linkForSession(sessionId, options = {}) {
  const events = decodeSessionBuffer(readSessionBytes(sessionId))
  if (!events.length) throw new Error('会话里没有可读事件')
  const brief = renderTranscriptBrief(events, { mode: options.mode })
  const result = pack(brief, {
    machine: options.machine,
    kind: 'transcript',
    sessionId: sessionId || undefined,
  })
  return { ...result, brief }
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function handleRoute(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  let url
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    json(res, 400, { ok: false, error: 'bad url' })
    return
  }
  if (url.pathname === ROUTE_PREFIX + '/boot') {
    let log = ''
    try {
      log = readFileSync(join(dshHome(), 'dsh-share-pack.boot.log'), 'utf8')
    } catch (error) {
      log = 'no boot log: ' + String((error && error.message) || error)
    }
    json(res, 200, { ok: true, log })
    return
  }
  if (url.pathname !== ROUTE_PREFIX + '/pack') {
    json(res, 404, { ok: false, error: 'not found' })
    return
  }
  try {
    const sessionId = url.searchParams.get('session') || ''
    const machine = url.searchParams.get('machine') || ''
    const mode = url.searchParams.get('mode') || ''
    const result = linkForSession(sessionId, { machine: machine || undefined, mode: mode || undefined })
    const published = await publish(result)
    json(res, 200, {
      ok: true,
      link: published.link,
      chars: published.link.length,
      short: published.short,
      provider: published.provider,
      sealed: published.sealed,
      uploadError: published.uploadError,
      summary: describe(result),
    })
  } catch (error) {
    json(res, 500, { ok: false, error: String((error && error.message) || error) })
  }
}

/** The two tool definitions, kept out of apply() so a failure is attributable. */
function toolDefinitions() {
  return [
    {
      name: 'share_session_pack',
      description: [
        '把当前对话整理成一份「会话交接单」，压缩成可粘贴的 dshshare:// 链接（DSHP1. 令牌），供另一台设备/另一个 DSH 会话接手。',
        '调用前自己在 brief 字段里写清：目标、关键决定与理由、已确认的事实与数据、未完成事项、相关文件路径、最近对话要点。只写接手需要的信息，不要贴大段原始日志。',
        '返回 { link, chars }；把 link 原样交给用户复制。',
        '链接要经过聊天软件传输，所以 brief 尽量控制在 3000 字符以内：只留接手必须知道的内容，细节交给对方追问。',
      ].join('\n'),
      // Raw JSON Schema, not the defineTool property map: this plugin registers a
      // plain definition so it needs no value import from @deepseek-ai/dsh-tools.
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['goal'],
        properties: {
          goal: { type: 'string', description: '当前会话的目标/正在做的事，一两句话' },
          decisions: { type: 'array', items: { type: 'string' }, description: '关键决定和理由，每条一句' },
          facts: { type: 'array', items: { type: 'string' }, description: '已确认的事实、数据、接口、结论' },
          todos: { type: 'array', items: { type: 'string' }, description: '未完成事项和下一步' },
          files: { type: 'array', items: { type: 'string' }, description: '相关文件绝对路径' },
          recent: { type: 'array', items: { type: 'string' }, description: '最近对话要点' },
          note: { type: 'string', description: '给接手会话的补充说明' },
          title: { type: 'string', description: '会话标题' },
          machine: { type: 'string', description: '来源机器，例如 phone / home-pc / office-pc' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['link', 'token', 'chars', 'summary', 'brief'],
          properties: {
            link: { type: 'string' },
            token: { type: 'string' },
            chars: { type: 'integer' },
            summary: { type: 'string' },
            brief: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: '交接链接（整行复制给另一台 DSH）：\n' + value.link + '\n\n' + value.summary },
        ],
      },
      async execute(args) {
        const brief = buildBrief(args || {})
        const result = pack(brief, { title: args && args.title, machine: args && args.machine, kind: 'model' })
        const published = await publish(result)
        return { link: published.link, token: result.token, chars: published.link.length, brief, summary: describe(result) }
      },
    },
    {
      name: 'read_session_pack',
      description: [
        '读取别人分享来的 dshshare:// 链接或 DSHP1. 令牌，返回另一台 DSH 会话的交接单全文。',
        '拿到后先用一两句话确认你理解的目标与当前进度，再继续工作；如果交接单里有未完成事项，按顺序接着做。',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['link'],
        properties: {
          link: { type: 'string', description: 'dshshare:// 链接、DSHP1. 令牌，或包含它的整段文字' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['markdown', 'meta'],
          properties: {
            markdown: { type: 'string' },
            meta: { type: 'object' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.markdown }],
      },
      async execute(args) {
        const { markdown, meta } = await readPack(args && args.link)
        // Only lossless JSON reaches the model: drop keys with no value.
        const clean = {}
        for (const [key, value] of Object.entries(meta || {})) if (value !== undefined) clean[key] = value
        return { markdown, meta: clean }
      },
    },
  ]
}

export function apply(ctx, config) {
  appliedConfig = config || null
  const record = []
  bootLog('apply: enter (tools=' + typeof ctx.tools + ', webServer=' + typeof ctx.webServer + ')')

  const step = (label, body) => {
    try {
      body()
      record.push('ok ' + label)
    } catch (error) {
      record.push('FAIL ' + label + ': ' + String((error && error.stack) || error).slice(0, 600))
    }
  }

  // Route first: the browser half works even if tool registration is rejected.
  step('route', () => {
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
      throw new Error('webServer service unavailable')
    }
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRoute }),
      'dsh-share-pack: handoff route',
    )
    bootLog('route: registered prefix ' + ROUTE_PREFIX + ' (match: ' + ROUTE_PREFIX + ', ' + ROUTE_PREFIX + '/<x>)')
  })

  step('tools', () => {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') throw new Error('tools service unavailable')
    for (const definition of toolDefinitions()) ctx.tools.register(definition)
  })

  bootLog('apply: ' + record.join(' | '))
}
