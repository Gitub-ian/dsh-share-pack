// dsh-share-pack core: handoff brief building, compression, and session-transcript rendering.
// Pure module (no DSH imports) so the CLI, tests, the host plugin and offline tooling share it.
import { brotliCompressSync, brotliDecompressSync, constants, zstdDecompressSync } from 'node:zlib'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

export const TOKEN_PREFIX = 'DSHP1.'
export const LINK_SCHEME = 'dshshare://open/'
export const MAX_PACKED_BYTES = 4 * 1024 * 1024
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64')
}
function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/** Build the markdown handoff brief. Unknown sections collapse away. */
export function buildBrief({ title, machine, cwd, createdAt, goal, decisions, facts, todos, files, recent, note } = {}) {
  const lines = ['# 会话交接单 / Session handoff', '']
  lines.push('- 来源机器: ' + (machine || 'unknown'))
  lines.push('- 会话: ' + (title || '未命名会话'))
  if (cwd) lines.push('- 工作目录: ' + cwd)
  lines.push('- 生成时间: ' + (createdAt || new Date().toISOString()))
  const section = (name, value) => {
    if (!value) return
    const body = Array.isArray(value)
      ? value.filter(Boolean).map(v => '- ' + String(v).trim()).join('\n')
      : String(value).trim()
    if (!body) return
    lines.push('', '## ' + name, '', body)
  }
  section('目标 / 正在做什么', goal)
  section('关键决定与理由', decisions)
  section('已确认的事实与数据', facts)
  section('未完成事项 / 下一步', todos)
  section('相关文件与位置', files)
  section('最近对话要点', recent)
  section('给接手会话的说明', note)
  return lines.join('\n').trim() + '\n'
}

/** Pack markdown into a pasteable token. */
export function pack(brief, meta = {}) {
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('brief must be a non-empty string')
  const payload = { v: 1, meta: { ...meta, createdAt: meta.createdAt || new Date().toISOString() }, md: brief, sum: digest(brief) }
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const packed = brotliCompressSync(json, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: json.length,
      [constants.BROTLI_PARAM_LGWIN]: 24,
    },
  })
  const token = TOKEN_PREFIX + b64urlEncode(packed)
  return { token, link: LINK_SCHEME + token, bytes: packed.length, ratio: packed.length / Math.max(1, json.length) }
}

export const SEALED_PREFIX = 'DSPE1.'

/**
 * Encrypt a packed token so a short link can point at a public paste without
 * publishing the conversation. The passphrase never travels inside the link, so
 * every machine that wants to read it must be configured with the same secret.
 */
export function seal(token, secret) {
  if (!secret) return token
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return SEALED_PREFIX + b64urlEncode(Buffer.concat([salt, iv, cipher.getAuthTag(), body]))
}

export function isSealed(text) {
  return typeof text === 'string' && text.trim().startsWith(SEALED_PREFIX)
}

export function unseal(text, secret) {
  if (!secret) throw new Error('这是一条加密链接：请在本机 dsh-share-pack.json 里填上和对方相同的 secret')
  const raw = b64urlDecode(String(text).trim().slice(SEALED_PREFIX.length))
  if (raw.length < 45) throw new Error('加密链接已损坏')
  const salt = raw.subarray(0, 16)
  const iv = raw.subarray(16, 28)
  const tag = raw.subarray(28, 44)
  const key = scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 })
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('解密失败：本机 secret 与分享方不一致')
  }
}

/** Extract the token from a link, token, quoted text, or whole chat message. */
export function extractToken(input) {
  if (typeof input !== 'string') throw new Error('link must be a string')
  const compact = input.replace(/\s+/g, '')
  const idx = compact.indexOf(TOKEN_PREFIX)
  if (idx < 0) throw new Error('not a dsh-share token: missing "' + TOKEN_PREFIX + '" prefix')
  const rest = compact.slice(idx + TOKEN_PREFIX.length)
  const m = rest.match(/^[A-Za-z0-9_-]+/)
  if (!m) throw new Error('malformed dsh-share token: empty body')
  return TOKEN_PREFIX + m[0]
}

