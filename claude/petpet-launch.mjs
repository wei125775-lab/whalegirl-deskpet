// SessionStart 钩子：开 Claude 时把鲸鱼娘桌宠拉起来（已经在跑就不重复开）。
//
// PetPet 是绿色版 Electron，不注册开机自启；靠这个钩子兜住"开 Claude 宠物就在"。
// 顺带把 state.json 复位成 idle——上次会话如果非正常退出，会残留一个 working，
// 宠物一上线就开始吃饭。（渲染层 idle→收碗 有 `currentAction === 'eat'` 守卫，
// 所以宠物本来就待机时写 idle 不会多做一个收碗动作。）
//
// 几处刻意保守的地方：
//   1. exe 不存在就只写日志。spawn 找不到文件时抛的是**异步 error 事件**，不接监听器
//      会变成未捕获异常，钩子失败会在 Claude 里报错——try/catch 拦不住，必须 on('error')。
//   2. 查不到进程就不启动。PetPet 没有单实例锁（viewer/main.js 里没有
//      requestSingleInstanceLock），误判一次就开出两只宠物。
//   3. 一切异常都吞掉只写日志。值得拖慢或搞崩的是 Claude 的启动，不是宠物。
//
// 已知没兜住的：同时开两个 Claude 窗口时，两个钩子可能都还没看到宠物就各拉一次
// （要治只能给 PetPet 加单实例锁），概率极低，且右键退出多余的即可。
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 换位置了改这里，或临时用环境变量 PETPET_EXE 指过去。
// 默认留空 → findExe() 自动去常见位置找。**这里以前写死的是开发机上的绝对路径**，
// 别人拿到这个包，装完 hook 每次开 Claude 都只会得到一行"exe 不存在"。
const EXE = process.env.PETPET_EXE || ''

/** 没显式配置时的兜底探测：绿色版解压出来最常见的落点是桌面/下载目录 */
const findExe = () => {
  if (EXE) return existsSync(EXE) ? EXE : ''
  const home = homedir()
  for (const base of [join(home, 'Desktop'), join(home, 'OneDrive', 'Desktop'), join(home, 'Downloads')]) {
    for (const p of [join(base, 'whalegirl-petpet', 'PetPet.exe'), join(base, 'PetPet', 'PetPet.exe')]) {
      if (existsSync(p)) return p
    }
    // 解压出来的目录名可能带版本号后缀（whalegirl-petpet-1.1.0 这种），再扫一层。
    // 桌面/下载里条目不多，这点开销比"静默找不到"划算。
    try {
      for (const d of readdirSync(base)) {
        const p = join(base, d, 'PetPet.exe')
        if (existsSync(p)) return p
      }
    } catch { /* 目录不存在就算了 */ }
  }
  for (const p of [
    join(home, 'AppData', 'Local', 'Programs', 'PetPet', 'PetPet.exe'),
    'C:/Program Files/PetPet/PetPet.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return ''
}
const WATCH = join(dirname(fileURLToPath(import.meta.url)), 'interrupt-watch.mjs')
const PET_DIR = join(homedir(), '.petpet')
const LOG = join(PET_DIR, 'launch.log')

const log = (msg) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

const running = () => {
  try {
    // 没匹配到时 tasklist 也会打一行中文提示，所以认 'PetPet.exe' 这个字面量
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PetPet.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 8000,
    })
    return out.includes('PetPet.exe')
  } catch (e) {
    // 查不出来时不启动，宁可没有宠物也不要开出两只
    log(`tasklist 失败，跳过启动：${e.message}`)
    return true
  }
}

// 打断检测器：常驻脚本，盯 transcript 找"用户按 Esc"（官方没有 hook 能在打断时触发）。
// 它自己用 pid 文件保证单实例，所以这里无脑拉一次就行——已在跑的话它会立刻退出。
if (existsSync(WATCH)) {
  try {
    const w = spawn(process.execPath, [WATCH], { detached: true, stdio: 'ignore' })
    w.on('error', (e) => log(`打断检测器拉起失败：${e.message}`))
    w.unref()
  } catch (e) {
    log(`打断检测器拉起失败：${e.message}`)
  }
}

const exe = findExe()

if (running()) {
  log('已在运行，跳过')
} else if (!exe) {
  log('找不到 PetPet.exe，跳过启动。用 PETPET_EXE 环境变量指定，或改本文件顶部的 EXE')
} else {
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: join(exe, '..'),
    })
    child.on('error', (e) => log(`启动出错：${e.message}`))
    // spawn 是异步的：失败时也能拿到 child 对象，pid 却是 undefined，
    // 所以等 spawn 事件（真的起来了）再记成功日志
    child.on('spawn', () => log(`已启动 pid=${child.pid}`))
    child.unref()
  } catch (e) {
    log(`启动失败：${e.message}`)
  }
  // 只在"这次真的拉起来了"时才复位状态：宠物本来就在跑的话，state.json 是当前会话的
  // 真实状态，复位它等于凭空插一个 idle 进去（比如压缩上下文时触发 SessionStart）
  try {
    writeFileSync(join(PET_DIR, 'state.json'), JSON.stringify({ state: 'idle', ts: Date.now() }))
  } catch (e) {
    log(`复位 state.json 失败：${e.message}`)
  }
}
