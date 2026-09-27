/**
 * 相位状态机 + 当前该说的那句话。纯状态，**没有定时器**。
 *
 * 相位那半的语义照抄 @linxin666/dsh-pet 的 `src/state.ts`（Apache-2.0，见包内 NOTICE），
 * 砍掉了我们用不到的部分（sprite2d 的 animation 行号、多会话、亲密度）。它那套设计里
 * 有两条最容易踩错的，这里原样保留：
 *
 * 1. **回落只改"该播什么"，不改 phase 本身。** done / failed 过了窗口之后播的是待机，
 *    但 phase 字段仍然是 done/failed —— 它只在收到新事件时才变。所以拿 phase 直接当
 *    "现在该播哪条轨"用会出错，必须走 track() 这个解析过的结果。
 *
 * 2. **没有定时器，靠读的时候现算。** 客户端每次轮询都拿到重新解析过的 track，窗口
 *    到点自然变待机。省掉定时器也就省掉了"定时器被后台标签页节流后不再触发"那类问题。
 *
 * 台词那半（`say`）是同一条思路：碎碎念有 8 秒存活期，也是 `view()` 时现算 ——
 * 过期了就不带它，客户端下一次轮询自然回落到状态台词，同样不需要定时器。
 */

import { WHISPER_TTL_MS } from './voice.js'

/** done 之后气泡还挂多久（毫秒）。**动作不再用它回落** —— 见 `settled()`。 */
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
    /** 相位序号：每收一个新相位 +1。前端拿它当"这是新的一次"的判据（见 view）。 */
    this.seq = 0
    /** 当前状态台词（相位/工具事件选出来的那句）。 */
    this.line = undefined
    /** 当前碎碎念，`{ text, at }`；at 是它被说出来的时刻，用于 8 秒存活期。 */
    this.whisper = undefined
    /** 台词序号：**"该显示的那句话"变了** 才 +1，客户端拿它判"要不要重播入场动画"。 */
    this.saySeq = 0
    this.shownText = undefined
  }

  /** 收一个新相位。done/failed 的时间戳每次都重设（不是只在转换时设）。 */
  onPhase(phase) {
    this.phase = phase
    this.doneAt = phase === 'done' ? this.now() : undefined
    this.failedAt = phase === 'failed' ? this.now() : undefined
    this.sessionActive = phase !== 'idle'
    this.seq += 1
  }

  /**
   * 收一句台词。**这里刻意不推进 `seq`** —— 那是相位的序号，而且流式 delta 每秒会
   * 送来几十次同一句话，推进它会让她把当前动作从头重播几十遍。
   * 话本身变了才记账（`saySeq` 在 view 里按"最终显示出来的那句"推进）。
   *
   * `whisper` 只在**有新碎碎念**时才覆盖，`undefined` 表示"这次没有新的"，已有的那句
   * 继续顶着直到 8 秒到期 —— 照 dsh-pet 的语义（它那边是 `session.whisper ?? session.bubble`，
   * 碎碎念是"临时接管"气泡，不是被状态句一冲就没了）。
   */
  onSay(line, whisper) {
    this.line = line
    if (whisper !== undefined) this.whisper = whisper
  }

  /** 会话没了（dispose / 一轮被中断）：整个回到待机。 */
  onDispose() {
    this.sessionActive = false
    this.phase = 'idle'
    this.doneAt = undefined
    this.failedAt = undefined
    this.line = undefined
    this.whisper = undefined
    this.seq += 1
  }

  /**
   * 动作该不该回待机了。
   *
   * **done 不在这个判据里**（它原来是"庆祝满 2.4 秒就回待机"）。因为我们的 done 映射到
   * 收碗，而收碗之后还有一条动作链（55% 托腮 / 10% 祝福 / 35% 待机）—— 整条走完要三秒
   * 出头。2.4 秒一到就被强制切回待机，托腮会播到一半断掉，这就是"干完那一下特别跳"。
   * 现在 done 之后不回待机，交给动作链自己收敛（转到待机轨、或一直托腮等下一轮），
   * 跟 PetPet 版一致。
   */
  settled() {
    const nowMs = this.now()
    if (this.phase === 'failed' && this.failedAt !== undefined) return nowMs - this.failedAt >= this.failureMs
    return this.phase === 'idle'
  }

  /**
   * 气泡该不该收 —— 和动作回落分开判。
   *
   * done 之后动作会接着演（托腮能待很久），但**话不能一直挂着**：说完"搞定啦。"
   * 就该安静下来。所以这里保留了原来的 2.4 秒窗口。
   */
  sayQuiet() {
    const nowMs = this.now()
    if (this.phase === 'idle') return true
    if (this.phase === 'done' && this.doneAt !== undefined) return nowMs - this.doneAt >= this.celebrateMs
    if (this.phase === 'failed' && this.failedAt !== undefined) return nowMs - this.failedAt >= this.failureMs
    return false
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

  /**
   * 给前端的状态快照。
   *
   * `seq` 是给前端"新的一次动作"用的判据，**不能只看 phase 字符串**：done/failed
   * 允许重复提交（重新计时），而相位名不变时前端那道"同一相位只播一次"的闸会把
   * 第二次的动作（比如第二次收碗）直接吞掉。实测触发条件是客户端错过了中间那些
   * 相位 —— 窗口最小化时它本来就不轮询。
   *
   * `say` 是气泡要显示的那句话（`null` = 不说话）。碎碎念没出 8 秒就优先它，
   * 过了就回落到状态台词 —— 回落在这一步发生，所以不需要任何定时器。
   *
   * **这里会写一个字段（`shownText` / `saySeq`）**，是全文件唯一的"读时更新"。
   * 它是幂等的（同样的话重复读不会推序号），代价只是不再字面意义上的"纯读"；
   * 换来的是客户端只要比较 `say.id` 就能判"要不要重播动画"，不用自己去比文本
   * （比文本的写法在"同一句话隔了几轮又出现"时会漏掉一次重播）。
   */
  view(definition) {
    const nowMs = this.now()
    const settled = this.settled()
    const quiet = this.sayQuiet()
    const fresh = this.whisper !== undefined && nowMs - this.whisper.at < WHISPER_TTL_MS
    const text = fresh ? this.whisper.text : this.line
    const kind = fresh ? 'whisper' : 'status'
    const shown = text === undefined || quiet ? undefined : text
    if (shown !== this.shownText) {
      this.shownText = shown
      this.saySeq += 1
    }
    return {
      phase: this.phase,
      track: this.track(definition),
      settled,
      sessionActive: this.sessionActive,
      seq: this.seq,
      say: shown === undefined ? null : { id: this.saySeq, text: shown, kind },
    }
  }
}
