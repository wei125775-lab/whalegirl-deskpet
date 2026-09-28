/**
 * 台词包（`pet/voice.json`）：加载、校验、选词、插值。
 *
 * 语义照抄 @linxin666/dsh-pet 的 `src/chatter.ts` + `src/voice-pack.ts`（Apache-2.0，
 * 见包内 NOTICE），和 `projection.js` / `state.js` / `manifest.js` 一个路子：只留这条
 * 链路用得到的部分。
 *
 * **和它最大的不同：它有一套内置文案池兜底，我们没有。** 所以某个池是空的就等于
 * "这个场景她不说话"，而不是回落到别的词 —— `voice.json` 是唯一来源。
 *
 * 容错分两层（照 voice-pack）：**结构 fail-closed**（根不是对象就整包当没有）、
 * **内容 warn-and-drop**（一行写坏只丢那一行）。写坏任何东西的最终后果都只是
 * "她少说几句"，不会连累宠物本身。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 同一个场景在这个窗口里复用同一句。流式 delta 每秒重发几十次同一个场景，逐次换词会让气泡闪成幻灯片。 */
const STATUS_ROTATE_MS = 4000

/** 碎碎念的两档冷却，共用同一个时间戳（和 dsh-pet 一致）。 */
const WHISPER_COOLDOWN_MS = 9000
const WHISPER_RESULT_COOLDOWN_MS = 5000

/** 碎碎念活多久，过了就回落到状态台词。 */
export const WHISPER_TTL_MS = 8000

/** 单行 / 单池上限，照 voice-pack 的校验。 */
const MAX_LINE = 160
const MAX_POOL = 64

/** 工具名和参数提示在气泡里的展示上限。 */
const TOOL_NAME_CAP = 24
const HINT_CAP = 28

/** 11 个状态场景（voice-pack 的键白名单）。 */
const STATUS_SCENES = [
  'prepare', 'waiting', 'thinking', 'review', 'toolResult', 'done',
  'failed', 'toolFailed', 'maxTokens', 'interrupted', 'blocked',
]

/** 17 个工具类别。 */
const TOOL_CATEGORIES = [
  'read', 'write', 'edit', 'shell', 'grep', 'find', 'ls', 'webSearch',
  'webFetch', 'mcp', 'memory', 'subagent', 'todo', 'browser', 'git', 'ask', 'generic',
]

/** 碎碎念的 10 个情境 + 3 种结果。 */
const WHISPER_CATEGORIES = [
  'thinking', 'writing', 'reading', 'editing', 'running',
  'searching', 'git', 'delegating', 'browsing', 'generic',
]
const WHISPER_RESULTS = ['pass', 'fail', 'done']

/** 占位符白名单：只有这几个块准用占位符，`status` / `whispers` 一个都不准。 */
const ALLOWED_PLACEHOLDERS = {
  tools: ['tool', 'hint'],
  toolRemaining: ['n'],
}

/** 空台词包。加载失败时用它，调用方不用到处判 undefined。 */
function emptyPools() {
  return { status: {}, tools: {}, toolRemaining: [], whispers: { categories: {}, results: {} } }
}

/**
 * 工具名 → 17 个类别之一。**正则顺序即优先级，首个命中就返回**（照抄 `toolCategory`）。
 *
 * 这个顺序是它那边调出来的，有三处反直觉但是对的，自己重排前先想清楚：
 * `mcp__x_search` 会先被 grep 命中（而不是 mcp）、`mcp__fs_read` 会先被 read 命中、
 * `TaskCreate` 里的 "task" 让它归 subagent（而不是 todo）。
 */
export function toolCategory(toolName) {
  const name = String(toolName ?? '').toLowerCase()
  if (/mem0|recall|memory/.test(name)) return 'memory'
  if (/subagent|workflow|ralph|agent|task/.test(name)) return 'subagent'
  if (/web_search|websearch|search_web|exa|brave|tavily/.test(name)) return 'webSearch'
  if (/fetch|browser|playwright|chrome/.test(name)) return 'webFetch'
  if (/grep|search|rg/.test(name)) return 'grep'
  if (/glob|find/.test(name)) return 'find'
  if (/^ls$|list_dir|list/.test(name)) return 'ls'
  if (/ask_user|ask/.test(name)) return 'ask'
  if (/todo|plan/.test(name)) return 'todo'
  if (/git/.test(name)) return 'git'
  if (/mcp__|mcp/.test(name)) return 'mcp'
  if (/read|open|load|describe|inspect/.test(name)) return 'read'
  if (/edit|patch|replace|rename/.test(name)) return 'edit'
  if (/write|create|save/.test(name)) return 'write'
  if (/run_code|bash|shell|terminal|exec|command|ssh/.test(name)) return 'shell'
  return 'generic'
}

