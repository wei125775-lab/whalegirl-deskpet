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
 *
 * ---
 *
 * 「看鲸鱼」是同一份素材在 dsh 侧的移植，落在三层非官方机制上，都写在下面：
 *
 * 1. **phase 白名单**：manifest 的 frames2d.phases 是 fail-closed 校验的，
 *    自定义 phase 名会被拒（"unknown activity phase"），而拒绝的后果是
 *    **整只宠物被静默丢弃**。所以要先给 dsh-pet 的 ACTIVITY_PHASES 补上
 *    whale-in / whale-loop / whale-out —— 那是改第三方包，升级会被冲掉，
 *    因此有 stripWhalePhasesIfUnsupported() 那道护栏。
 * 2. **applyActivity 不校验 phase**：服务上这个公开方法内部直接
 *    machine.onActivityStatus(input)，phase 原样流到客户端；客户端
 *    trackForPhase 只是查 config.phases[phase] 这张表。所以"表里挂得上键
 *    就能播"。
 * 3. **抢显示 + 吞事件**：dsh-pet 对子代理会话没有任何过滤，子代理自己的
 *    事件会 applyActivity 到自己身上并抢走 displaySession —— 不处理的话
 *    鲸鱼每被子代理的一次工具调用打断就从头重播一遍。所以把
 *    applyActivity 包一层，演出期间吞掉来自子代理会话的调用。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 宠物 id，同时也是 `$DSH_HOME/pets/` 下的目录名。 */
const PET_ID = 'whalegirl-hd'

/** 自定义 phase 名 -> 由补丁放行；同时是护栏要检查/摘除的清单。 */
const WHALE_PHASES = ['whale-in', 'whale-loop', 'whale-out']

/** 演出结束后若迟迟没有新事件，兜底收场（子代理正常会以 turn/end 收尾）。 */
const SHOW_STALE_MS = 5 * 60 * 1000

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

/** 已安装的 dsh-pet 主文件路径；解析不出来返回 undefined。 */
function dshPetMain() {
  // 常规路径：插件装在 profile 的 node_modules 里时，dsh-pet 是它的兄弟包。
  try {
    return createRequire(import.meta.url).resolve('@linxin666/dsh-pet')
  } catch { /* 落到下面扫 profile */ }
  // 兜底：插件是被别处的路径 import 进来的（开发时直接从源码包跑），
  // 上面的解析会一路走到盘根也找不到 —— 改为直接扫每个 profile。
  try {
    const profiles = join(dshHome(), 'profiles')
    for (const name of readdirSync(profiles)) {
      const manifest = join(profiles, name, 'node_modules', '@linxin666', 'dsh-pet', 'package.json')
      if (!existsSync(manifest)) continue
      const meta = JSON.parse(readFileSync(manifest, 'utf8'))
      return join(dirname(manifest), typeof meta.main === 'string' ? meta.main : 'lib/index.js')
    }
  } catch { /* 扫不动就当作探测失败 */ }
  return undefined
}

/**
 * 护栏：whale-* 这几个 phase 名是靠改 dsh-pet 的 ACTIVITY_PHASES 白名单放行的。
 * dsh-pet 升级会把补丁冲掉，而 phase 白名单是 **fail-closed** —— manifest 里留着
 * 不认识的名字，整只宠物会被校验拒掉、从宠物列表里消失，且不报错。
 *
 * 所以每次释放之后、dsh-pet 读它之前，先探一下 dsh-pet 认不认这几个名字：
 * 不认就把它们从部署的 pet.json 里摘掉，降级成"没有鲸鱼"的版本，并打一条明显的日志。
 * 探测方式是读 dsh-pet 主文件里有没有 '"whale-in"' 这个字面量 —— 不引依赖、
 * 不执行它，最省事也最不容易误伤。
 */
function stripWhalePhasesIfUnsupported() {
  try {
    const file = join(dshHome(), 'pets', PET_ID, 'pet.json')
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const phases = raw?.frames2d?.phases
    if (phases === undefined || !WHALE_PHASES.some(name => name in phases)) return

    const main = dshPetMain()
    const patched = main !== undefined && readFileSync(main, 'utf8').includes('"whale-in"')
    if (patched) return

    for (const name of WHALE_PHASES) delete phases[name]
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
    console.warn(
      '[whalegirl-deskpet] dsh-pet 没打 phase 白名单补丁，「看鲸鱼」已降级关闭' +
      '（已从宠物 manifest 摘掉 whale-* 相位，避免整只宠物被校验拒绝）。' +
      '要恢复：给 @linxin666/dsh-pet 的 ACTIVITY_PHASES 补上 whale-in / whale-loop / whale-out。',
    )
  } catch (error) {
    console.warn('[whalegirl-deskpet] phase 护栏检查失败：' + (error && error.message ? error.message : String(error)))
  }
}

// 顶层先跑一次（早于插件树 apply）；apply 里再兜一次，覆盖"逐个 import+apply"
// 的加载顺序。两边都是幂等的，第二次直接跳过。
releasePet()
stripWhalePhasesIfUnsupported()

