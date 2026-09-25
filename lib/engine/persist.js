/**
 * 位置 / 大小 / 显示与否的持久化，写 `$DSH_HOME/whalegirl-pet.json`。
 *
 * 独立文件，不复用 dsh-pet 的 `$DSH_HOME/pet.json` —— 那是它的字段结构（还有亲密度、
 * 零食、每宠皮肤、每宠玩法数据），我们只存一个 display 块，混在一起将来两边都会别扭。
 *
 * 两条照抄 dsh-pet 的原则：
 * - **读侧整段 try/catch，任何异常（文件缺失、JSON 坏、字段类型错）都回默认值**，
 *   绝不因为一个坏配置文件让宠物起不来。
 * - **轮询永不触发写盘**。只有真的改配置（拖动结束、显示开关）才写，靠调用点自己控制，
 *   不做定时刷写。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FILE_NAME = 'whalegirl-pet.json'

const SIZE_MIN = 64
const SIZE_MAX = 512
const INSET_MAX = 4096

export const DEFAULT_DISPLAY = { visible: true, size: 160, right: 24, bottom: 20 }

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback)

/** 消毒一个来自磁盘或前端的 display 块。所有字段都可能缺失或类型不对。 */
export function sanitizeDisplay(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const base = DEFAULT_DISPLAY
  return {
    visible: typeof source.visible === 'boolean' ? source.visible : base.visible,
    size: Math.round(clamp(finite(source.size, base.size), SIZE_MIN, SIZE_MAX)),
    right: Math.round(clamp(finite(source.right, base.right), 0, INSET_MAX)),
    bottom: Math.round(clamp(finite(source.bottom, base.bottom), 0, INSET_MAX)),
  }
}

/** 读；文件不在或坏了都回默认。 */
export function loadPersist(dshHome) {
  try {
    const raw = JSON.parse(readFileSync(join(dshHome, FILE_NAME), 'utf8'))
    return { display: sanitizeDisplay(raw?.display) }
  } catch {
    return { display: { ...DEFAULT_DISPLAY } }
  }
}

/** 原子写（先写临时文件再改名），失败只警告不抛 —— 存不下位置不该影响宠物本身。 */
export function savePersist(dshHome, data) {
  try {
    mkdirSync(dshHome, { recursive: true })
    const target = join(dshHome, FILE_NAME)
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, target)
    return true
  } catch (error) {
    console.warn('[whalegirl-pet] 保存位置失败：' + (error && error.message ? error.message : String(error)))
    return false
  }
}
