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
 *    因此有 syncWhalePhases() 那道护栏。
 * 2. **applyActivity 不校验 phase**：服务上这个公开方法内部直接
 *    machine.onActivityStatus(input)，phase 原样流到客户端；客户端
 *    trackForPhase 只是查 config.phases[phase] 这张表。所以"表里挂得上键
 *    就能播"。
 * 3. **抢显示 + 吞事件**：dsh-pet 对子代理会话没有任何过滤，子代理自己的
 *    事件会 applyActivity 到自己身上并抢走 displaySession —— 不处理的话
 *    鲸鱼每被子代理的一次工具调用打断就从头重播一遍。所以把
 *    applyActivity 包一层，演出期间吞掉来自子代理会话的调用。
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** 指纹里连内容一起算的大小上限：配置文件都在这个线以下，帧都比它大。 */
const DIGEST_TEXT_MAX = 256 * 1024

/**
 * pet/ 目录的内容指纹。文件有增删改名、大小变化，或小文件（pet.json / voice.json
 * 这类配置）内容变化，指纹就变。
 *
 * 帧图片不读内容只记大小：72MB 全读一遍要给每次启动加几百毫秒，而换一张帧恰好
 * 大小不变的概率可以忽略。配置文件则必须读内容 —— 改一个数字（比如 stateMs
 * 2700→2324）大小很可能不变，只比大小会漏。
 */
