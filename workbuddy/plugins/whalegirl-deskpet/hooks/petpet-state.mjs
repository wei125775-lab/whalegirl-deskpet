/**
 * 给 Claude Code 的 hook 用：把当前状态写进 ~/.petpet/state.json，
 * 让 PetPet 桌宠知道你是在干活还是在待机。
 *
 * 挂法（~/.claude/settings.json）：
 *   UserPromptSubmit -> node <这个文件的绝对路径> working
 *   Stop             -> node <这个文件的绝对路径> idle
 *
 * 不挂也能用，桌宠照样在桌面上待机、点它会挥手——只是不会跟着你干活。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const state = process.argv[2] === 'working' ? 'working' : 'idle'
const dir = join(homedir(), '.petpet')

// 必须包住，而且**必须正常退出**。这一支是四个 hook 里唯一没有兜底的：抛出去就是退出码非 0，
// 而 UserPromptSubmit 的非 0 退出码在 Claude Code 那边是"拦下这次提交"——目录只读、杀软锁文件、
// 磁盘满，任何一次写失败都会变成"按回车没反应"，用户根本不会想到是桌宠干的。
// 失败只写 stderr（`claude --debug` 里看得见），不影响对话。
try {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state, ts: Date.now() }))
} catch (e) {
  process.stderr.write('[petpet-state] 写 ' + dir + '/state.json 失败：' + (e && e.message) + '\n')
}
