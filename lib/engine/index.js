/**
 * 自研引擎：只服务我们这一只宠物，不依赖 @linxin666/dsh-pet。
 *
 * 数据流：
 *   session/event（主会话）→ projection → PetState → /api/whalegirl/state
 *   session/event（子代理）→ whale watch（演出期间冻结主相位）
 *   帧图 → /whalegirl-pet/<rel>（白名单）
 *
 * 任何失败都只吞掉打日志、绝不抛 —— 插件树加载失败会让 dsh 整个起不来，
 * 这是这个包里反复强调过的底线。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, missingFrames } from './manifest.js'
import { PetState } from './state.js'
import { Projection } from './projection.js'
import { createWhaleWatch } from './whale.js'
import { loadPersist, savePersist } from './persist.js'
import { loadVoice, StatusVoice, WhisperEngine } from './voice.js'
import { makeRoutes } from './routes.js'

/** 数据根，优先级同 @deepseek-ai/dsh-home-paths（这里只认环境变量与默认值）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 挂载自研引擎。
 *
 * @param ctx          cordis 上下文
 * @param packageRoot  包根（含 pet/ 的那一层）
 */
export function applyEngine(ctx, packageRoot) {
  const definition = loadDefinition(packageRoot)
  if (definition === undefined) {
    console.warn('[whalegirl-pet] 宠物定义读不出来，引擎未启动')
    return
  }
  for (const warning of definition.warnings) console.warn('[whalegirl-pet] ' + warning)

  const missing = missingFrames(definition)
  if (missing.length > 0) {
    console.warn(
      '[whalegirl-pet] ⚠ ' + missing.length + ' 个引用帧在包内找不到，宠物会显示不全：' +
      missing.slice(0, 6).join(', ') + (missing.length > 6 ? ' …' : '') +
      '（改完素材要整份同步进 profile 里的副本，别只拷 pet.json）',
    )
  }

  const dshHome = resolveDshHome()
  let persist = loadPersist(dshHome)

  const state = new PetState()

  // 台词包。读坏 / 写坏都只出 warning（`voice.js` 里两层容错），最坏情况是她不说话。
  const voiceWarnings = []
  const voicePools = loadVoice(definition.petDir, voiceWarnings)
  for (const warning of voiceWarnings) console.warn('[whalegirl-pet] ' + warning)
  const voice = new StatusVoice(voicePools)
  const whispers = new WhisperEngine(voicePools)

  let whale
  // 演出期间冻结主相位**和台词**：鲸鱼在演，主会话的事件不该把它抢走（台词也一样，
  // 否则她一边演一边换词）。
  const projection = new Projection({
    voice,
    whispers,
    onPhase: (phase) => {
      if (whale !== undefined && whale.isShowing()) return
      state.onPhase(phase)
    },
    onSay: (line, whisper) => {
      if (whale !== undefined && whale.isShowing()) return
      state.onSay(line, whisper)
    },
    onClearWhisper: () => {
      if (whale !== undefined && whale.isShowing()) return
      state.clearWhisper()
    },
  })
  whale = createWhaleWatch({
    definition,
    state,
    restorePhase: () => projection.lastPhase,
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (session?.header?.origin === 'subagent') {
        whale.onSubagentEvent(session, event)
        return
      }
      projection.onSessionEvent(event)
    } catch (error) {
      console.warn('[whalegirl-pet] 处理会话事件出错：' + (error && error.message ? error.message : String(error)))
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      if (session?.header?.origin === 'subagent') {
        whale.onDisposed(session)
        return
      }
      projection.reset()
    } catch { /* 销毁路径上出错不该再抛 */ }
  })

  /**
   * 流式增量走的是**另一个发布**，不在 `session/event` 里 —— 这是 alpha.2 之后的形态，
   * 老的 `assistant/chunk` 事件已经退役。一个回合它会来几十上百次，所以
   * `onStreamFrame` 只认 reasoning / text 两种 delta，而且相位没变就不提交相位，
   * 不会把 `seq` 推着涨（推了的话她会把当前动作重播几十遍）。
   */
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const session = payload?.agent?.session
      if (session?.header?.origin === 'subagent') return
      projection.onStreamFrame(payload?.frame)
    } catch (error) {
      console.warn('[whalegirl-pet] 处理流式增量出错：' + (error && error.message ? error.message : String(error)))
    }
  })

  const sweep = setInterval(() => {
    try {
      whale.sweep()
    } catch (error) {
      // 别静默：这是"演出收不了场"唯一的逃生门，它自己失败时必须有痕迹，
      // 否则表现只是"她一直转圈、主相位被冻住"，而日志里一个字都没有。
      console.warn('[whalegirl-pet] 看鲸鱼的兜底扫描失败：' + (error && error.message ? error.message : String(error)))
    }
  }, 30000)
  if (typeof sweep.unref === 'function') sweep.unref()
  ctx.effect(() => () => clearInterval(sweep))

  const routes = makeRoutes({
    definition,
    voicePools,
    displayOf: () => persist.display,
    onDisplay: (next) => {
      persist = { display: next }
      savePersist(dshHome, persist)
    },
    stateOf: () => ({ ...state.view(definition), display: persist.display }),
  })

  ctx.effect(() => {
    const disposers = []
    try {
      for (const route of routes) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      // 中途抛错（宿主对重复的 kind+path 是 throw）：已注册的那几条要撤掉，
      // 否则留下"半挂载"—— /pet 在服务、/state 404，而日志只说"启动失败"。
      for (const dispose of disposers) {
        try { dispose() } catch { /* 收尾路径不抛 */ }
      }
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  ctx.effect(() => () => whale.dispose())

  const countLines = (pools) => Object.values(pools).reduce((total, pool) => total + pool.length, 0)
  const sayCount = countLines(voicePools.status) + countLines(voicePools.tools) +
    voicePools.toolRemaining.length + countLines(voicePools.whispers.categories) +
    countLines(voicePools.whispers.results)
  console.log(
    '[whalegirl-pet] 自研引擎已启动：' + definition.id + ' v' + String(definition.version) +
    '，' + Object.keys(definition.tracks).length + ' 条轨道，路由 ' + routes.length + ' 条' +
    '，台词 ' + sayCount + ' 条' + (sayCount === 0 ? '（voice.json 没读到，她不会说话）' : ''),
  )
}