/** Unpack a token/link back into markdown + meta. */
export function unpack(input) {
  const token = extractToken(input)
  const packed = b64urlDecode(token.slice(TOKEN_PREFIX.length))
  let json
  try {
    json = brotliDecompressSync(packed, { maxOutputLength: MAX_PACKED_BYTES })
  } catch (err) {
    throw new Error('dsh-share token is corrupt or truncated: ' + err.message)
  }
  const payload = JSON.parse(json.toString('utf8'))
  if (!payload || payload.v !== 1 || typeof payload.md !== 'string') throw new Error('unsupported dsh-share payload version')
  if (payload.sum !== digest(payload.md)) throw new Error('dsh-share token checksum mismatch')
  return { markdown: payload.md, meta: payload.meta || {}, token }
}

export function describe(packResult) {
  return 'token ' + packResult.token.length + ' 字符，压缩后 ' + packResult.bytes + ' 字节（压缩比 ' + packResult.ratio.toFixed(2) + '）'
}

/** Decode a persisted session file: concatenated zstd frames, or plain jsonl. */
export function decodeSessionBuffer(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  let text
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    const starts = []
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) starts.push(i)
    }
    const parts = []
    for (let k = 0; k < starts.length; k++) {
      const start = starts[k]
      const end = k + 1 < starts.length ? starts[k + 1] : bytes.length
      try {
        parts.push(zstdDecompressSync(bytes.subarray(start, end)).toString('utf8'))
      } catch {
        // A frame we cannot read is skipped; the rest of the transcript still counts.
      }
    }
    text = parts.join('')
  } else {
    text = bytes.toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Partially written trailing line.
    }
  }
  return events
}

/** Prose parts only: reasoning and tool-call blocks are not what a reader needs first. */
function proseOf(content) {
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) out.push(part.text.trim())
  }
  return out.join('\n\n').trim()
}

