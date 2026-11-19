// Short-link transport: upload a packed token, get a URL, fetch it back.
// Third-party paste hosts are the only transit available without the user running a
// relay, so every provider here is a public HTTPS endpoint with a tiny id in the URL.
const DEFAULT_TIMEOUT = 15000

async function pastesDev(text, timeoutMs) {
  const response = await fetch('https://api.pastes.dev/post', {
    method: 'POST',
    body: text,
    headers: { 'content-type': 'text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('pastes.dev HTTP ' + response.status)
  const body = await response.json().catch(() => null)
  if (!body || !body.key) throw new Error('pastes.dev returned no key')
  return 'https://pastes.dev/' + body.key
}

async function pasteRs(text, timeoutMs) {
  const response = await fetch('https://paste.rs', {
    method: 'POST',
    body: text,
    headers: { 'content-type': 'text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('paste.rs HTTP ' + response.status)
  const link = (await response.text()).trim()
  if (!/^https?:\/\/\S+$/.test(link)) throw new Error('paste.rs returned no url')
  return link
}

async function mcloGs(text, timeoutMs) {
  const response = await fetch('https://api.mclo.gs/1/log', {
    method: 'POST',
    body: new URLSearchParams({ content: text }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.json().catch(() => null)
  if (!body || body.success !== true || !body.id) throw new Error('mclo.gs refused the paste')
  return 'https://api.mclo.gs/1/raw/' + body.id
}

export const PROVIDERS = { 'pastes.dev': pastesDev, 'paste.rs': pasteRs, 'mclo.gs': mcloGs }

/** Upload and return the first provider that answers with a link. */
export async function upload(text, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT
  const order = options.providers && options.providers.length ? options.providers : Object.keys(PROVIDERS)
  const failures = []
  for (const name of order) {
    const send = PROVIDERS[name]
    if (!send) continue
    try {
      const link = await send(text, timeoutMs)
      return { link, provider: name }
    } catch (error) {
      failures.push(name + ': ' + String((error && error.message) || error))
    }
  }
  throw new Error('粘贴服务都不可用（' + failures.join('；') + '）')
}

/** pastes.dev serves the raw body from a different host than the visible link. */
export function rawUrl(url) {
  const text = String(url).trim()
  if (/^https:\/\/(www\.)?pastes\.dev\//.test(text)) {
    return text.replace(/^https:\/\/(www\.)?pastes\.dev\//, 'https://api.pastes.dev/')
  }
  return text
}

export async function download(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT
  const response = await fetch(rawUrl(url), {
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('读取链接失败: HTTP ' + response.status)
  return await response.text()
}
