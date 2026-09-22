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
const hot = new Map()          // path -> 上次**读过**时的 mtimeMs（不是文件当前 mtime）
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
  // 这一步是**合并**，不能推倒重建。原来 `hot.clear()` 之后把所有当前 mtime 记成新基线：
  // 那些"上次扫完之后、这次扫之前"的写入就被当成已经读过了，尾巴再也不看——正撞上最典型的
  // 用法：任务静默超过 5 分钟（不在热窗口里、早就被清出 hot），然后按 Esc 打断，这一条恰好
  // 落在两轮全量扫描之间，于是打断记录 100% 被吞，她永远不进 interrupted。
  // 现在：已记录的文件保留它们**上次读过**的 mtime（于是照样会被判为"变了"、读一次尾巴）；
  // 消失的删掉；新见到的先记 0——下一轮必然读一次尾巴（重复读没关系，`seen` 会去重）。
  // force（启动基线）例外：后面马上会把所有尾巴读一遍记进 seen，所以直接记真实 mtime，免得白读第二轮。
  for (const [p, m] of fresh) {
    if (force) hot.set(p, m)
    else if (!hot.has(p)) hot.set(p, 0)
  }
  for (const p of [...hot.keys()]) if (!fresh.has(p)) hot.delete(p)
  if (force) log(`基线扫描：${dirs.length} 个目录，热文件 ${hot.size} 个，已记录打断 ${seen.size} 条`)
}

function handleNewInterrupt(id) {
  if (seen.has(id)) return
  seen.add(id)
  // transcript 落盘是异步的，我们可能比 UserPromptSubmit 的 hook 晚读到上一轮的打断。
  // 这时 state.json 里已经躺着一条更新的 working，再拿 interrupted 盖上去，她下一轮明明
  // 在干活却一直打断脸——而且 statusline 也读这个文件，会跟着一起错。2 秒内的新写入让位。
  try {
    const prev = JSON.parse(readFileSync(STATE, 'utf8'))
    if (prev && typeof prev.ts === 'number' && Date.now() - prev.ts < 2000) {
      log(`打断 ${id} 晚到了（state.json ${Date.now() - prev.ts}ms 前刚写过 ${prev.state}），不覆盖`)
      return
    }
  } catch { /* 没有/坏文件：照常写 */ }
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

// ── 单实例：靠"pid + 心跳"的锁文件，不能只看 pid 还活着 ──────────────────
// 两个真实故障都出在"只验 pid 存活"上：
//   ① watcher 被强杀（关终端、任务管理器结束）留下 pid 文件，而 Windows 会复用 pid ——
//      后来每次 SessionStart 拉起的 watcher 都发现"那个 pid 活着"，于是立刻自杀。
//      结果是打断检测**永久静默失效**，还不报错。
//   ② ONESHOT 自测（INTERRUPT_WATCH_ONESHOT=1）跑一轮就把在跑实例的 pid 文件覆盖掉了，
//      正常的那个从此没人认领，下次再拉起一个，两个一起写 state.json。
// 所以：写 "pid token"，每 20 秒刷一次 mtime 当心跳；判"那边还活着"= pid 活着**且**
// 心跳比 90 秒新。ONESHOT 完全不碰锁文件（自测不该有副作用）。
// 用**空格**分隔：readLock 是按空白切的，用别的符号 pid 那段会解析成 NaN，判活就永远失败。
// RUN_ID 单独留着：自己写进去的是整条 TOKEN，读回来的是切出来的 token 段，拿整条去比会
// 认为自己不是自己，每次心跳都把自己赶走（实测：起 20 秒后自杀，打断检测全废）。
const RUN_ID = Math.random().toString(36).slice(2, 8)
const TOKEN = process.pid + ' ' + RUN_ID
const HEARTBEAT_MS = 20000
const STALE_MS = 90000        // 心跳停了这么久 → 那边已经死了（比睡眠唤醒保守一些）
let owned = false

/** 读锁文件：返回 { pid, token, age }；没有/读坏了返回 undefined。 */
function readLock() {
  try {
    const raw = readFileSync(PIDFILE, 'utf8').trim()
    const age = Date.now() - statSync(PIDFILE).mtimeMs
    const [pid, token] = raw.split(/\s+/)
    return { pid: Number(pid), token, age }
  } catch {
    return undefined
  }
}
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)         // 不抛就是还活着
    return true
  } catch {
    return false
  }
}
/** 那个进程还算数吗：pid 活着 + 心跳新鲜。pid 复用能靠心跳识破。 */
const holderAlive = (lock) =>
  lock !== undefined && Number.isInteger(lock.pid) && lock.pid > 0 && lock.age < STALE_MS && pidAlive(lock.pid)

function writeLock() {
  mkdirSync(PET_DIR, { recursive: true })
  writeFileSync(PIDFILE, TOKEN)
  owned = true
}

if (!ONESHOT) {
  try {
    const lock = readLock()
    if (holderAlive(lock)) {
      log(`已有实例在跑（pid ${lock.pid}，心跳 ${Math.round(lock.age / 1000)}s 前），本进程退出`)
      process.exit(0)
    }
    if (lock !== undefined) log(`接管陈旧的锁文件（pid ${lock.pid}，心跳 ${Math.round(lock.age / 1000)}s 前）`)
    writeLock()
  } catch (e) {
    log(`锁文件处理失败：${e.message}`)
  }
}

/**
 * 心跳。顺带做所有权校验：万一真出现两个实例（比如睡醒了），后写的那个会在下一次心跳发现
 * 锁不是自己的，把**自己**收掉——而不是两个一起往 state.json 里写。谁收谁无所谓，关键只剩一个。
 */
function beat() {
  if (ONESHOT || !owned) return
  try {
    const lock = readLock()
    if (lock !== undefined && lock.token !== RUN_ID && holderAlive(lock)) {
      log(`锁被 pid ${lock.pid} 抢走了，本进程退出（避免两个 watcher 同时写 state.json）`)
      process.exit(0)
    }
    writeLock()
  } catch (e) {
    log(`心跳失败：${e.message}`)
  }
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
  log('oneshot 模式：跑完一轮就退出（不碰锁文件）')
  process.exit(0)
}

setInterval(poll, POLL_MS)
setInterval(beat, HEARTBEAT_MS)
poll()
