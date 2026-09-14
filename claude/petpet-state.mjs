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

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'state.json'), JSON.stringify({ state, ts: Date.now() }))
