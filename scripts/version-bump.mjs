#!/usr/bin/env node
// 每次打包自增最小版本号(patch),满 10 向前进位:
// 0.1.0 → 0.1.1 → … → 0.1.9 → 0.2.0 → … → 0.9.9 → 1.0.0
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

let [major, minor, patch] = String(pkg.version || '0.0.0')
  .split('.')
  .map((n) => parseInt(n, 10) || 0)

patch += 1
if (patch >= 10) {
  patch = 0
  minor += 1
  if (minor >= 10) {
    minor = 0
    major += 1
  }
}

const next = `${major}.${minor}.${patch}`
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
console.log(`[version-bump] ${next}`)
