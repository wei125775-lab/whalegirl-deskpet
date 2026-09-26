/**
 * 读取包内的 pet/ 并解析成服务端能直接下发的形状。
 *
 * 和 dsh-pet 那套最大的不同：**素材就在包目录里，不用往 $DSH_HOME/pets/ 释放**。
 * dsh-pet 只从那个目录扫，所以以前必须先拷过去（还得比内容指纹、还得防着部署目录被
 * 降级覆盖）。我们自己的引擎自己控注册表，直接从包目录读，那一整块机制就不需要了。
 *
 * 这里的解析是**照 dsh-pet 的 manifest-v2 语义**来的，只是砍掉了我们没用的分支
 * （sprite2d / live2d / skins / gameplay 的其余部分）：帧时长优先 frameMs[i]，其次
 * 文件名尾部的 `_<ms>`，最后 defaultFrameMs；非循环轨道回落目标缺省是待机轨。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 帧图路由前缀（浏览器侧取图用，和 dsh-pet 的 /pet 分开，避免任何混淆）。 */
export const ASSET_PREFIX = '/whalegirl-pet'

/** 单张帧图的体积上限，和 dsh-pet 同量级。 */
const IMAGE_CAP = 20 * 1024 * 1024

/**
 * 动作链（一次性动作播完之后按权重挑下一个动作）放在**同级的独立文件**里，不写进
 * pet.json。理由：dsh-pet 对 track 的字段是白名单 + fail-closed
 * （`KNOWN_FRAMES2D_TRACK` 只有 frames / frameMs / loop / fallback），多一个字段就是
 * `diag.error`、**整只宠物被丢掉**。而这份 pet.json 还要给 legacy（dsh-pet）那条路用，
 * 所以扩展只能放它不认的文件里 —— 跟 `voice.json` 同一个套路。
 */
const TRANSITIONS_FILE = 'transitions.json'

const IMAGE_EXT = new Set(['.png', '.webp', '.gif', '.jpg', '.jpeg'])

/** 文件名尾部的时长编码，如 `f03_120.png`。 */
const FILENAME_MS = /_(\d+)\.(?:png|webp|gif|jpe?g)$/i

/** 一帧里数字的序号，用来做自然序（f10 排在 f9 后面，字典序会反）。 */
const FRAME_INDEX = /(\d+)(?:_\d+)?\.[a-z]+$/i

function extOf(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? '' : file.slice(dot).toLowerCase()
}

function assetUrl(rel) {
  return ASSET_PREFIX + '/' + rel.split('/').filter((s) => s !== '').join('/')
}

/** 列一个轨道目录里的图，按尾部数字自然排序。**没声明 `frames` 时才走这条。** */
function listFrames(absDir) {
  try {
    return readdirSync(absDir)
      .filter((file) => !file.startsWith('.') && IMAGE_EXT.has(extOf(file)))
      .sort((a, b) => {
        const ia = FRAME_INDEX.exec(a)?.[1]
        const ib = FRAME_INDEX.exec(b)?.[1]
        if (ia !== undefined && ib !== undefined && ia !== ib) return Number(ia) - Number(ib)
        return a < b ? -1 : a > b ? 1 : 0
      })
  } catch {
    return []
  }
}

/**
 * 一条轨道该播哪些帧。
 *
 * **有 `frames` 数组就用它**，这是 dsh-pet 的语义（`manifest-v2.ts`：显式列出帧名，
 * 省略才列目录），也是这份素材唯一的手工剪法（README 坑七：`build_video.py` 是按整条
 * 视频均匀抽帧的，每条轨首尾都挂着动作之外的站桩，`eat` 那条 38% 是死气）。坑三说
 * frames2d 没有 pingpong，所以吃饭那 13 帧在数组里是**手工展开成往返序列**的。
 *
 * 以前这里无条件列目录，等于把剪好的序列整份丢掉：`eat` 播回 13 帧线性（往返没了、
 * 死气回来了），`wave` 从还没起手的 f01 开始、末尾又多 7 帧站桩 —— 而点击分支的
 * `stateMs` 是按**剪后**的帧数配的，于是动作两头都切错位置。
 *
 * 数组里的条目必须是相对该轨道目录的纯文件名（带路径的、文件不存在的都丢掉并记一条
 * warning）；一条都留不下就退回列目录，别让整只宠物因为 manifest 写错而消失。
 */
function framesOf(trackDir, track, warnings, name) {
  const declared = track?.frames
  if (!Array.isArray(declared) || declared.length === 0) return listFrames(trackDir)
  const kept = []
  let dropped = 0
  for (const entry of declared) {
    const bad = typeof entry !== 'string' || entry === '' ||
      entry.includes('/') || entry.includes('\\') || !IMAGE_EXT.has(extOf(entry))
    if (bad || !existsSync(join(trackDir, entry))) {
      dropped += 1
      continue
    }
    kept.push(entry)
  }
  if (dropped > 0) {
    warnings.push('轨道 ' + name + ' 的 frames 里有 ' + dropped + ' 条被丢掉（不是纯文件名，或文件不存在）')
  }
  return kept.length > 0 ? kept : listFrames(trackDir)
}

