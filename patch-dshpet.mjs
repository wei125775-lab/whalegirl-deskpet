/**
 * 给 @linxin666/dsh-pet 的活动相位白名单补上鲸鱼娘要用的三个自定义 phase 名。
 *
 * 为什么非改不可：manifest 的 `frames2d.phases` 是 **fail-closed** 校验的 ——
 * 出现不认识的名字（"unknown activity phase"）会让**整只宠物被静默丢弃**，
 * 宠物列表里直接没有她，也不报错。所以要用 whale-in / whale-loop / whale-out
 * 当相位，就得先让 dsh-pet 的 `PET_ACTIVITY_PHASES` 认识它们。
 *
 * 补丁同时落在两个文件里，因为它们各有一份数组：
 *   - lib/index.js                 （服务端那份，实际校验走它）
 *   - lib/types/manifest-v2.js     （导出的那份，`parsePetManifest` 走它）
 *
 * **dsh-pet 升级会把这个补丁冲掉。** 冲掉之后宠物插件里的护栏
 * （`stripWhalePhasesIfUnsupported`）会在 dsh-pet 读 manifest 之前把 whale-*
 * 相位摘掉，降级成"没有看鲸鱼"，不会让她整只消失 —— 但功能会静默关闭，
 * 所以要重新跑一遍本脚本（或重跑 install.mjs）恢复。
 *
 * 用法：
 *   node patch-dshpet.mjs [--dry-run] [--profile=<name>]
 * 或作为模块：import { patchDshPet } from './patch-dshpet.mjs'
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 要放行的相位名；同时也是"补过没有"的判据。 */
export const WHALE_PHASES = ['whale-in', 'whale-loop', 'whale-out']

const TARGETS = ['lib/index.js', 'lib/types/manifest-v2.js']
const ANCHOR = 'PET_ACTIVITY_PHASES'

/** 找到已安装的 dsh-pet 包根；找不到返回 undefined。 */
export function findDshPet({ dshHome, profileDir } = {}) {
  const roots = []
  if (profileDir !== undefined) roots.push(profileDir)
  const home = dshHome ?? ((process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'))
  try {
    for (const name of readdirSync(join(home, 'profiles'))) roots.push(join(home, 'profiles', name))
  } catch { /* 没有 profiles 目录就算了 */ }
  for (const root of roots) {
    const pkg = join(root, 'node_modules', '@linxin666', 'dsh-pet')
    if (existsSync(join(pkg, 'package.json'))) return pkg
  }
  return undefined
}

/**
 * 往 `PET_ACTIVITY_PHASES` 数组里追加名字。已经有的名字跳过。
 * 返回新的文本；找不到锚点返回 undefined。
 *
 * 注意原数组末项**可能没有尾逗号**（dsh-pet 0.3.20 的 lib/index.js 就是
 * `"failed"` 后直接 `];`），所以插入前要先补齐，否则补出一个语法错误，
 * 而那个错误会让整个 dsh 起不来。
 */
export function insertPhaseNames(text, names) {
  const anchorAt = text.indexOf(ANCHOR)
  if (anchorAt === -1) return undefined
  const openAt = text.indexOf('[', anchorAt)
  if (openAt === -1) return undefined
  const closeAt = text.indexOf(']', openAt)
  if (closeAt === -1) return undefined

  const body = text.slice(openAt, closeAt)
  const missing = names.filter((name) => !body.includes("'" + name + "'") && !body.includes('"' + name + '"'))
  if (missing.length === 0) return text

  let head = text.slice(0, closeAt).replace(/\s+$/, '')
  if (!head.endsWith(',')) head += ','
  const indent = body.includes('\n\t') ? '\n\t' : '\n    '
  // 跟着原数组的引号风格走（index.js 用双引号、manifest-v2.js 用单引号）
  const quote = (body.match(/["']/)?.[0]) ?? "'"
  const added = missing.map((name) => indent + quote + name + quote + ',').join('')
  return head + added + '\n' + text.slice(closeAt)
}

/**
 * 打补丁。幂等：已经补过的文件原样跳过。
 * @returns {{ ok: boolean, changed: string[], already: string[], missing: string[] }}
 */
export function patchDshPet({ dshHome, profileDir, dryRun = false, log = console.log, warn = console.warn } = {}) {
  const pkg = findDshPet({ dshHome, profileDir })
  if (pkg === undefined) {
    warn('[patch-dshpet] 找不到 @linxin666/dsh-pet，跳过（没装渲染器时宠物本来也显示不出来）')
    return { ok: false, changed: [], already: [], missing: TARGETS }
  }
  const changed = []
  const already = []
  const missing = []
  for (const rel of TARGETS) {
    const file = join(pkg, rel)
    if (!existsSync(file)) {
      missing.push(rel)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const next = insertPhaseNames(text, WHALE_PHASES)
    if (next === undefined) {
      missing.push(rel)
      continue
    }
    if (next === text) {
      already.push(rel)
      continue
    }
    if (!dryRun) {
      const backup = file + '.bak-whaleprobe'
      if (!existsSync(backup)) writeFileSync(backup, text)
      writeFileSync(file, next)
    }
    changed.push(rel)
  }
  if (changed.length > 0) log('[patch-dshpet] ' + (dryRun ? '将补' : '已补') + ' ' + changed.join(', '))
  if (already.length > 0) log('[patch-dshpet] 已经是补过的：' + already.join(', '))
  if (missing.length > 0) warn('[patch-dshpet] 找不到锚点或文件：' + missing.join(', ') + '（dsh-pet 结构变了？）')
  return { ok: changed.length > 0 || already.length === TARGETS.length, changed, already, missing }
}

// 直接执行时当命令行用
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const profileArg = argv.find((a) => a.startsWith('--profile='))
  const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const result = patchDshPet({
    dshHome: home,
    profileDir: profileArg === undefined ? undefined : join(home, 'profiles', profileArg.slice('--profile='.length)),
    dryRun,
  })
  if (!result.ok) process.exitCode = 1
  else if (!dryRun) console.log('[patch-dshpet] 完成。重启 DshDesktop 生效。')
}
