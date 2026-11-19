#!/usr/bin/env node
// Install dsh-share-pack into a DSH profile on another machine.
//   node install.mjs [--profile <dir>] [--dry-run]
// Copies this folder into <profile>/node_modules/dsh-share-pack and makes the
// profile depend on it (file: path) and load it (dsh.profile.bundles).
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const profile = resolve(flag('--profile', join(homedir(), '.dsh', 'profiles', 'desktop')))
const target = join(profile, 'node_modules', 'dsh-share-pack')
const manifest = join(profile, 'package.json')

if (!existsSync(profile)) {
  console.error('找不到 profile: ' + profile)
  console.error('用 --profile <目录> 指定，例如 --profile C:/Users/你/.dsh/profiles/desktop')
  process.exit(1)
}

console.log('source : ' + here)
console.log('profile: ' + profile)
console.log('target : ' + target + (dryRun ? '  (dry-run)' : ''))

if (!dryRun) {
  cpSync(here, target, {
    recursive: true,
    force: true,
    filter: (path) => !/[\\/](node_modules|\.git)$/.test(path),
  })
  console.log('copied plugin files')
}

const raw = existsSync(manifest) ? readFileSync(manifest, 'utf8') : '{}'
let json
try {
  json = JSON.parse(raw)
} catch (error) {
  console.error('profile/package.json 不是合法 JSON，先修好再装: ' + String((error && error.message) || error))
  process.exit(1)
}

json.dependencies = json.dependencies || {}
// Running from node_modules means the package came from a registry, so depend
// on that version range instead of pointing at this copy on disk.
const fromRegistry = /[\\/]node_modules[\\/]/.test(here)
const ownVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
const spec = fromRegistry ? '^' + ownVersion : 'file:' + here
json.dependencies['dsh-share-pack'] = spec
console.log('dependency spec: ' + spec)
json.dsh = json.dsh || {}
json.dsh.profile = json.dsh.profile || {}
const bundles = (json.dsh.profile.bundles = json.dsh.profile.bundles || [])
if (!bundles.includes('dsh-share-pack')) bundles.push('dsh-share-pack')

const next = JSON.stringify(json, null, 2) + '\n'
if (next === raw) {
  console.log('profile/package.json 已是目标状态，无需改动')
} else if (dryRun) {
  console.log('would update profile/package.json:' + String.fromCharCode(10) + next)
} else {
  copyFileSync(manifest, manifest + '.bak')
  writeFileSync(manifest, next)
  console.log('updated profile/package.json (backup: package.json.bak)')
}

console.log('')
console.log('完成。下一步：完全退出 DSH 桌面端再打开，会话头部应出现「分享」按钮。')
console.log('想加密就再写 ' + join(homedir(), '.dsh', 'dsh-share-pack.json') + '：')
console.log('  { "secret": "和另外两台设备相同的口令" }')
