#!/usr/bin/env node
// Minimal CLI over lib/core.js: build a link from a markdown brief, or read one back.
import { readFileSync } from 'node:fs'
import { pack, unpack, describe } from '../lib/core.js'

const [command, ...rest] = process.argv.slice(2)

function flag(name) {
  const index = rest.indexOf('--' + name)
  return index >= 0 ? rest[index + 1] : undefined
}

if (command === 'pack') {
  const file = rest.find(arg => !arg.startsWith('--') && arg !== flag('title') && arg !== flag('machine'))
  if (!file) {
    console.error('usage: dsh-share pack <brief.md> [--title <t>] [--machine <m>]')
    process.exit(1)
  }
  const brief = readFileSync(file, 'utf8')
  const result = pack(brief, { title: flag('title'), machine: flag('machine'), kind: 'cli' })
  console.log(result.link)
  console.error(describe(result))
} else if (command === 'read') {
  const input = rest[0] || readFileSync(0, 'utf8')
  const { markdown, meta } = unpack(input)
  console.log(markdown)
  console.error('meta: ' + JSON.stringify(meta))
} else {
  console.error('usage: dsh-share <pack|read> …')
  process.exit(1)
}
