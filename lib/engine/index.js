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
  let whale
  // 演出期间冻结主相位：鲸鱼在演，主会话的事件不该把它抢走。
  const projection = new Projection({
    commit: (phase) => {
      if (whale !== undefined && whale.isShowing()) return
      state.onPhase(phase)
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

  const sweep = setInterval(() => {
    try {
      whale.sweep()
    } catch { /* 兜底扫描出错就等下一轮 */ }
  }, 30000)
  if (typeof sweep.unref === 'function') sweep.unref()
  ctx.effect(() => () => clearInterval(sweep))

  const routes = makeRoutes({
    definition,
    displayOf: () => persist.display,
    onDisplay: (next) => {
      persist = { display: next }
      savePersist(dshHome, persist)
    },
    stateOf: () => ({ ...state.view(definition), display: persist.display }),
  })

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  ctx.effect(() => () => whale.dispose())

  console.log(
    '[whalegirl-pet] 自研引擎已启动：' + definition.id + ' v' + String(definition.version) +
    '，' + Object.keys(definition.tracks).length + ' 条轨道，路由 ' + routes.length + ' 条',
  )
}
