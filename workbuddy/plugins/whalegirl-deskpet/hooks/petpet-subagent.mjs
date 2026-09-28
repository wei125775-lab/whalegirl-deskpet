#!/usr/bin/env node
// Claude Code 派子代理时，在 ~/.petpet/subagents/ 下留一个记号文件；子代理结束就删掉。
// 桌宠主进程数这个目录里的文件数 = 当前有几个子代理在跑，据此在脚边叠加对应数量的小海豚。
//
// 为什么用"一个子代理一个文件"而不是计数器：hook 是短命进程、还可能并发，
// 计数器读-改-写必然丢；文件名天然去重，Start/Stop 乱序也不怕。
// 残留（进程被杀、hook 没跑完）靠主进程按 mtime 超时兜底。
//
// 挂在 settings.json 的 SubagentStart / SubagentStop 上，两个事件都传进来，
// 按 stdin 里的 hook_event_name 分流。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = path.join(os.homedir(), '.petpet', 'subagents')
// 触发日志：Start/Stop 成对出现、文件又被 Stop 删掉，光看目录分不清"没触发"和"触发后清理干净"，
// 排查时(尤其第一次挂 hook)只有这份日志能说明问题。
const LOG = path.join(os.homedir(), '.petpet', 'subagents.log')

function log(msg) {
  try {
    // 先建父目录：appendFileSync **不会**替你建，~/.petpet 还不存在时它直接 ENOENT，
    // 被 catch 一吞就是"日志一行没有"——而那正好是第一次挂 hook、最需要这份日志的时候
    // （实测：首次导入宠物前，前两次调用记的全丢了）。
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n')
  } catch { /* 日志写不了也不能影响主流程 */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', () => resolve(s))
    // 万一上游没关 stdin，2 秒后照常往下走
    setTimeout(() => resolve(s), 2000).unref()
  })
}

const raw = await readStdin()
let ev = {}
try { ev = JSON.parse(raw) } catch { /* 解析不了就当没这回事 */ }

// agent_id 是文件名，先洗一遍——防止上游给了带路径分隔符的怪值。
// 洗完还要把 "." / ".." 本身挡掉：这两个字符集合法、洗不掉，可它们不是文件名而是**目录跳转**——
// Stop 时 rmSync(join(DIR,'..')) 会对着 ~/.petpet 下手，起记号时又会往父目录写文件。
const id = String(ev.agent_id || '').replace(/[^A-Za-z0-9._-]/g, '')
if (id === '.' || id === '..') {
  log('SKIP agent_id 是目录跳转：' + id)
  process.exit(0)
}
log('EVENT ' + (ev.hook_event_name || '(no event)') + ' id=' + (id || '(empty)')
    + ' type=' + (ev.agent_type || '-') + ' raw=' + raw.length + 'B')
if (!id) process.exit(0)

const event = ev.hook_event_name
if (event !== 'SubagentStart' && event !== 'SubagentStop') {
  // 只认这两个。原来写的是 `if (Stop) 删 else 建`——也就是**名字对不上就建**：
  // stdin 解析失败、字段改名、以后多了个也带 agent_id 的新事件，都会落下一个永远没人删的记号，
  // 表现就是"脚边的小海豚一直转圈不沉下去"，而且看日志还以为一切正常。宁可什么都不做。
  log('SKIP 不认识的事件名，不建记号')
  process.exit(0)
}

try {
  if (event === 'SubagentStop') {
    fs.rmSync(path.join(DIR, id), { force: true })
  } else {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(path.join(DIR, id),
      JSON.stringify({ ts: Date.now(), type: ev.agent_type || '' }))
  }
} catch (e) {
  log('ERR ' + (e && e.message))   // 桌宠的事不该影响主流程，但排查时要知道它坏了
}

process.exit(0)
