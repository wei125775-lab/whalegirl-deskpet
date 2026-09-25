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

/** 列一个轨道目录里的图，按尾部数字自然排序。 */
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

  const tracks = {}
  const servable = new Set()
  const warnings = []

  for (const [name, track] of Object.entries(frames2d.tracks)) {
    const trackDir = join(petDir, dir, name)
    const files = listFrames(trackDir)
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
      entry.fallback = fallback !== undefined && frames2d.tracks[fallback] !== undefined ? fallback : idleTrack
    }
    tracks[name] = entry
  }

  if (tracks[idleTrack] === undefined) {
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
    touch: raw?.gameplay?.touch?.zones ?? [],
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
