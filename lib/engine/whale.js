/**
 * 「看鲸鱼」：有子代理在跑时，脚边游出一只小海豚。
 *
 * 和 legacy 那套（lib/legacy.js 里）比，这里**没有猴补丁**。legacy 必须把 dsh-pet 服务
 * 实例上的 `applyActivity` 包一层、在演出期间吞掉子代理会话的调用，否则子代理的
 * 工具事件会把相位打回去、鲸鱼每被打断一次就从第 0 帧重播。
 *
 * 新引擎里这个问题的**根源不存在**：相位管线是我们自己的，子代理事件从一开始就
 * 不进投影（见 engine/index.js 的路由），所以演出期间主相位天然不受影响，只需要
 * 演出本身把相位接管过去、结束后还回去。
 *
 * 触发判据仍用 `session.header.origin === 'subagent'`。0.1.7 的会话事件表里有
 * `subagent/descriptor` / `subagent/catalog`，但我在整个运行时里没找到发出它们的
 * 代码（只在类型声明和一处客户端事件名列表里出现），语义未验证，所以不拿它当依据。
 */

/** 演出期间若迟迟没有子代理事件，兜底收场（子代理异常退出、turn/end 丢了）。 */
const STALE_MS = 5 * 60 * 1000

function trackMs(track, fallbackMs) {
  if (track === undefined || track.frames.length === 0) return fallbackMs
  return track.durations.reduce((sum, ms) => sum + ms, 0)
}

/**
 * @param definition 宠物定义（用来算入场/退场时长）
 * @param state      相位状态机
 * @param restorePhase 演出结束后要还原的相位（读投影的当前主相位）
 */
export function createWhaleWatch({ definition, state, restorePhase, now = Date.now }) {
  const inMs = trackMs(definition.tracks['subagent-in'], 1577)
  const outMs = trackMs(definition.tracks['subagent-out'], 1411)

  const show = { state: 'off', active: new Set(), timer: undefined, lastSeen: 0 }

  const clearTimer = () => {
    if (show.timer !== undefined) {
      clearTimeout(show.timer)
      show.timer = undefined
    }
  }

  const begin = () => {
    clearTimer()
    show.state = 'in'
    show.lastSeen = now()
    state.onPhase('whale-in')
    show.timer = setTimeout(() => {
      if (show.state !== 'in') return
      show.state = 'loop'
      state.onPhase('whale-loop')
    }, inMs)
    if (typeof show.timer.unref === 'function') show.timer.unref()
  }

  const end = () => {
    clearTimer()
    show.state = 'out'
    state.onPhase('whale-out')
    show.timer = setTimeout(() => {
      show.state = 'off'
      show.active.clear()
      state.onPhase(restorePhase())
    }, outMs)
    if (typeof show.timer.unref === 'function') show.timer.unref()
  }

  return {
    /** 演出进行中吗（主相位此时应该冻结）。 */
    isShowing: () => show.state !== 'off',

    /** 一个子代理会话的事件。 */
    onSubagentEvent(session, event) {
      show.lastSeen = now()
      if (event?.type === 'turn/end') show.active.delete(session)
      else show.active.add(session)

      if (show.active.size === 0) {
        if (show.state !== 'off' && show.state !== 'out') end()
        return
      }
      if (show.state === 'off') begin()
    },

    /** 子代理会话被销毁。 */
    onDisposed(session) {
      if (!show.active.delete(session)) return
      if (show.active.size === 0 && show.state === 'loop') end()
    },

    /** 事件断流时的兜底扫描；由调用方挂在 ctx 生命周期上。 */
    sweep() {
      if (show.state === 'off' || show.state === 'out') return
      if (now() - show.lastSeen < STALE_MS) return
      show.active.clear()
      end()
    },

    /** 插件卸载时收尾。 */
    dispose() {
      clearTimer()
      show.state = 'off'
      show.active.clear()
    },
  }
}