function frameMsOf(file, index, track, defaultMs) {
  if (Array.isArray(track.frameMs)) {
    const explicit = track.frameMs[index]
    if (Number.isFinite(explicit)) return explicit
  }
  const hit = FILENAME_MS.exec(file)
  if (hit !== null) {
    const ms = Number(hit[1])
    if (Number.isInteger(ms) && ms >= 16 && ms <= 5000) return ms
  }
  return defaultMs
}

/**
 * 校验触摸分区。写坏了要**降级成"点她没反应"、不能抛**：路由那边是直接 `.find()`
 * 的，`zones` 不是数组就会每次点击都抛 TypeError（宿主兜成 400），点击功能整体失效
 * 且没有任何提示 —— 违反"降级要静默但可见"。
 *
 * 另外单独挡一种**静默失效**：分支的 `probability` 漏写/写成非数时，掷骰子那段的
 * `roll -= undefined` 会变 NaN，于是它**后面**的分支全部永远掷不到，而返回的是
 * `{hit:false}`，看着像"点到空白处了"。所以这里把坏分支挑出来记 warning。
 */
function readTouchZones(raw, warnings) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push('gameplay.touch.zones 不是数组，点击分区已全部丢弃')
    return []
  }
  const zones = []
  for (const zone of raw) {
    const label = zone !== null && typeof zone === 'object' && typeof zone.name === 'string' ? zone.name : '(无名)'
    if (zone === null || typeof zone !== 'object' ||
      !Number.isFinite(zone.y0) || !Number.isFinite(zone.y1) || zone.y1 <= zone.y0) {
      warnings.push('触摸分区 ' + label + ' 的 y0/y1 不合法，已丢弃')
      continue
    }
    const branches = []
    for (const branch of Array.isArray(zone.branches) ? zone.branches : []) {
      if (branch === null || typeof branch !== 'object' || typeof branch.state !== 'string' ||
        !Number.isFinite(branch.probability) || branch.probability <= 0) {
        warnings.push('触摸分区 ' + label + ' 里有一个分支缺 state 或 probability 不合法，已丢弃')
        continue
      }
      branches.push(branch)
    }
    if (branches.length === 0) {
      warnings.push('触摸分区 ' + label + ' 没有可用分支，已丢弃')
      continue
    }
    const sum = branches.reduce((total, branch) => total + branch.probability, 0)
    if (Math.abs(sum - 1) > 0.01) {
      warnings.push('触摸分区 ' + label + ' 的分支概率合计是 ' + sum.toFixed(3) + '（不是 1）：掷到区间外的部分永远不命中')
    }
    zones.push({ name: zone.name, y0: zone.y0, y1: zone.y1, branches })
  }
  return zones
}

/**
 * 读 `transitions.json`（native 专用扩展），两件事：
 *
 * 1. **保留键 `$phases`**：补/改相位映射。存在的理由是"同一条映射在 dsh-pet 那条路上写不得"——
 *    最典型的就是 `done`。它是**粘性相位**（一轮跑完就停在那儿直到下一条消息），而
 *    dsh-pet 客户端在点击动作释放时会 `trackForPhase(当前相位)` 重新解析一次
 *    （`setState(undefined)` → `play(target)`），所以把 `done` 映射到一次性动作，
 *    在那边就变成**每点她一次就重播一遍收碗**。README「坑一」那条规矩（done/failed
 *    只能映射 idle）就是为此。这里给它留一个口子，让 native 能做这件事、而 pet.json
 *    保持对 dsh-pet 完全合法。
 * 2. **其余键**：轨名 → `{目标轨: 权重}`，一次性动作播完之后按权重挑下一个动作
 *    （petpet 那套 —— 收碗 → 55% 摸头 / 10% 祝福 / 35% 待机）。只对非循环轨有意义，
 *    循环轨永远播不完、走不到那个分岔点。
 *
 * 键名一律带 `$` 前缀的是保留指令（轨道名走 `/^[a-z0-9][a-z0-9-]*$/`，撞不上）。
 * 容错按"配置坏了不该连累宠物"办：文件不在就静默跳过，读坏了/目标不存在只记 warning，
 * 权重非正数的条目直接丢。
 */
