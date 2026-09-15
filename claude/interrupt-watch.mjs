// 盯 Claude Code 的会话 transcript，检测"用户按 Esc 打断"，写进桌宠的状态文件。
//
// 为什么需要它：官方没有任何 hook 在打断时触发——文档对 Stop 写得很明确
// （"Does not run if the stoppage occurred due to a user interrupt"），也没有
// Interrupt / TurnCancelled 这类事件，StopFailure 只管 API 错误（github issue #71652/#70370/#9516）。
// 所以"被打断"这个事实只能从 transcript 里读出来：
//     {"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]},
//      "interruptedMessageId":"<被打断那条 assistant 消息的 uuid>", ...}
// 用 `interruptedMessageId` 有值来判定最稳（比匹配提示文案稳，且它是新增的一层）。
//
// 两个已知坑：
//   1. transcript 是异步落盘的，别指望打断那一瞬间就读到——所以这里用轮询，允许 1 秒级延迟。
//   2. 格式没有官方背书，是内部写盘行为，字段名/文案都可能变；变了这个脚本会静默失效
//      （只会不触发，不会报错），日志里能看出来。
//
// 启动时记基线：先扫一遍现有 transcript，把已有的打断标记记为"已见过"——否则每开一次
// watcher 都会把历史打断当成新事件重放一次。
//
// 用法：node interrupt-watch.mjs            （常驻，由 SessionStart 钩子拉起）
//       CLAUDE_PROJECTS=<临时目录> INTERRUPT_WATCH_ONESHOT=1 node interrupt-watch.mjs   （自测）
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PROJECTS = process.env.CLAUDE_PROJECTS || join(homedir(), '.claude', 'projects')
const PET_DIR = process.env.PET_DIR || join(homedir(), '.petpet')
const STATE = process.env.PETPET_STATE || join(PET_DIR, 'state.json')
const LOG = join(PET_DIR, 'interrupt-watch.log')
const PIDFILE = join(PET_DIR, 'interrupt-watch.pid')
const ONESHOT = process.env.INTERRUPT_WATCH_ONESHOT === '1'
const POLL_MS = 1000
const FULL_SCAN_MS = 15000    // 全量扫 mtime 的间隔；中间只盯"最近动过"的文件
const HOT_WINDOW_MS = 300000  // 多久算"最近动过"
const TAIL_BYTES = 131072     // 每次只看文件尾部这么多（一条记录一行，够覆盖一轮了）

const log = (msg) => {
  try {
    mkdirSync(PET_DIR, { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

/** 读文件尾部若干字节并按行切（丢掉可能被截断的第一行）。 */
function tailLines(path) {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_BYTES)
  const len = size - start
  if (len <= 0) return []
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  if (start > 0) lines.shift()      // 首行可能是半截
  return lines.filter(Boolean)
}

/** 从若干行里挑出"打断"记录，返回它们的 uuid（用 interruptedMessageId 的值指代）。 */
function interruptIds(lines) {
  const out = []
  for (const line of lines) {
    if (!line.includes('interruptedMessageId')) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const id = d.interruptedMessageId
    if (typeof id === 'string' && id !== '') out.push(id)
  }
  return out
}

const seen = new Set()
const hot = new Map()          // path -> mtimeMs
let lastFullScan = 0

function collectCandidates(force) {
  const now = Date.now()
  if (!force && now - lastFullScan < FULL_SCAN_MS) return
  lastFullScan = now
  let dirs = []
  try {
    dirs = readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch (e) {
    log(`读不到 ${PROJECTS}：${e.message}`)
    return
  }
  const fresh = new Map()
  for (const d of dirs) {
    const dir = join(PROJECTS, d.name)
    let files = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(dir, f)
      try {
        const st = statSync(p)
        if (now - st.mtimeMs <= HOT_WINDOW_MS) fresh.set(p, st.mtimeMs)
      } catch {}
    }
  }
  hot.clear()
  for (const [p, m] of fresh) hot.set(p, m)
  if (force) log(`基线扫描：${dirs.length} 个目录，热文件 ${hot.size} 个，已记录打断 ${seen.size} 条`)
}

function handleNewInterrupt(id) {
  if (seen.has(id)) return
  seen.add(id)
  try {
    writeFileSync(STATE, JSON.stringify({ state: 'interrupted', ts: Date.now() }))
    log(`检测到打断 ${id}，已把桌宠状态写成 interrupted`)
  } catch (e) {
    log(`写状态文件失败：${e.message}`)
  }
}

function poll() {
  // 已见过的先跑一遍（启动基线）
  collectCandidates(false)
  for (const [path, mtime] of [...hot]) {
    let st
    try {
      st = statSync(path)
    } catch {
      hot.delete(path)
      continue
    }
    if (st.mtimeMs === mtime) continue
    hot.set(path, st.mtimeMs)
    let ids = []
    try {
      ids = interruptIds(tailLines(path))
    } catch (e) {
      log(`读 ${path} 失败：${e.message}`)
      continue
    }
    for (const id of ids) handleNewInterrupt(id)
  }
}

// 单实例：pid 文件里那个进程还在就直接退出（SessionStart 每次开 Claude 都会拉起我们）
try {
  if (!ONESHOT && existsSync(PIDFILE)) {
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)     // 不抛就是还活着
        process.exit(0)
      } catch {}
    }
  }
  mkdirSync(PET_DIR, { recursive: true })
  writeFileSync(PIDFILE, String(process.pid))
} catch (e) {
  log(`pid 文件处理失败：${e.message}`)
}

// 基线：把现有 transcript 里的打断标记先记下来，别把历史事件当新事件重放
collectCandidates(true)
for (const [path] of [...hot]) {
  try {
    for (const id of interruptIds(tailLines(path))) seen.add(id)
  } catch {}
}
log(`watcher 启动 pid=${process.pid}，基线打断 ${seen.size} 条，盯 ${PROJECTS}`)

if (ONESHOT) {
  poll()
  log('oneshot 模式：跑完一轮就退出')
  process.exit(0)
}

setInterval(poll, POLL_MS)
poll()