function oneLine(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** Truncate prose while keeping its paragraph breaks, so a clipped answer still reads. */
function clip(text, limit) {
  // A share token pasted into the chat is not content worth forwarding; nesting it
  // inside the next handoff would just be dead weight.
  const body = String(text)
    .replace(/dshshare:\/\/open\/DSHP1\.[A-Za-z0-9_-]+/g, '<dshshare 链接>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body.length > limit ? body.slice(0, limit).trimEnd() + '…' : body
}

/**
 * Turn recorded session events into a handoff brief someone else can act on.
 *
 * Prose first: user requests and assistant answers carry the intent, so they get
 * the budget. Tool activity is summarized as a count line plus a few recent calls,
 * because raw arguments are noise to a reader who needs the state of the work.
 */
export function renderTranscriptBrief(events, options = {}) {
  // Compact is the default because the token travels through chat apps: a brief
  // long enough to be complete is also long enough that nobody wants to paste it.
  const full = options.mode === 'full'
  const budget = options.budget || (full ? 9000 : 2600)
  const perMessageCap = full ? 4000 : 600
  const titleEvent = [...events].reverse().find(e => e && e.type === 'session/title')
  const title = titleEvent && titleEvent.data && titleEvent.data.title
  const sessionEvent = events.find(e => e && e.type === 'session')

  const messages = []
  const recentCalls = []
  const toolCounts = new Map()
  let firstUser = ''
  let todoEvent = null

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data || {}
    if (event.type === 'user/message') {
      // Context injections (runtime snapshot, skill catalog, time, plugin notices)
      // are recorded as user messages but carry a non-'user' source kind; they are
      // harness plumbing, not something the person said.
      const sourceKind = (data.source || {}).kind
      if (sourceKind !== undefined && sourceKind !== 'user') continue
      const text = proseOf(data.content) || (typeof data.text === 'string' ? data.text.trim() : '')
      if (!text || /^\[(Plugin context|Compressed conversation section)/.test(text)) continue
      if (!firstUser) firstUser = text
      messages.push({ role: '用户', text })
    } else if (event.type === 'assistant/message') {
      const text = proseOf((data.message || {}).content)
      if (text) messages.push({ role: '助手', text })
    } else if (event.type === 'tool/call') {
      const name = String(data.name || '?')
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1)
      recentCalls.push(name + ': ' + oneLine(data.arguments || '', 120))
      if (recentCalls.length > 12) recentCalls.shift()
    } else if (event.type === 'todo/write') {
      todoEvent = event
    }
  }

  // Spend the budget on the newest messages, then re-add the opening request.
  const messageBudget = Math.floor(budget * (full ? 0.75 : 0.7))
  let used = 0
  const tailMessages = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]
    // Charge the clipped size, not the raw size: one pasted giant message must not
    // evict every other turn from the budget.
    const cost = Math.min(entry.text.length, perMessageCap) + 12
    if (used + cost > messageBudget && tailMessages.length > 0) break
    used += cost
    tailMessages.unshift(entry)
  }

  const lines = ['# 会话交接单', '']
  lines.push('- 会话: ' + (title || '未命名会话'))
  if (sessionEvent && sessionEvent.cwd) lines.push('- 工作目录: ' + sessionEvent.cwd)
  if (full) {
    if (sessionEvent && sessionEvent.id) lines.push('- 会话 ID: ' + sessionEvent.id)
    lines.push('- 生成时间: ' + new Date().toISOString())
    lines.push('- 事件数: ' + events.length + '，纳入对话 ' + tailMessages.length + '/' + messages.length + ' 条')
  }

  if (firstUser) {
    lines.push('', '## 目标 / 会话起点', '', clip(firstUser, full ? 1500 : 900))
    if (full && tailMessages.length && tailMessages[0].text !== firstUser) {
      lines.push('', '（下面是最近的对话，从旧到新；开头的原始请求就是上面这段。）')
    }
  }

  if (tailMessages.length) {
    lines.push('', '## 对话摘录', '')
    for (const entry of tailMessages) {
      const text = clip(entry.text, perMessageCap)
      if (tailMessages.length > 1 && text.trim() === clip(firstUser, perMessageCap).trim()) continue
      lines.push('**' + entry.role + '**: ' + text, '')
    }
  } else {
    lines.push('', '## 对话摘录', '', '（本会话几乎没有正文消息，内容都在工具调用里，见下节。）')
  }

  if (toolCounts.size) {
    const summary = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => name + ' ×' + count).join('、')
    lines.push(full ? '## 工具活动' : '工具活动', '', '调用统计: ' + summary)
    if (full && recentCalls.length) {
      lines.push('', '最近的调用（参数已截断）:', '')
      for (const call of recentCalls) lines.push('- ' + call)
    }
    lines.push('')
  }

  if (todoEvent) {
    const todos = (todoEvent.data && (todoEvent.data.todos || todoEvent.data.items)) || []
    if (Array.isArray(todos) && todos.length) {
      lines.push('## 未完成事项（会话里最后一次 todo 写入）', '')
      for (const todo of todos) {
        if (!todo) continue
        const state = todo.status || (todo.done ? 'completed' : 'pending')
        lines.push('- [' + state + '] ' + oneLine(todo.content || todo.text || String(todo), 300))
      }
      lines.push('')
    }
  }

  lines.push(full ? '## 给接手会话的说明' : '说明', '', full
    ? '这是从另一台设备的 DSH 会话自动截取的实录，不是完整原文。先读「目标」和「对话摘录」的尾部确认进度，再继续；文件路径与命令按原样保留。'
    : '另一台设备的 DSH 会话摘要（非完整原文）。按「目标」+「对话摘录」尾部判断进度。')
  return lines.join('\n').trim() + '\n'
}