/** 工具类别 → 碎碎念情境（`thinking` / `writing` 不经这里，由流式 delta 直接喂）。 */
export function whisperCategoryOf(tool) {
  switch (tool) {
    case 'read': case 'grep': case 'find': case 'ls': return 'reading'
    case 'write': case 'edit': return 'editing'
    case 'shell': return 'running'
    case 'webSearch': case 'webFetch': case 'memory': case 'mcp': return 'searching'
    case 'git': return 'git'
    case 'subagent': case 'todo': return 'delegating'
    case 'browser': return 'browsing'
    case 'ask': case 'generic': return 'generic'
    default: return 'generic'
  }
}

/**
 * 这次调用看着像在跑测试吗。
 *
 * **绝不读模型的正文**（讨论里提一句关键词不该触发情绪），只有真跑了测试类工具才算：
 * 所以投影在 tool/call 时用这个记下 callId，命中的那个工具出结果成"pass"。
 */
export function looksLikeTestTool(name, argumentsText) {
  const tool = String(name ?? '').toLowerCase()
  if (/(^|[/_.-])(test|tests|spec|vitest|jest|pytest|mocha|playwright|cypress|karma)([/_.-]|$)/.test(tool)) {
    return true
  }
  if (argumentsText === undefined) return false
  let haystack = String(argumentsText).toLowerCase()
  try {
    const parsed = JSON.parse(String(argumentsText))
    if (typeof parsed === 'object' && parsed !== null) {
      const command = parsed.command
      const code = parsed.code
      const picked = typeof command === 'string' && command !== ''
        ? command
        : typeof code === 'string' && code !== ''
          ? code
          : undefined
      if (picked !== undefined) haystack = picked.toLowerCase()
    }
  } catch { /* 解析不了就用原文 */ }
  return /\b(pnpm|npm|yarn|npx|bun|python)\s+(run\s+)?(tests?)\b/.test(haystack) ||
    /\b(pytest|vitest|jest|mocha|cypress|playwright|go test|cargo test)\b/.test(haystack)
}

/** `{tool}` 的取值：压掉空白，太长截断，空的话给个占位说法。 */
export function displayToolName(rawName) {
  const compact = String(rawName ?? '').replace(/\s+/g, ' ').trim()
  if (compact === '') return '工具'
  return compact.length <= TOOL_NAME_CAP ? compact : compact.slice(0, TOOL_NAME_CAP - 3) + '...'
}

/**
 * `{hint}` 的取值：这次调用到底碰了什么 —— 命令、路径、模式、查询词。
 *
 * 参数是 JSON 字符串，尽力解析，形状不认识就不给提示（不是错误）。read / write / edit
 * 只要 basename，免得整条长路径把气泡撑满。
 */
export function toolArgHint(toolName, argumentsJson) {
  let args
  try {
    args = JSON.parse(String(argumentsJson))
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const category = toolCategory(toolName)
  const keys = (() => {
    switch (category) {
      case 'shell': return ['command', 'code', 'cmd']
      case 'grep': return ['pattern', 'query', 'path']
      case 'find': return ['pattern', 'path', 'glob']
      case 'read': case 'write': case 'edit': return ['file_path', 'path', 'filePath', 'file']
      case 'webSearch': return ['query', 'q', 'keyword']
      case 'webFetch': case 'browser': return ['url', 'uri']
      case 'subagent': return ['description', 'label', 'prompt']
      case 'ls': return ['path', 'dir', 'directory']
      case 'git': return ['command', 'message']
      default: return ['command', 'query', 'path', 'file_path', 'description', 'title', 'name']
    }
  })()
  for (const key of keys) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const compact = value.replace(/\s+/g, ' ').trim()
    if (compact === '') continue
    const base = compact.split('/').pop() ?? compact
    const basenameOnly = category === 'read' || category === 'write' || category === 'edit'
    const shown = basenameOnly && base !== '' ? base : compact
    return shown.length <= HINT_CAP ? shown : shown.slice(0, HINT_CAP - 3) + '...'
  }
  return undefined
}

