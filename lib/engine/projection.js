/**
 * 把 dsh 的会话事件投影成相位。映射照抄 @linxin666/dsh-pet 的 src/event-projection.ts
 * （Apache-2.0，见包内 NOTICE），去掉 voice / whispers / 经济系统那些分支。
 *
 * 两个必须对齐的契约（写错了不报错、只是相位不对，很难查）：
 *
 * 1. **事件字段在 `event.data` 里，不在 `event` 上。** 是 `event.data.callId`，
 *    不是 `event.callId`。`tool/result` 的身份和成败还各在一处：`data.message.toolCallId`
 *    和 `data.message.isError`，另有 `data.error`。
 * 2. **`turn/end` 看的是 `data.reason.kind`**，七个取值：completed / aborted / blocked /
 *    error / max-tokens / interrupted / forked。
 *
 * 和它最大的不同：**改了提交策略**。它对 delta 事件零节流 —— 每个 text-delta 都跑完整
 * 链路，还要重排 Map、把状态机调两遍，长回答时是每 token 一次。我们的提交是
 * **"相位真的变了才提交"**：一个 token 一个 token 地吐文本时，phase 一直是 review，
 * 后续全部被挡掉。这比时间闸更好 —— 不引入延迟，而且相位转换本来就是稀疏事件。
 * done / failed 例外：同一个相位重复到达也允许提交，那是为了让庆祝窗口重新计时。
 */

/** 相位取值。whale-* 三个是我们扩展的，dsh-pet 那边要靠改它的白名单才能用。 */
export const PHASES = [
  'idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed',
  'whale-in', 'whale-loop', 'whale-out',
]

export class Projection {
  /**
   * @param commit 收到相位变化时的回调
   */
  constructor({ commit, now = Date.now } = {}) {
    this.commit = commit
    this.now = now
    this.activeTools = new Set()
    this.stepHadFailure = false
    this.lastPhase = 'idle'
  }

  /**
   * 处理一个**主会话**的 session 事件。
   * 子代理会话的事件不应该进这里 —— 调用方负责过滤，这样"子代理抢走显示"这个问题
   * 从根上不存在，不需要 dsh-pet 那套"演出期间吞掉子代理事件"的补丁。
   */
  onSessionEvent(event) {
    const phase = this.project(event)
    if (phase === undefined) return
    // 变化才提交。done/failed 例外，重复到达要重新计时。
    if (phase === this.lastPhase && phase !== 'done' && phase !== 'failed') return
    this.lastPhase = phase
    this.commit(phase)
  }

  /** 事件 → 相位；不认识的、或不该改变相位的事件返回 undefined。 */
  project(event) {
    const type = event?.type
    const data = event?.data ?? {}
    switch (type) {
      case 'turn/start':
        this.activeTools.clear()
        this.stepHadFailure = false
        return 'waiting'
      case 'step/start':
        this.activeTools.clear()
        this.stepHadFailure = false
        return 'waiting'
      case 'assistant/message':
        return 'review'
      case 'tool/call': {
        this.activeTools.add(String(data.callId))
        return 'tool'
      }
      case 'tool/result': {
        const message = data.message ?? {}
        this.activeTools.delete(String(message.toolCallId))
        const failed = data.error !== undefined || message.isError === true
        this.stepHadFailure = this.stepHadFailure || failed
        if (this.activeTools.size > 0) return 'tool'
        return this.stepHadFailure ? 'failed' : 'thinking'
      }
      case 'turn/end': {
        this.activeTools.clear()
        switch (data.reason?.kind) {
          case 'completed': return 'done'
          case 'error': return 'failed'
          case 'max-tokens': return 'failed'
          case 'interrupted': return 'failed'
          case 'blocked': return 'waiting'
          // aborted 与未知结尾（TurnEndReasonMap 是可扩展的）都安静收场：
          // 停掉的一轮不该把宠物留在"还在干活"的样子。
          case 'aborted': return 'idle'
          default: return 'idle'
        }
      }
      default:
        return undefined
    }
  }

  /** 会话销毁：相位归零。 */
  reset() {
    this.activeTools.clear()
    this.stepHadFailure = false
    this.lastPhase = 'idle'
    this.commit('idle')
  }
}