export const name = '@wei125775-lab/whalegirl-deskpet'
export const inject = ['pet']

/** 三段素材的时长，从包内 manifest 算，避免和帧数脱钩。 */
function whaleTimings() {
  try {
    const raw = JSON.parse(readFileSync(join(source, 'pet.json'), 'utf8'))
    const f2 = raw.frames2d
    const fallback = f2.defaultFrameMs ?? 83
    const ms = (name) => {
      const track = f2.tracks?.[name]
      if (track === undefined || track.frames.length === 0) return 1500
      return track.frames.length * (track.frameMs?.[0] ?? fallback)
    }
    return { inMs: ms('subagent-in'), outMs: ms('subagent-out') }
  } catch {
    return { inMs: 1577, outMs: 1411 }
  }
}

/**
 * 「看鲸鱼」演出：子代理出现时切到 whale-in → whale-loop，全部跑完播 whale-out 再复原。
 *
 * 演出期间把服务实例上的 applyActivity 包一层，**吞掉来自子代理会话的调用** ——
 * dsh-pet 对子代理会话没有过滤，它们的事件会抢走 displaySession 并把 phase 打回
 * tool/thinking，导致鲸鱼每被抢一次就从第 0 帧重播。主会话的事件照常放行。
 */
function startWhaleWatch(ctx) {
  let service
  try {
    service = ctx.get('pet')
  } catch {
    return
  }
  if (service === undefined || typeof service.applyActivity !== 'function') return

  const original = service.applyActivity.bind(service)
  const { inMs, outMs } = whaleTimings()

  // 我们自己驱动用的假会话：它只是 displaySession 的落点，不出现在气泡列表里
  // （不给 line，view() 里 perSession.bubble === undefined 会被跳过）。
  const stage = { id: 'whalegirl-deskpet:whale', header: {} }

  const show = { state: 'off', active: new Set(), savedPhase: 'idle', timer: undefined, lastSeen: 0 }

  const play = (phase) => {
    try {
      original(stage, { phase })
    } catch (error) {
      console.warn('[whalegirl-deskpet] 切鲸鱼相位失败：' + (error && error.message ? error.message : String(error)))
    }
  }

  const clearTimer = () => {
    if (show.timer !== undefined) {
      clearTimeout(show.timer)
      show.timer = undefined
    }
  }

  const begin = () => {
    clearTimer()
    show.state = 'in'
    show.lastSeen = Date.now()
    // 记下演出前她该在的状态。此刻子代理的首个事件已经被 dsh-pet 应用过了，
    // 取到的多半就是子代理自己的相位（tool/thinking），复原后同样落到"吃饭"。
    void Promise.resolve(service.state()).then(
      (snapshot) => { show.savedPhase = snapshot?.phase ?? 'idle' },
      () => { show.savedPhase = 'idle' },
    )
    play('whale-in')
    show.timer = setTimeout(() => {
      if (show.state !== 'in') return
      show.state = 'loop'
      play('whale-loop')
    }, inMs)
  }

  const end = () => {
    clearTimer()
    show.state = 'out'
    play('whale-out')
    show.timer = setTimeout(() => {
      show.state = 'off'
      show.active.clear()
      play(show.savedPhase)
    }, outMs)
  }

  // 吞掉子代理会话的 applyActivity：它们只会在演出期间抢显示。
  service.applyActivity = function guardedApplyActivity(session, input, whisper) {
    if (show.state !== 'off' && session?.header?.origin === 'subagent') return
    return original(session, input, whisper)
  }

  ctx.effect(() => () => {
    clearTimer()
    try {
      service.applyActivity = original
    } catch { /* 还原失败就留着，重启即恢复 */ }
  })

  ctx.on('session/event', (session, event) => {
    if (session?.header?.origin !== 'subagent') return
    show.lastSeen = Date.now()
    if (event?.type === 'turn/end' || event?.type === 'session/end') show.active.delete(session)
    else show.active.add(session)

    if (show.active.size === 0) {
      if (show.state !== 'off' && show.state !== 'out') end()
      return
    }
    if (show.state === 'off') begin()
  })

  ctx.on('session/disposed', (session) => {
    if (!show.active.delete(session)) return
    if (show.active.size === 0 && show.state === 'loop') end()
  })

  // 兜底：事件断流（子代理异常退出、turn/end 丢了）时也得收场。
  const sweep = setInterval(() => {
    if (show.state === 'off' || show.state === 'out') return
    if (Date.now() - show.lastSeen < SHOW_STALE_MS) return
    show.active.clear()
    end()
  }, 30000)
  ctx.effect(() => () => clearInterval(sweep))
}

/** cordis 插件入口。宠物已在模块加载时释放完毕，这里只做兜底与演出启动。 */
export function apply(ctx) {
  releasePet()
  stripWhalePhasesIfUnsupported()
  try {
    startWhaleWatch(ctx)
  } catch (error) {
    console.warn('[whalegirl-deskpet] 看鲸鱼启动失败：' + (error && error.message ? error.message : String(error)))
  }
}

export default { apply, inject }
