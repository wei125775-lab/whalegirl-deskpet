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

// agent_id 是文件名，先洗一遍——防止上游给了带路径分隔符的怪值
const id = String(ev.agent_id || '').replace(/[^A-Za-z0-9._-]/g, '')
log('EVENT ' + (ev.hook_event_name || '(no event)') + ' id=' + (id || '(empty)')
    + ' type=' + (ev.agent_type || '-') + ' raw=' + raw.length + 'B')
if (!id) process.exit(0)

try {
  if (ev.hook_event_name === 'SubagentStop') {
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
