/**
 * 把 dsh 的会话事件投影成**相位**（驱动动画）和**台词**（驱动气泡）。
 *
 * 相位映射照抄 @linxin666/dsh-pet 的 `src/event-projection.ts`（Apache-2.0，见包内
 * NOTICE），去掉 voice / whispers / 经济系统那些分支；台词那半照抄同一个包的
 * `src/chatter.ts`。两个必须对齐的契约（写错了不报错、只是相位不对，很难查）：
 *
 * 1. **事件字段在 `event.data` 里，不在 `event` 上。** 是 `event.data.callId`，
 *    不是 `event.callId`。`tool/result` 的身份和成败还各在一处：`data.message.toolCallId`
 *    和 `data.message.isError`，另有 `data.error`。
 * 2. **`turn/end` 看的是 `data.reason.kind`**，七个取值：completed / aborted / blocked /
 *    error / max-tokens / interrupted / forked。
 *
 * 和它最大的不同：**改了提交策略**。它对 delta 事件零节流 —— 每个 text-delta 都跑完整
 * 链路，还要重排 Map、把状态机调两遍，长回答时是每 token 一次。我们的提交是
 * **"相位真的变了才提交相位"**：一个 token 一个 token 地吐文本时，phase 一直是 review，
 * 后续全部被挡掉。这比时间闸更好 —— 不引入延迟，而且相位转换本来就是稀疏事件。
 * done / failed 例外：同一个相位重复到达也允许提交，那是为了让庆祝窗口重新计时。
 *
 * ⚠️ **相位和台词是两条独立的提交路径，不能合流。** 相位提交会推进 `PetState.seq`，
 * 而 seq 是客户端"这是新的一次动作"的判据 —— 要是每来一个流式 delta 都走一遍相位提交，
 * seq 会一秒涨几十次，她会把当前动作从头重播几十遍。所以 `onSay` 只碰台词。
 *
 * 另一条：**phase ≠ scene**。`tool/result` 成功时 phase 是 thinking，台词场景却是
 * `toolResult`；`interrupted` / `max-tokens` 的 phase 都是 failed，台词场景不同。
 * 相位给动画用（改了就是回归），场景给台词用。
 */

import {
  displayToolName,
  looksLikeTestTool,
  toolArgHint,
  toolCategory,
  whisperCategoryOf,
} from './voice.js'

/** 相位取值。whale-* 三个是我们扩展的，dsh-pet 那边要靠改它的白名单才能用。 */
export const PHASES = [
  'idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed',
  'whale-in', 'whale-loop', 'whale-out',
]

export class Projection {
  /**
   * @param onPhase 相位变化时调用（会推进 seq，驱动动画）
   * @param onSay   台词变化时调用（只动气泡，不碰 seq）
   * @param voice   `StatusVoice`，不给就是"她从不出声"
   * @param whispers `WhisperEngine`
   */
  constructor({ onPhase, onSay, voice, whispers, now = Date.now } = {}) {
    this.onPhase = onPhase ?? (() => {})
    this.onSay = onSay ?? (() => {})
    this.voice = voice
    this.whispers = whispers
    this.now = now
    this.activeTools = new Set()
    /** 看着像测试的 callId；只有它出结果时才可能冒"过了"。 */
    this.testCallIds = new Set()
    this.stepHadFailure = false
    this.lastPhase = 'idle'
  }

  /** 状态场景的一句话；没有台词包时返回 undefined。 */
  scene(name, nowMs) {
    return this.voice === undefined ? undefined : this.voice.scene(name, nowMs)
  }

  whisperFeed(category, nowMs) {
    if (this.whispers === undefined) return undefined
    const text = this.whispers.feed(category, nowMs)
    return text === undefined ? undefined : { text, at: nowMs }
  }

  whisperResult(kind, nowMs) {
    if (this.whispers === undefined) return undefined
    const text = this.whispers.result(kind, nowMs)
    return text === undefined ? undefined : { text, at: nowMs }
  }

  /**
   * 相位走原判据提交，台词无条件送（去重交给 state —— 同一句话重复送不会推进气泡的 id）。
   *
   * **done / failed 例外：同一个相位重复到达也要重新提交。** `PetState.onPhase` 不只是
   * 记相位名，它还把 done/failed 的时间戳重设一次（庆祝窗口和失败窗口从这一刻重新计时）。
   * 少了这条例外，连续两次失败、或"失败之后按 Esc 打断"（两者的相位都是 failed）里的
   * 后一次就不会重设计时 —— 旧时间戳留在那儿，气泡会当场被判成"早该收起来了"而消失。
   */
  emit(hit) {
    if (hit.phase !== this.lastPhase || hit.phase === 'done' || hit.phase === 'failed') {
      this.lastPhase = hit.phase
      this.onPhase(hit.phase)
    }
    if (hit.line !== undefined || hit.whisper !== undefined) {
      this.onSay(hit.line, hit.whisper)
    }
  }