/** 把 `{xxx}` 换掉；没值的占位符换成空串（调用方负责给兜底值）。 */
export function interpolate(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_match, key) => {
    const value = vars[key]
    return typeof value === 'string' && value !== '' ? value : ''
  })
}

/**
 * 一行台词的校验与规整。返回 undefined 表示"这行不要了"。
 *
 * 含白名单外的占位符**整行丢弃**（照 voice-pack 的 warn-and-drop）。另外两个细节：
 * 落单的 `{` 也算写坏；超长截断后不能留下半个 `{hint` —— 那会渲染成一个裸的 `{`。
 */
function normalizeLine(raw, allowed) {
  let line = String(raw).replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  for (const hit of line.matchAll(/\{([^}]*)\}/g)) {
    if (!allowed.includes(hit[1])) return undefined
  }
  if (line.replace(/\{[^}]*\}/g, '').includes('{')) return undefined
  if (line.length > MAX_LINE) {
    line = line.slice(0, MAX_LINE)
    const open = line.lastIndexOf('{')
    if (open >= 0 && line.indexOf('}', open) < 0) line = line.slice(0, open).trimEnd()
  }
  return line
}

function normalizePool(raw, allowed, warnings, where) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push(where + ' 不是数组，已忽略')
    return []
  }
  const pool = []
  let dropped = 0
  for (const entry of raw.slice(0, MAX_POOL)) {
    if (typeof entry !== 'string') { dropped += 1; continue }
    const line = normalizeLine(entry, allowed)
    if (line === undefined || line === '') { dropped += 1; continue }
    pool.push(line)
  }
  if (raw.length > MAX_POOL) {
    warnings.push(where + ' 超过 ' + MAX_POOL + ' 条，多的已丢掉')
  }
  if (dropped > 0) {
    warnings.push(where + ' 里有 ' + dropped + ' 行被丢掉（含不允许的占位符，或写坏了）')
  }
  return pool
}

/** `status` / `tools` / `whispers` 这类「键 → 池」的块。认不出的键只记 warning、不致命。 */
function normalizeKeyedPools(raw, allowedKeys, placeholders, warnings, where) {
  const out = {}
  if (raw === undefined) return out
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(where + ' 不是一个对象，已忽略')
    return out
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.includes(key)) {
      warnings.push(where + ' 里的 «' + key + '» 不是认得的键，已忽略')
      continue
    }
    const pool = normalizePool(value, placeholders, warnings, where + '.' + key)
    // 显式空数组是**静音**这个键，保留它（和 dsh-pet 一致）。
    if (Array.isArray(value)) out[key] = pool
  }
  return out
}

/**
 * 读 `pet/voice.json`。读不出来 / 结构不对都返回空包（不抛）。
 *
 * @param petDir 宠物目录（含 `pet.json` 的那一层）
 * @param warnings 调用方的告警数组，和 `loadDefinition` 合用一条出口
 */
export function loadVoice(petDir, warnings) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(petDir, 'voice.json'), 'utf8'))
  } catch (error) {
    warnings.push('voice.json 读不出来，她这一轮不说话：' + (error && error.message ? error.message : String(error)))
    return emptyPools()
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('voice.json 根不是一个对象，整包忽略')
    return emptyPools()
  }
  return {
    status: normalizeKeyedPools(raw.status, STATUS_SCENES, [], warnings, 'status'),
    tools: normalizeKeyedPools(raw.tools, TOOL_CATEGORIES, ALLOWED_PLACEHOLDERS.tools, warnings, 'tools'),
    toolRemaining: normalizePool(raw.toolRemaining, ALLOWED_PLACEHOLDERS.toolRemaining, warnings, 'toolRemaining'),
    whispers: {
      categories: normalizeKeyedPools(raw.whispers?.categories, WHISPER_CATEGORIES, [], warnings, 'whispers.categories'),
      results: normalizeKeyedPools(raw.whispers?.results, WHISPER_RESULTS, [], warnings, 'whispers.results'),
    },
  }
}

/**
 * 状态台词的轮转选词。
 *
 * 关键那条：**同一场景在 4 秒内复用同一句**。流式 chunk 每秒重发几十次同一个相位，
 * 每个 chunk 都换词的话气泡会闪。场景一换立刻换词，计数器跨场景共享、不清零。
 */
export class StatusVoice {
  constructor(pools, rotateMs = STATUS_ROTATE_MS) {
    this.pools = pools
    this.rotateMs = rotateMs
    this.counters = new Map()
    this.lastScene = ''
    this.lastLine = ''
    this.lastLineAt = Number.NEGATIVE_INFINITY
  }