function applyExtensions(petDir, tracks, phases, warnings) {
  const file = join(petDir, TRANSITIONS_FILE)
  if (!existsSync(file)) return
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    warnings.push(TRANSITIONS_FILE + ' 读不出来，扩展没生效：' + (error && error.message ? error.message : String(error)))
    return
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(TRANSITIONS_FILE + ' 不是一个对象，已忽略')
    return
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$phases') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        warnings.push(TRANSITIONS_FILE + ' 的 $phases 不是「相位 → 轨名」对象，已忽略')
        continue
      }
      for (const [phase, track] of Object.entries(value)) {
        if (phase === 'idle') {
          // 待机轨是各处的兜底目标，改它牵一发动全身，不接。
          warnings.push(TRANSITIONS_FILE + ' 的 $phases 想改 idle，已忽略（那是兜底轨）')
          continue
        }
        if (typeof track !== 'string' || !Object.hasOwn(tracks, track)) {
          warnings.push(TRANSITIONS_FILE + ' 的 $phases 里 ' + phase + ' → «' + track + '» 没有这条轨道，已忽略')
          continue
        }
        phases[phase] = track
      }
      continue
    }
    if (!Object.hasOwn(tracks, key)) {
      warnings.push(TRANSITIONS_FILE + ' 里的 «' + key + '» 没有这条轨道，已忽略')
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(TRANSITIONS_FILE + ' 里 ' + key + ' 的值不是「目标轨 → 权重」对象，已忽略')
      continue
    }
    const next = {}
    for (const [to, weight] of Object.entries(value)) {
      if (!Object.hasOwn(tracks, to)) {
        warnings.push(TRANSITIONS_FILE + ' 里 ' + key + ' → «' + to + '» 没有这条轨道，已忽略')
        continue
      }
      if (!Number.isFinite(weight) || weight <= 0) continue
      next[to] = weight
    }
    if (Object.keys(next).length > 0) tracks[key].transitions = next
  }
}

/**
 * 解析包内的宠物定义。
 *
 * @param packageRoot 包根（含 pet/ 的那一层）
 * @returns 定义对象；读不出来返回 undefined（调用方降级、不抛）
 */
export function loadDefinition(packageRoot) {
  const petDir = join(packageRoot, 'pet')
  let raw
  try {
    raw = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf8'))
  } catch (error) {
    console.warn('[whalegirl-pet] 读不到 pet/pet.json：' + (error && error.message ? error.message : String(error)))
    return undefined
  }

  const frames2d = raw?.frames2d
  if (frames2d === undefined || frames2d.tracks === undefined) {
    console.warn('[whalegirl-pet] pet.json 里没有 frames2d.tracks，引擎只支持 frames2d')
    return undefined
  }

  const id = typeof raw.id === 'string' ? raw.id : 'whalegirl'
  const dir = typeof frames2d.dir === 'string' ? frames2d.dir : 'frames'
  const defaultMs = Number.isFinite(frames2d.defaultFrameMs) ? frames2d.defaultFrameMs : 83
  const phases = frames2d.phases ?? {}
  const idleTrack = typeof phases.idle === 'string' ? phases.idle : 'idle'

  // 无原型：轨道名是数据（可能被写坏/被替换），普通对象上 `tracks["toString"]`
  // 会取到原型上的函数、`tracks["__proto__"]` 更是拿到 Object.prototype ——
  // 一旦把它当轨道写属性，就污染整个进程。空原型表让这类名字查不到。
  const tracks = Object.create(null)
  const servable = new Set()
  const warnings = []

  for (const [name, track] of Object.entries(frames2d.tracks)) {
    const trackDir = join(petDir, dir, name)
    const files = framesOf(trackDir, track, warnings, name)
    if (files.length === 0) {
      // 整条轨道丢掉，但**不丢宠物** —— dsh-pet 也是这个取舍（只有 idle 轨为空才
      // fail-closed 丢整只）。
      warnings.push('轨道 ' + name + ' 没有可用帧，已丢弃')
      continue
    }
    const loop = track.loop !== false
    const frames = []
    const durations = []
    for (let i = 0; i < files.length; i += 1) {
      const rel = dir + '/' + name + '/' + files[i]
      frames.push(assetUrl(rel))
      durations.push(frameMsOf(files[i], i, track, defaultMs))
      servable.add(rel)
    }
    const entry = { frames, durations, loop }
    if (!loop) {
      const fallback = typeof track.fallback === 'string' ? track.fallback : undefined
      // 回落目标指向不存在的轨道时静默退回待机轨（照 dsh-pet 的取舍，不报错）。
      entry.fallback = fallback !== undefined && Object.hasOwn(frames2d.tracks, fallback) ? fallback : idleTrack
    }
    tracks[name] = entry
  }

  applyExtensions(petDir, tracks, phases, warnings)

  if (!Object.hasOwn(tracks, idleTrack)) {
    console.warn('[whalegirl-pet] 待机轨 ' + idleTrack + ' 不存在，宠物没法显示')
    return undefined
  }

  return {
    id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : id,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    petDir,
    dir,
    tracks,
    phases,
    idleTrack,
    touch: readTouchZones(raw?.gameplay?.touch?.zones, warnings),
    servable,
    imageCap: IMAGE_CAP,
    warnings,
  }
}

/**
 * 校验定义引用的帧在磁盘上都在。返回缺失清单（只在真正缺的时候喊，别每次启动都刷屏）。
 * 以前这套是给"释放到部署目录"兜底的；现在素材直接在包目录里，它还多一层用处：
 * **改完素材忘了同步 profile 里的副本**时能立刻看出来。
 */
export function missingFrames(definition) {
  const missing = []
  for (const [name, track] of Object.entries(definition.tracks)) {
    for (const url of track.frames) {
      const rel = url.slice(ASSET_PREFIX.length + 1)
      if (!existsSync(join(definition.petDir, rel))) missing.push(name + '/' + rel.split('/').pop())
    }
  }
  return missing
}
