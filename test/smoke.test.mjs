import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'

import { buildBrief, pack, unpack, extractToken, decodeSessionBuffer, renderTranscriptBrief } from '../lib/core.js'

const SESSION_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')

function newestSessionFile() {
  let newest = null
  for (const bucket of readdirSync(SESSION_ROOT)) {
    const bucketDir = join(SESSION_ROOT, bucket)
    let dirs
    try { dirs = readdirSync(bucketDir) } catch { continue }
    for (const dir of dirs) {
      const file = join(bucketDir, dir, 'session.v4.jsonl.zstd')
      let stat
      try { stat = statSync(file) } catch { continue }
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs, id: dir }
    }
  }
  return newest
}

test('brief → token → brief round-trips and detects tampering', () => {
  const brief = buildBrief({
    title: '手机上的对话',
    machine: 'phone',
    goal: '把千川计划 188 复制到新账户',
    decisions: ['先备份参数再删除原计划'],
    todos: ['核对每个抖音号素材'],
    files: ['C:/work/plan.json'],
  })
  const result = pack(brief, { machine: 'phone' })
  assert.ok(result.link.startsWith('dshshare://open/DSHP1.'))
  const back = unpack('随便一段话 看这里 ' + result.link + ' 后面还有字')
  assert.equal(back.markdown, brief)
  assert.equal(back.meta.machine, 'phone')
  assert.equal(extractToken('DSHP1.abc') , 'DSHP1.abc')
  const tampered = result.token.slice(0, -6) + 'AAAAAA'
  assert.throws(() => unpack(tampered))
})

test('decodes a real persisted session into events', () => {
  const newest = newestSessionFile()
  assert.ok(newest, 'no session files found')
  const events = decodeSessionBuffer(readFileSync(newest.file))
  assert.ok(events.length > 10, 'expected a populated transcript, got ' + events.length)
  assert.ok(events.some(e => e.type === 'session'))
  assert.ok(events.some(e => e.type === 'user/message'))
  const brief = renderTranscriptBrief(events, { budget: 4000 })
  assert.match(brief, /会话交接单/)
  assert.ok(brief.length > 200)
  assert.ok(brief.length < 20000, 'brief too large: ' + brief.length)
})

test('host plugin registers two tools and answers the pack route', async () => {
  const { apply, name, inject } = await import('../lib/index.js')
  assert.equal(name, 'dsh-share-pack')
  assert.deepEqual(inject, ['tools', 'webServer'])
  const tools = new Map()
  let route = null
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition) } },
    webServer: { register(definition) { route = definition; return () => {} } },
    effect(factory) { return factory() },
  }
  apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), ['read_session_pack', 'share_session_pack'])
  for (const [toolName, definition] of tools) {
    // The registry projects definition.parameters straight onto the model-facing
    // schema, so it must already be a raw object-rooted JSON Schema, and the whole
    // definition must survive a lossless JSON snapshot.
    assert.equal(definition.parameters.type, 'object', toolName + ' parameters must be a raw object schema')
    assert.ok(definition.parameters.properties, toolName + ' parameters need properties')
    assert.ok(Array.isArray(definition.parameters.required), toolName + ' parameters need required list')
    assert.ok(definition.output && definition.output.schema, toolName + ' needs an output schema')
    assert.equal(typeof definition.output.render, 'function', toolName + ' needs a renderer')
    assert.equal(typeof definition.execute, 'function', toolName + ' needs execute')
    // The registry snapshots parameters before schema projection; they must be lossless JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(definition.parameters)), definition.parameters)
    assert.deepEqual(JSON.parse(JSON.stringify(definition.output.schema)), definition.output.schema)
  }
  assert.ok(tools.get('share_session_pack').parameters.required.includes('goal'))

  // Short links go through a paste host, so stand one up in memory instead of
  // hitting the network from a unit test.
  const store = new Map()
  let pastes = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === 'https://api.pastes.dev/post') {
      const key = 'test' + (++pastes)
      store.set(key, String(init.body))
      return new Response(JSON.stringify({ key }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const match = url.match(/^https:\/\/api\.pastes\.dev\/(.+)$/)
    if (match) {
      if (!store.has(match[1])) return new Response('not found', { status: 404 })
      return new Response(store.get(match[1]), { status: 200 })
    }
    throw new Error('unexpected fetch ' + url)
  }
  const shared = await tools.get('share_session_pack').execute({ goal: '测试目标', machine: 'home-pc' })
  assert.equal(shared.link, 'https://pastes.dev/test1')
  const read = await tools.get('read_session_pack').execute({ link: shared.link })
  assert.match(read.markdown, /测试目标/)

  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-share')

  const answer = await new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; return this },
      end(payload) { this.body = payload ? String(payload) : ''; resolve(this) },
    }
    route.handler({ method: 'GET', url: '/dsh-share/pack?session=' + newestSessionFile().id }, res)
    const timer = setTimeout(() => reject(new Error('route timed out')), 20000)
    timer.unref?.()
  })
  assert.equal(answer.status, 200)
  const body = JSON.parse(answer.body)
  assert.equal(body.ok, true, answer.body)
  assert.equal(body.short, true)
  assert.equal(body.link, 'https://pastes.dev/test2')
  assert.ok(unpack(store.get('test2')).markdown.length > 200)
  globalThis.fetch = realFetch
})

test('client bundle loads, registers, and copies the link on click', async () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const listeners = []
  const fakeState = []
  let stateIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const slot = stateIndex++
      if (!(slot in fakeState)) fakeState[slot] = initial
      listeners.push(slot)
      return [fakeState[slot], value => { fakeState[slot] = typeof value === 'function' ? value(fakeState[slot]) : value }]
    },
  }
  let clipboard = ''
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { loaded = definition } }, prompt(msg, value) { clipboard = value } },
    require(id) {
      if (id === 'react') return React
      throw new Error('unexpected external: ' + id)
    },
    fetch: async url => ({
      json: async () => ({ ok: true, link: 'dshshare://open/DSHP1.test', chars: 30 }),
      url,
    }),
    navigator: { clipboard: { async writeText(text) { clipboard = text } } },
    setTimeout: () => 0,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(loaded, 'client did not call __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-share-pack')
  const mod = loaded.factory(sandbox.require)
  assert.equal(mod.name, 'dsh-share-pack')
  assert.equal(mod.inject.join(','), 'slots')

  const registrations = []
  const ctx = {
    slots: {
      inject(slot, factory) { assert.equal(slot, 'conversation.session.header.actions'); return factory() },
      register(definition, component) { registrations.push({ definition, component }); return () => {} },
    },
    effect(factory) { return factory() },
  }
  mod.apply(ctx)
  assert.equal(registrations.length, 1)
  const { definition, component } = registrations[0]
  assert.equal(definition.name, 'conversation.session.header.actions')
  assert.equal(definition.id, 'dsh-share-pack')

  stateIndex = 0
  const tree = component({ sessionId: 'session-test' })
  assert.equal(tree.type, 'button')
  await tree.props.onClick()
  assert.equal(clipboard, 'dshshare://open/DSHP1.test')
})