function petDigest(petDir) {
  try {
    const files = []
    const walk = (abs, rel) => {
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        const nextRel = rel === '' ? ent.name : rel + '/' + ent.name
        if (ent.isDirectory()) walk(join(abs, ent.name), nextRel)
        else files.push(nextRel)
      }
    }
    walk(petDir, '')
    files.sort()
    const hash = createHash('sha1')
    for (const rel of files) {
      const abs = join(petDir, rel)
      const size = statSync(abs).size
      hash.update(rel + ':' + size + '\n')
      if (size <= DIGEST_TEXT_MAX) hash.update(readFileSync(abs))
    }
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

/** 列出一个宠物目录里 manifest 引用到、但磁盘上不存在的帧。 */
function missingFrames(petDir) {
  try {
    const raw = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf8'))
    const frames2d = raw?.frames2d
    if (frames2d === undefined) return []
    const dir = typeof frames2d.dir === 'string' ? frames2d.dir : 'frames'
    const missing = []
    for (const [name, track] of Object.entries(frames2d.tracks ?? {})) {
      for (const file of new Set(track.frames ?? [])) {
        if (!existsSync(join(petDir, dir, name, file))) missing.push(name + '/' + file)
      }
    }
    return missing
  } catch {
    return []
  }
}

/**
 * 把包内的 pet/ 释放到 $DSH_HOME/pets/<id>/，内容一致就跳过（幂等）。
 *
 * **比的是内容指纹，不是 manifest 里的版本号**（2026-09-22 改的）。版本号那套咬过
 * 两次：① pet.json 的 version 和 package.json 的版本是两处，改了 pet/ 里的素材或
 * 配置却没动那个数字，启动时静默跳过 —— 改了不生效；② 部署目录被拷坏（半份、缺帧）
 * 时版本号没变，下次启动照样跳过 —— 永不自愈。指纹没有这两个死角。
 *
 * 代价是丢掉了原来那道"包内版本不高于已装就不覆盖"的保护。它防的是"node_modules
 * 副本是旧的，把已装目录覆盖回旧版"，但包内那份正是 dsh 实际加载的，它才是权威，
 * 部署目录只是它的投影 —— 手工在部署目录里的改动本来就会被下次释放冲掉。
 *
 * 覆盖走"先拷到暂存目录、再把旧目录换出去"，不再先 rmSync：原来是先删再拷，中途
 * 失败（磁盘满、杀软锁文件）就只剩半份或者什么都没有，而外层只打一行警告。暂存
 * 和旧目录都放在 $DSH_HOME/ 下而不是 pets/ 里 —— pets/ 下每个子目录都会被 dsh-pet
 * 当成一只宠物扫，放进去等于凭空多出两只。
 */
function releasePet() {
  try {
    const target = join(dshHome(), 'pets', PET_ID)
    const packaged = petDigest(source)
    if (packaged === undefined) {
      console.warn('[whalegirl-deskpet] 包内 pet/ 读不出来，跳过释放')
      return
    }
    if (petDigest(target) === packaged) return

    const stamp = process.pid + '-' + Date.now()
    const stage = join(dshHome(), '.whalegirl-stage-' + stamp)
    const trash = join(dshHome(), '.whalegirl-old-' + stamp)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, stage, { recursive: true })

    let movedOld = false
    try {
      if (existsSync(target)) {
        renameSync(target, trash)
        movedOld = true
      }
      renameSync(stage, target)
    } catch (error) {
      if (movedOld) {
        try { renameSync(trash, target) } catch { /* 回滚也失败：原样抛出去，日志里会带上垃圾目录的路径 */ }
      }
      rmSync(stage, { recursive: true, force: true })
      throw error
    }
    if (movedOld) {
      try {
        rmSync(trash, { recursive: true, force: true })
      } catch {
        console.warn('[whalegirl-deskpet] 旧的部署目录没删掉，留在 ' + trash + '，可以手动删（不影响使用）')
      }
    }
    console.log('[whalegirl-deskpet] 已释放宠物 ' + PET_ID + ' ' + petVersion(source) + ' 到 ' + target)

    // 释放是"整目录重拷"，所以**包内（profile 的 node_modules 副本）少文件，部署这份就会跟着少**，
    // 而且不报错 —— 表现只是动作缺帧/画面空白。2026-09-19 真踩过：加了海豚素材却只拷了
    // pet.json 没拷 frames/，释放后 54 帧凭空消失。这里明确喊出来，别让它继续静默。
    const missing = missingFrames(target)
    if (missing.length > 0) {
      console.warn(
        '[whalegirl-deskpet] ⚠ 释放后仍有 ' + missing.length + ' 个引用帧找不到，宠物会显示不全。' +
        '多半是副本的 pet/frames/ 不完整（改完素材要整份同步，别只拷 pet.json）：' +
        missing.slice(0, 6).join(', ') + (missing.length > 6 ? ' …' : ''),
      )
    }
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
  // 兜底：只认「自己装在哪一个 profile」，从 import.meta.url 反推
  //   <profile>/node_modules/@wei125775-lab/whalegirl-deskpet/lib/index.js
  // 以前这里扫 $DSH_HOME/profiles 下的每一个 profile。同一个 home 里有两个 profile 都装了
  // 本插件时（比如 web 和 desktop），在 A 里加载的实例可能探到 B 的 dsh-pet，据此决定要不要
  // 摘 whale 相位 —— A 的「看鲸鱼」被 B 的状态左右。所以不再跨 profile 猜。
  try {
    const ownProfile = dirname(dirname(dirname(dirname(here))))
    const manifest = join(ownProfile, 'node_modules', '@linxin666', 'dsh-pet', 'package.json')
    if (!existsSync(manifest)) return undefined
    const meta = JSON.parse(readFileSync(manifest, 'utf8'))
    return join(dirname(manifest), typeof meta.main === 'string' ? meta.main : 'lib/index.js')
  } catch { /* 推不出来就当作探测失败 */ }
  return undefined
}

/** dsh-pet 认不认我们那几个自定义相位名。探测失败一律按"不认"处理（宁可丢鲸鱼，不能丢宠物）。 */
function dshPetAcceptsWhales() {
  try {
    const main = dshPetMain()
    if (main === undefined) return false
    const text = readFileSync(main, 'utf8')
    // 两种引号都认。patch-dshpet.mjs 是跟着原数组的引号风格插入的，这里只认双引号的话，
    // dsh-pet 哪天把数组改成单引号，补丁其实补上了、探测却找 'whale-in' 的字面量找不到，
    // 于是判成"没补"→ 静默摘掉相位 →「看鲸鱼」无声关闭，而且没有任何提示。
    return text.includes('"whale-in"') || text.includes("'whale-in'")
  } catch {
    return false
  }
}

/**
 * 让**部署的** manifest 里的 whale 相位与 dsh-pet 的能力保持一致。
 *
 * 为什么要双向同步、而不是"没补丁就摘掉"：`releasePet()` 只在包内版本**比已装的新**时才覆盖。
 * 于是有这么条路 —— 先装本包（那时没 dsh-pet，相位被摘）→ 之后才装 dsh-pet 并打上补丁
 * → 下次启动 releasePet 发现版本相同直接跳过，护栏又因为补丁已在而放行，**被摘掉的相位就再没人加回来**，
 * 看鲸鱼永久失效，除非版本号再升一次。所以这里要能补回、也能摘掉。
 *
 * 相位名是 fail-closed 校验的：留着不认的名字会让**整只宠物被静默丢弃**。
 */
function syncWhalePhases() {
  try {
    const file = join(dshHome(), 'pets', PET_ID, 'pet.json')
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const phases = raw?.frames2d?.phases
    if (phases === undefined) return

    const packaged = JSON.parse(readFileSync(join(source, 'pet.json'), 'utf8'))
    const wanted = {}
    for (const name of WHALE_PHASES) {
      const target = packaged?.frames2d?.phases?.[name]
      if (typeof target === 'string') wanted[name] = target
    }
    if (Object.keys(wanted).length === 0) return

    const supported = dshPetAcceptsWhales()
    let added = 0
    let removed = 0
    if (supported) {
      for (const [name, target] of Object.entries(wanted)) {
        if (phases[name] !== target) { phases[name] = target; added += 1 }
      }
    } else {
      for (const name of WHALE_PHASES) {
        if (name in phases) { delete phases[name]; removed += 1 }
      }
    }
    if (added === 0 && removed === 0) return

    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
    if (added > 0) {
      console.log('[whalegirl-deskpet] 已把 whale 相位补回部署的 manifest（dsh-pet 认这几个名字了）')
    } else {
      console.warn(
        '[whalegirl-deskpet] dsh-pet 没打 phase 白名单补丁，「看鲸鱼」已降级关闭' +
        '（已从宠物 manifest 摘掉 whale-* 相位，避免整只宠物被校验拒绝）。' +
        '补上补丁后相位会自动加回来：给 @linxin666/dsh-pet 的 ACTIVITY_PHASES 补上 ' +
        'whale-in / whale-loop / whale-out，或直接跑 patch-dshpet.mjs。',
      )
    }
  } catch (error) {
    console.warn('[whalegirl-deskpet] phase 同步失败：' + (error && error.message ? error.message : String(error)))
  }
}

// 顶层先跑一次（早于插件树 apply）；apply 里再兜一次，覆盖"逐个 import+apply"
// 的加载顺序。两边都是幂等的，第二次直接跳过。
releasePet()
syncWhalePhases()

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
  syncWhalePhases()
  try {
    startWhaleWatch(ctx)
  } catch (error) {
    console.warn('[whalegirl-deskpet] 看鲸鱼启动失败：' + (error && error.message ? error.message : String(error)))
  }
}

export default { apply, inject }