  /**
   * 处理一个**主会话**的 session 事件。
   * 子代理会话的事件不应该进这里 —— 调用方负责过滤，这样"子代理抢走显示"这个问题
   * 从根上不存在，不需要 dsh-pet 那套"演出期间吞掉子代理事件"的补丁。
   */
  onSessionEvent(event) {
    const hit = this.project(event)
    if (hit === undefined) return
    this.emit(hit)
  }

  /**
   * 处理一个 `agent/assistant-stream` 发布（alpha.2 之后流式增量走这里，不再是
   * `assistant/chunk` 事件）。一个回合里它会来几十上百次，所以只认两种 delta：
   * 推理增量让她保持"在想"，文本增量让她进入"在写"。start / end / 其他 chunk 什么都不改。
   *
   * 这里的提交**走 `emit` 的相位判据**：phase 不变就不提交相位，所以 seq 不会被推着涨。
   */
  onStreamFrame(frame) {
    if (frame === null || typeof frame !== 'object' || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return
    const now = this.now()
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text.length === 0) return
    if (chunk.type === 'reasoning-delta') {
      this.emit({
        phase: 'thinking',
        line: this.scene('thinking', now),
        whisper: this.whisperFeed('thinking', now),
      })
      return
    }
    if (chunk.type === 'text-delta') {
      this.emit({
        phase: 'review',
        line: this.scene('review', now),
        whisper: this.whisperFeed('writing', now),
      })
    }
  }

  /** 事件 → `{ phase, line?, whisper? }`；不认识的、或不该改变相位的事件返回 undefined。 */
  project(event) {
    const type = event?.type
    const data = event?.data ?? {}
    const now = this.now()
    switch (type) {
      case 'turn/start':
        this.activeTools.clear()
        this.testCallIds.clear()
        this.stepHadFailure = false
        return { phase: 'waiting', line: this.scene('prepare', now) }
      case 'step/start':
        this.activeTools.clear()
        this.stepHadFailure = false
        return { phase: 'waiting', line: this.scene('waiting', now) }
      case 'assistant/message':
        return { phase: 'review', line: this.scene('review', now) }
      case 'tool/call': {
        const callId = String(data.callId)
        const name = data.name
        this.activeTools.add(callId)
        // 记下"像测试"的调用：成败只有到 tool/result 才知道，那时才可能冒"过了"。
        if (looksLikeTestTool(name, data.arguments)) this.testCallIds.add(callId)
        return {
          phase: 'tool',
          line: this.voice === undefined
            ? undefined
            : this.voice.tool(name, displayToolName(name), toolArgHint(name, data.arguments), now),
          whisper: this.whisperFeed(whisperCategoryOf(toolCategory(name)), now),
        }
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = String(message.toolCallId)
        this.activeTools.delete(callId)
        const failed = data.error !== undefined || message.isError === true
        this.stepHadFailure = this.stepHadFailure || failed
        // 还有工具在跑就先报数，别急着报单次结果 —— 并行时这个提示更有用。
        if (this.activeTools.size > 0) {
          return {
            phase: 'tool',
            line: this.voice === undefined ? undefined : this.voice.remaining(this.activeTools.size, now),
          }
        }
        const wasTest = this.testCallIds.delete(callId)
        if (failed) {
          return { phase: 'failed', line: this.scene('toolFailed', now), whisper: this.whisperResult('fail', now) }
        }
        return {
          phase: 'thinking',
          line: this.scene('toolResult', now),
          whisper: wasTest ? this.whisperResult('pass', now) : undefined,
        }
      }
      case 'turn/end': {
        this.activeTools.clear()
        this.testCallIds.clear()
        switch (data.reason?.kind) {
          case 'completed':
            return { phase: 'done', line: this.scene('done', now), whisper: this.whisperResult('done', now) }
          case 'error':
            return { phase: 'failed', line: this.scene('failed', now), whisper: this.whisperResult('fail', now) }
          case 'max-tokens':
            return { phase: 'failed', line: this.scene('maxTokens', now) }
          case 'interrupted':
            return { phase: 'failed', line: this.scene('interrupted', now) }
          case 'blocked':
            return { phase: 'waiting', line: this.scene('blocked', now) }
          // aborted 与未知结尾（TurnEndReasonMap 是可扩展的）都安静收场：
          // 停掉的一轮不该把宠物留在"还在干活"的样子。
          case 'aborted':
            return { phase: 'idle' }
          default:
            return { phase: 'idle' }
        }
      }
      default:
        return undefined
    }
  }

  /** 会话销毁：相位归零、台词清空。 */
  reset() {
    this.activeTools.clear()
    this.testCallIds.clear()
    this.stepHadFailure = false
    this.lastPhase = 'idle'
    this.onPhase('idle')
    this.onSay(undefined, undefined)
  }
}