  /** 池空 = 这个场景她不说话（我们没有内置池兜底）。 */
  scene(name, nowMs) {
    const pool = this.pools.status[name]
    if (!Array.isArray(pool) || pool.length === 0) return undefined
    const key = 'scene:' + name
    if (key === this.lastScene && nowMs - this.lastLineAt < this.rotateMs) return this.lastLine
    const index = (this.counters.get(key) ?? 0) % pool.length
    this.counters.set(key, index + 1)
    this.lastScene = key
    this.lastLine = pool[index]
    this.lastLineAt = nowMs
    return this.lastLine
  }

  /**
   * 工具调用那一句。`{hint}` 没解析出来时回落成工具名 —— 池子里很多行是
   * 「读一读 {hint}」，缺值变成「读一读 」比「读一读 Read」难看得多。
   */
  tool(toolName, displayName, hint, nowMs) {
    const category = toolCategory(toolName)
    const pool = this.pools.tools[category]
    if (!Array.isArray(pool) || pool.length === 0) return undefined
    const key = 'tool:' + category
    // 4 秒闸复用同一句**模板**，但每次都用当前参数重新插值。
    //
    // 这里曾经缓存的是插值**结果**：一条 assistant 消息里并行调三个工具时（同时 Read
    // 三个文件就是典型），后两个被这道闸挡住，直接返回上一次那句 —— 气泡整个并行段都
    // 停在第一个文件名上，后面的一个都不出现。参考实现缓存的是模板、`.replaceAll` 在
    // 返回之后做，所以上游没有这个现象。
    if (key !== this.lastScene || nowMs - this.lastLineAt >= this.rotateMs) {
      const index = (this.counters.get(key) ?? 0) % pool.length
      this.counters.set(key, index + 1)
      this.lastScene = key
      this.lastLine = pool[index]
      this.lastLineAt = nowMs
    }
    return interpolate(this.lastLine, { tool: displayName, hint: hint ?? displayName })
  }

  /** 还有几个工具在并行跑。 */
  remaining(count, nowMs) {
    const pool = this.pools.toolRemaining
    if (!Array.isArray(pool) || pool.length === 0) return undefined
    const index = (this.counters.get('remaining') ?? 0) % pool.length
    this.counters.set('remaining', index + 1)
    this.lastScene = 'remaining'
    // 存模板、和 `scene()` / `tool()` 一致（`lastLine` 的语义统一成"模板"）。
    this.lastLine = pool[index]
    this.lastLineAt = nowMs
    return interpolate(this.lastLine, { n: String(count) })
  }
}

/**
 * 碎碎念。两档冷却共用同一个时间戳（照 dsh-pet），所以刚说完一句情境话，
 * 紧接着的工具结果不会立刻又冒一句。
 */
export class WhisperEngine {
  constructor(pools, categoryCooldownMs = WHISPER_COOLDOWN_MS, resultCooldownMs = WHISPER_RESULT_COOLDOWN_MS) {
    this.pools = pools
    this.categoryCooldownMs = categoryCooldownMs
    this.resultCooldownMs = resultCooldownMs
    this.categoryCursor = new Map()
    this.resultCursor = new Map()
    this.lastWhisperAt = Number.NEGATIVE_INFINITY
  }

  /** 情境话（正在读 / 正在跑 / 正在搜…）。冷却内或该键被静音就返回 undefined。 */
  feed(category, nowMs) {
    if (nowMs - this.lastWhisperAt < this.categoryCooldownMs) return undefined
    const pool = this.pools.whispers.categories[category]
    if (!Array.isArray(pool) || pool.length === 0) return undefined
    const index = (this.categoryCursor.get(category) ?? 0) % pool.length
    this.categoryCursor.set(category, index + 1)
    return this.speak(pool[index], nowMs)
  }

  /** 结果话（测试过了 / 这步没过 / 完事）。冷却更短，情绪该被听见。 */
  result(kind, nowMs) {
    if (nowMs - this.lastWhisperAt < this.resultCooldownMs) return undefined
    const pool = this.pools.whispers.results[kind]
    if (!Array.isArray(pool) || pool.length === 0) return undefined
    const index = (this.resultCursor.get(kind) ?? 0) % pool.length
    this.resultCursor.set(kind, index + 1)
    return this.speak(pool[index], nowMs)
  }

  speak(line, nowMs) {
    this.lastWhisperAt = nowMs
    return line
  }
}
