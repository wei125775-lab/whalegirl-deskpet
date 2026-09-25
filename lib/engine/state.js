/**
 * 相位状态机。纯状态 + 纯读，**没有定时器**。
 *
 * 语义照抄 @linxin666/dsh-pet 的 src/state.ts（Apache-2.0，见包内 NOTICE），
 * 砍掉了我们用不到的部分（sprite2d 的 animation 行号、多会话、亲密度）。
 * 它那套设计里有两条最容易踩错的，这里原样保留：
 *
 * 1. **回落只改"该播什么"，不改 phase 本身。** done / failed 过了窗口之后播的是待机，
 *    但 phase 字段仍然是 done/failed —— 它只在收到新事件时才变。所以拿 phase 直接当
 *    "现在该播哪条轨"用会出错，必须走 track() 这个解析过的结果。
 *
 * 2. **没有定时器，靠读的时候现算。** 客户端每次轮询都拿到重新解析过的 track，窗口
 *    到点自然变待机。省掉定时器也就省掉了"定时器被后台标签页节流后不再触发"那类问题。
 */

/** done 之后庆祝多久再回待机（毫秒）。 */
export const CELEBRATE_MS = 2400

/** failed 之后显示多久再回待机（毫秒）。 */
export const FAILURE_MS = 2400

export class PetState {
  constructor({ celebrateMs = CELEBRATE_MS, failureMs = FAILURE_MS, now = Date.now } = {}) {
    this.celebrateMs = celebrateMs
    this.failureMs = failureMs
    this.now = now
    this.phase = 'idle'
    this.doneAt = undefined
    this.failedAt = undefined
    this.sessionActive = false
  }

  /** 收一个新相位。done/failed 的时间戳每次都重设（不是只在转换时设）。 */
  onPhase(phase) {
    this.phase = phase
    this.doneAt = phase === 'done' ? this.now() : undefined
    this.failedAt = phase === 'failed' ? this.now() : undefined
    this.sessionActive = phase !== 'idle'
  }

  /** 会话没了（dispose / 一轮被中断）：整个回到待机。 */
  onDispose() {
    this.sessionActive = false
    this.phase = 'idle'
    this.doneAt = undefined
    this.failedAt = undefined
  }

  /** done/failed 的显示窗口是否已过。 */
  settled() {
    const nowMs = this.now()
    if (this.phase === 'done' && this.doneAt !== undefined) return nowMs - this.doneAt >= this.celebrateMs
    if (this.phase === 'failed' && this.failedAt !== undefined) return nowMs - this.failedAt >= this.failureMs
    return this.phase === 'idle'
  }

  /**
   * 现在该播哪条轨道。
   * 这是给前端的唯一动画依据 —— 已经算进了回落窗口，前端不用自己判。
   */
  track(definition) {
    if (this.settled()) return definition.idleTrack
    const mapped = definition.phases[this.phase]
    return typeof mapped === 'string' && definition.tracks[mapped] !== undefined
      ? mapped
      : definition.idleTrack
  }

  /** 给前端的状态快照。 */
  view(definition) {
    return {
      phase: this.phase,
      track: this.track(definition),
      settled: this.settled(),
      sessionActive: this.sessionActive,
    }
  }
}
