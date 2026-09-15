/**
 * @wei125775-lab/whalegirl-deskpet
 *
 * 把鲸鱼娘宠物释放到 dsh 的宠物目录，让 @linxin666/dsh-pet 能扫到它。
 *
 * 为什么要"释放"而不是"注册"：dsh-pet 的 frames2d 宠物只能从
 * `$DSH_HOME/pets/<id>/` 目录扫出来。它虽然有一个内联 manifest 的通道
 * （`config.pets` -> `extra`），但那条路走的是 resolvePetManifest，只认 v1
 * sprite2d 的 spritesheetPath —— 把 frames2d 的 manifest 喂进去会静默降级成
 * sprite2d。而 sprite2d 只有固定 9 个 Codex 动画名，装不下吃饭/收碗/比心
 * 这些自定义动作。dsh-pet 也没有对外暴露注册表或重扫接口，第三方插件只能
 * 往那个目录写文件。
 *
 * 为什么释放写在模块顶层而不是 apply 里：宠物注册表是 dsh-pet 的 apply 期间
 * 用 loadPetRegistry 扫目录建的。顶层副作用发生在整棵插件树的 apply 之前，
 * 这样装完首次启动就能扫到；写进 apply 就要看两个插件的 apply 谁先谁后了。
 *
 * 任何失败都只吞掉打日志，绝不抛 —— 插件树加载失败会让 dsh 整个起不来。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 宠物 id，同时也是 `$DSH_HOME/pets/` 下的目录名。 */
const PET_ID = 'whalegirl-hd'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'pet')

/** dsh 数据根目录，优先级同 @deepseek-ai/dsh-home-paths。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 读一个宠物目录的 manifest 版本号；读不出来（不存在/坏文件）返回 undefined。 */
function petVersion(petDir) {
  try {
    const raw = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf8'))
    return typeof raw.version === 'string' ? raw.version : undefined
  } catch {
    return undefined
  }
}

/** 把 "1.2.3" 拆成数字数组；解析不出来（非数字段）返回 undefined。 */
function parseVersion(text) {
  if (typeof text !== 'string') return undefined
  const parts = text.trim().split('.').map(Number)
  return parts.length > 0 && parts.every(n => Number.isInteger(n) && n >= 0) ? parts : undefined
}

/**
 * a 是否比 b 新。任何一边解析不出来就返回 undefined，让调用方退回"不同即覆盖"。
 * 短的一段按 0 补（"1.2" 视作 "1.2.0"）。
 */
function isNewer(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === undefined || pb === undefined) return undefined
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * 把包内的 pet/ 释放到 $DSH_HOME/pets/<id>/，版本一致就跳过（幂等）。
 * 覆盖前先整个删掉：只逐字拷贝的话，上一版多出来的帧会留在目录里，
 * 而 manifest 的 frames 是显式列表，残留文件不会被引用，只会白占空间。
 *
 * **包内版本不比已装的新时只警告、不覆盖。** 光比"相等就跳过"会出事：dsh 加载的是
 * 拷进 profile 的 node_modules 的那份副本，改了源码包却没同步副本时，副本的旧
 * 版本号 ≠ 已装目录的新版本号 → 整个目录被旧版覆盖回去，改了半天白改，而且不报错。
 */
function releasePet() {
  try {
    const target = join(dshHome(), 'pets', PET_ID)
    const packaged = petVersion(source)
    if (packaged === undefined) {
      console.warn('[whalegirl-deskpet] 包内 pet/pet.json 读不出来，跳过释放')
      return
    }
    const installed = petVersion(target)
    if (installed === packaged) return
    if (isNewer(packaged, installed) === false) {
      console.warn(
        '[whalegirl-deskpet] 已装宠物是 ' + installed + '，不低于包内的 ' + packaged +
        '，跳过释放。改完宠物记得同步 node_modules 里那份副本（或重跑 install.mjs）。',
      )
      return
    }
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
    console.log('[whalegirl-deskpet] 已释放宠物 ' + PET_ID + ' ' + packaged + ' 到 ' + target)
  } catch (error) {
    console.warn('[whalegirl-deskpet] 释放宠物失败：' + (error && error.message ? error.message : String(error)))
  }
}

// 顶层先跑一次（早于插件树 apply）；apply 里再兜一次，覆盖"逐个 import+apply"
// 的加载顺序。两边都是幂等的，第二次直接跳过。
releasePet()

export const name = '@wei125775-lab/whalegirl-deskpet'
export const inject = []

/** cordis 插件入口。宠物已在模块加载时释放完毕，这里只做兜底。 */
export function apply() {
  releasePet()
}

export default { apply, inject }
