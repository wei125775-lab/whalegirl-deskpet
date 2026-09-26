#!/usr/bin/env node
/**
 * 鲸鱼娘桌宠 · Claude/PetPet 版一键安装
 *
 *   node install.mjs                 # 交互最少的一条路：能找到的自动找，找不到就报清楚
 *   node install.mjs --dry-run       # 只打印将要做什么，什么都不改
 *   node install.mjs --hooks-only    # 只装 hook + 宠物，不碰源码/补丁/构建
 *   node install.mjs --viewer <路径> # 指定 petpet-playbook 源码目录（没给就自动找/克隆）
 *   node install.mjs --pet-exe <路径># 指定 PetPet.exe（写进 SessionStart 钩子，自动拉起用）
 *
 * 干四件事：
 *   1. 把 claude/viewer.patch 打到 petpet-playbook 源码上（内置 diff 应用器，不强依赖 git）
 *   2. 在 viewer 里 npm install && npm run build（--no-build 可跳过）
 *   3. 四个 hook 装进 ~/.claude/hooks/，并**合并**进 ~/.claude/settings.json（先备份、只加不改）
 *   4. 把 whalegirl.petpack 解到 ~/.petpet/pets/whalegirl/
 *
 * **绿色版用户请加 --hooks-only**：绿色版里的 viewer 已经打好补丁，前两步不但白做，
 * 而且第 1 步要 clone github.com——墙内连不上，只会白等一轮超时再报错。
 *
 * 幂等：补丁已打过、hook 已挂过、宠物没换过都会跳过；重复跑不会出问题。
 * 宠物素材的"换没换"按 petpack 的大小 + mtime 标记判断，换了才覆盖（覆盖前备份 pet.json）。
 * Windows 上也可以直接双击 install.cmd。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, 'viewer.patch')
const PETPACK = join(HERE, 'whalegirl.petpack')
const HOOKS = ['petpet-state.mjs', 'interrupt-watch.mjs', 'petpet-launch.mjs', 'petpet-subagent.mjs']
const UPSTREAM = 'https://github.com/stshourenxy-dev/petpet-playbook.git'
const UPSTREAM_TAG = 'v1.3.0'          // 补丁就是对这个版本生成的
const PET_ID = 'whalegirl'

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const flag = (name) => argv.includes('--' + name)

const DRY = flag('dry-run')
const SKIP_BUILD = flag('no-build')
const FORCE = flag('force')
// 绿色版用户：viewer 已经打好补丁了，源码那三步既没用又会因为 github 连不上白等
const HOOKS_ONLY = flag('hooks-only')
const CLAUDE_DIR = opt('claude-home') || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const PETPET_DIR = opt('pet-home') || join(homedir(), '.petpet')

const say = (msg) => console.log(msg)
const step = (msg) => console.log('\n== ' + msg)
const warn = (msg) => console.log('   ! ' + msg)
const ok = (msg) => console.log('   ✓ ' + msg)

// ---------------------------------------------------------------- 1. 找源码
function findViewer() {
  const given = opt('viewer')
  if (given) return resolve(given)
  const cands = [
    join(process.cwd(), 'petpet-playbook'),
    join(homedir(), 'petpet-playbook'),
    join(homedir(), 'Documents', 'petpet-playbook'),
    join(homedir(), 'Downloads', 'petpet-playbook'),
    'D:/petpet-playbook',
    'C:/petpet-playbook',
  ]
  for (const p of cands) {
    if (existsSync(join(p, 'viewer', 'src', 'main.ts'))) return resolve(p)
  }
  return undefined
}

/**
 * 本机没有源码时：优先 git clone；没装 git 就退化成直接下 GitHub 的 tar.gz。
 * ⚠️ **两条路都要连 github.com，墙内两条都不通**（codeload.github.com 也是 github 的域名，
 * 以前这里的注释写着"可直连"，是错的）。墙内请走绿色版 + `--hooks-only`，那条路完全不碰 GitHub。
 */
async function obtainViewer() {
  const dest = join(homedir(), 'petpet-playbook')
  const hasGit = (() => {
    try { return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
  })()
  const tarball = `https://codeload.github.com/stshourenxy-dev/petpet-playbook/tar.gz/refs/tags/${UPSTREAM_TAG}`

  if (DRY) {
    say(`   [dry-run] ${hasGit ? 'git clone --branch ' + UPSTREAM_TAG + ' ' + UPSTREAM : '下载 ' + tarball} → ${dest}`)
    return dest
  }

  if (hasGit) {
    say(`   本地没有源码，克隆到 ${dest}（tag ${UPSTREAM_TAG}）`)
    const r = spawnSync('git', ['clone', '--branch', UPSTREAM_TAG, '--depth', '1', UPSTREAM, dest], { stdio: 'inherit' })
    if (r.status === 0 && existsSync(join(dest, 'viewer', 'src', 'main.ts'))) return dest
    warn('git clone 没成功，改用直接下载压缩包')
  } else {
    say('   本机没有 git —— 直接下 GitHub 的压缩包（不需要 git）')
  }

  if (typeof fetch !== 'function') {
    warn('这个 node 版本没有 fetch（需要 18+），没法自动下载。请手动来：')
    warn(`    打开 ${tarball} 解压，然后用 --viewer <解压出来的目录> 重跑`)
    return undefined
  }
  try {
    const res = await fetch(tarball)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const buf = Buffer.from(await res.arrayBuffer())
    const tgz = join(tmpdir(), `petpet-playbook-${UPSTREAM_TAG}-${Date.now()}.tar.gz`)
    writeFileSync(tgz, buf)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    // 只解我们要的 viewer/ 子树：上游包里有中文文件名的 docs，某些环境下的 bsdtar 会为它们
    // 刷一屏 "Invalid empty pathname"（无害但吓人，而且会让退出码非 0）。所以
    //   ① 只点 viewer 这一支 ② stderr 静音 ③ 判成功看"关键文件在不在"，不看退出码
    // 另外用文件名 + cwd 的组合：PATH 上的 GNU tar 会把 "D:/..." 当成远程主机（Cannot connect to D:）
    const topDir = 'petpet-playbook-' + UPSTREAM_TAG.replace(/^v/, '')
    const bins = process.platform === 'win32' ? ['C:/Windows/System32/tar.exe', 'tar'] : ['tar']
    const want = join(dest, 'viewer', 'src', 'main.ts')
    let done = false
    for (const bin of bins) {
      try {
        spawnSync(bin, ['-xzf', basename(tgz), '-C', dest, '--strip-components=1', `${topDir}/viewer`],
          { cwd: dirname(tgz), stdio: ['ignore', 'ignore', 'ignore'] })
      } catch { /* 换下一个 tar */ }
      if (existsSync(want)) { done = true; break }
    }
    rmSync(tgz, { force: true })
    if (!done) throw new Error('解压后没找到 viewer/src/main.ts')
    ok('源码已下载并解压到 ' + dest)
    return dest
  } catch (e) {
    warn('自动下载失败：' + e.message)
    warn('（墙内这是常态，不用反复试：git clone 和这个压缩包地址都走 github.com）')
    warn('在用绿色版的话本来就不需要源码，加 --hooks-only 重跑、别在这儿耗：')
    warn('     node install.mjs --hooks-only --pet-exe "<绿色版目录>\\PetPet.exe"')
    warn('确实要走源码，就自己把上游下下来，再用 --viewer <路径> 指过来：')
    warn('     ' + tarball)
    return undefined
  }
}

// ---------------------------------------------------------------- 2. 打补丁
/**
 * 极简 unified diff 应用器：按上下文定位 hunk，允许行号漂移。够用于我们这份补丁。
 *
 * **行尾必须宽容**：Windows 上 git 默认 autocrlf=true，clone 出来的源码是 CRLF，而补丁是 LF——
 * 直接按字符比对会「每行都对不上」。所以比对时一律去掉行尾 \r，写回时沿用文件原本的行尾。
 */
function applyPatch(patchText, rootDir) {
  const files = []
  let cur = null
  for (const line of patchText.split('\n')) {
    if (line.startsWith('--- a/')) {
      cur = { path: line.slice(6).trim(), hunks: [] }
      files.push(cur)
    } else if (line.startsWith('+++ b/')) {
      if (cur) cur.path = line.slice(6).trim()
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m || !cur) continue
      cur.hunks.push({ start: Number(m[1]), lines: [] })
    } else if (cur && cur.hunks.length > 0 && /^[+\- ]/.test(line)) {
      cur.hunks[cur.hunks.length - 1].lines.push(line)
    }
  }

  // 全部在内存里改完再落盘。逐文件写的话，第二个文件对不上上下文时第一个已经写进去了，
  // 源码树留在"打了一半"的状态：后面 buildViewer 会拿这棵混合的树照样构建成功、照样
  // 打印"完成"，装出来的是新代码和旧代码拼接的产物，而且没人会发现。
  const pending = []
  for (const f of files) {
    const abs = join(rootDir, f.path)
    if (!existsSync(abs)) throw new Error('补丁里的文件不存在：' + f.path)
    const raw = readFileSync(abs, 'utf8')
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const src = raw.split(/\r?\n/)
    const out = []
    let cursor = 0
    for (const h of f.hunks) {
      // 先按行号找，找不到就在附近上下滑动（上游小改动导致的偏移）
      const before = h.lines.filter(l => l[0] === ' ' || l[0] === '-').map(l => l.slice(1).replace(/\r$/, ''))
      let at = -1
      const guess = Math.max(0, h.start - 1)
      for (const off of [0, -1, 1, -2, 2, -3, 3, -5, 5, -10, 10, -20, 20]) {
        const cand = guess + off
        if (cand < cursor || cand + before.length > src.length) continue
        if (before.every((l, i) => src[cand + i] === l)) { at = cand; break }
      }
      if (at < 0) throw new Error(`${f.path} 第 ${h.start} 行附近的上下文对不上——上游可能改过这个文件，请手工合并`)
      out.push(...src.slice(cursor, at))
      for (const l of h.lines) {
        if (l[0] === ' ' || l[0] === '+') out.push(l.slice(1).replace(/\r$/, ''))
      }
      cursor = at + before.length
    }
    out.push(...src.slice(cursor))
    pending.push([abs, out.join(eol)])
  }
  for (const [abs, text] of pending) writeFileSync(abs, text)
  return pending.length
}

// 补丁指纹：每个文件各查一个"只有最新补丁才有"的特征。
//
// **必须是这种跨文件的 AND，不能写成"任一关键词命中"**。原来那版用一个正则测三个文件、
// 命中一个就算打过，于是装过旧版补丁的机器会被判定为"已打全"而整步跳过，永远拿不到
// 后续补上的修复。现在 main.js 里没有 requestSingleInstanceLock 就说明是旧补丁，
// 会走重打——打不上时 applyPatch 会报出对不上的行，安装随即中断（exit 1）。
const PATCH_MARKERS = [
  ['viewer/main.js', 'requestSingleInstanceLock'],       // 2026-09-18 加的单实例锁
  ['viewer/src/main.ts', 'canTrip'],                     // 连点摔倒（2026-09-21）
  ['viewer/src/state-priority.ts', 'interrupted'],       // 打断检测那一档
]

const alreadyPatched = (root) =>
  PATCH_MARKERS.every(([rel, marker]) => {
    const p = join(root, rel)
    if (!existsSync(p)) return false
    return readFileSync(p, 'utf8').includes(marker)
  })

// ---------------------------------------------------------------- 3. 构建
function buildViewer(root) {
  const dir = join(root, 'viewer')
  say('   npm install && npm run build（第一次要几分钟，别 Ctrl+C）')
  for (const [cmd, args] of [['npm', ['install']], ['npm', ['run', 'build']]]) {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) {
      warn(`${cmd} ${args.join(' ')} 失败，请到 ${dir} 手动跑一遍`)
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------- 4. hooks
function installHooks() {
  const dir = join(CLAUDE_DIR, 'hooks')
  if (DRY) {
    say(`   [dry-run] 复制 ${HOOKS.join(' / ')} → ${dir}`)
    say(`   [dry-run] 合并四个 hook 进 ${join(CLAUDE_DIR, 'settings.json')}`)
    return
  }
  mkdirSync(dir, { recursive: true })
  for (const f of HOOKS) {
    cpSync(join(HERE, f), join(dir, f))
  }
  ok('hook 文件已放入 ' + dir)

  const settingsPath = join(CLAUDE_DIR, 'settings.json')
  let settings = {}
  // settings.json 带 UTF-8 BOM 时 JSON.parse 会直接抛错（PowerShell 的 `Set-Content -Encoding UTF8`
  // 就会写出 BOM，用编辑器另存为也可能带上）。原来那句 catch 只是 warn 后 return——四个 hook
  // 一个都挂不上，脚本却照样打印「完成」，看上去像是她的问题。BOM 只是合法的前缀噪声，剥掉再解，
  // 写回时按原样带上，别改人家的文件格式（不带 BOM 的机器上不许凭空多出一个）。
  let bom = ''
  if (existsSync(settingsPath)) {
    let raw = readFileSync(settingsPath, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) {
      bom = '\ufeff'
      raw = raw.slice(1)
    }
    try {
      settings = JSON.parse(raw)
    } catch (e) {
      warn('settings.json 不是合法 JSON，不敢动它：' + e.message)
      return
    }
    cpSync(settingsPath, settingsPath + '.bak-whalegirl-' + Date.now())
  }
  const hooks = settings.hooks ?? (settings.hooks = {})
  const node = (script, ...rest) =>
    `node "${join(dir, script).replace(/\\/g, '/')}"${rest.length ? ' ' + rest.join(' ') : ''}`

  const wanted = [
    ['SessionStart', node('petpet-launch.mjs')],
    ['UserPromptSubmit', node('petpet-state.mjs', 'working')],
    ['Stop', node('petpet-state.mjs', 'idle')],
    // 子代理：Start/Stop 两个事件同一个脚本，它按 agent_id 在 ~/.petpet/subagents/ 里
    // 建/删记号文件，主进程数个数——她就开始低头看脚边的鲸鱼转圈，全跑完了鲸鱼沉入。
    // 不用计数器是因为 hook 短命且并发，加减必然错。
    ['SubagentStart', node('petpet-subagent.mjs')],
    ['SubagentStop', node('petpet-subagent.mjs')],
  ]
  let added = 0
  // 判重必须拿**整条命令串**比。原来取的是 `command.split(' ')[1]`，也就是"第二个空格分段"，
  // 本意是抠出脚本路径、避开 node 的引号——可 CLAUDE_DIR 带空格时（用户名里有空格）命令本身就
  // 引号化了，截出来的只是一段前缀，含义随环境漂移：可能把没挂过的当成挂过、静默跳过不装。
  // 路径/大小写在不同机器上必然有差异，所以两边都按正斜杠 + 小写归一化再比。
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase()
  for (const [event, command] of wanted) {
    const list = hooks[event] ?? (hooks[event] = [])
    const cmds = (Array.isArray(list) ? list : []).flatMap((g) =>
      (g && Array.isArray(g.hooks) ? g.hooks : []).map((h) => norm(h && h.command)))
    // 判重**永远**生效。原来这里跟着 `--force` 一起失效（`&& !FORCE`），于是加 --force
    // 重跑时每个事件都会多挂一条——同一件事执行两遍（state.json / 子代理记号各写两次）。
    // --force 的正当用途只有一个：强制重装素材（见 installPet），不该管钩子。
    if (cmds.includes(norm(command))) continue
    list.push({ hooks: [{ type: 'command', command }] })
    added += 1
  }
  if (added === 0) {
    ok('settings.json 里这些 hook 都已在，没动它（重复跑不会堆备份）')
    return
  }
  writeFileSync(settingsPath, bom + JSON.stringify(settings, null, 2) + '\n')
  ok(`settings.json 已更新（新增 ${added} 个 hook，原内容保留，备份在同目录 .bak-whalegirl-*）`)
}

/** 找你机器上的 PetPet.exe（Windows：先看桌面快捷方式，再扫绿色版最常见的解压位置） */
function findPetExe() {
  const given = opt('pet-exe')
  if (given) {
    const p = resolve(given)
    // 用户明确指定的优先，但路径不存在必须说出来——否则会静默写进 launcher，
    // 等"开 Claude 她怎么没起来"的时候，没人会想到问题在这儿。
    //
    // 而且**不能把这个坏路径写下去**：petpet-launch.mjs 的 findExe() 第一行是
    // `if (EXE) return existsSync(EXE) ? EXE : ''`——EXE 一旦非空就不再自动探测。
    // 写个打错的路径进去，等于把她钉死在这里，比不给还糟（不给至少会自己去找）。
    if (!existsSync(p)) {
      warn('--pet-exe 指的路径不存在：' + p)
      warn('  （这次不写进 launcher 了：留空它会自己去桌面/下载等位置找，')
      warn('   写个错路径反而把自动探测也堵死了）')
      return undefined
    }
    return p
  }
  if (process.platform === 'win32') {
    try {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command',
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\PetPet.lnk'); if (Test-Path $s.TargetPath) { $s.TargetPath }"],
        { encoding: 'utf8' })
      const p = (ps.stdout || '').trim()
      if (p && existsSync(p)) return p
    } catch { /* 拿不到就算 */ }

    const guesses = [
      join(homedir(), 'AppData', 'Local', 'Programs', 'PetPet', 'PetPet.exe'),
      'C:/Program Files/PetPet/PetPet.exe',
    ]
    for (const g of guesses) if (existsSync(g)) return g

    // 绿色版解压出来是「whalegirl-petpet」这个目录，它摆在哪就在哪——桌面和下载最常见。
    // **这里以前最后一条写的是开发机上的绝对路径**（D:/petpet-playbook/viewer/release/...），
    // 别人机器上永远命中不了 → findPetExe 返回 undefined → 写入那步静默跳过 →
    // launcher 里继续留着开发机的路径，开 Claude 只会白刷一行「exe 不存在」。
    const bases = [
      join(homedir(), 'Desktop'),
      join(homedir(), 'OneDrive', 'Desktop'),
      join(homedir(), 'Downloads'),
      process.cwd(),
      dirname(HERE),
      HERE,
    ]
    const named = ['whalegirl-petpet', 'petpet-playbook', 'PetPet']
    for (const base of bases) {
      for (const n of named) {
        const p = join(base, n, 'PetPet.exe')
        if (existsSync(p)) return p
        const q = join(base, n, 'viewer', 'release', 'whalegirl-pet', 'PetPet.exe')
        if (existsSync(q)) return q
      }
      // 解压出来的目录名可能带版本号后缀（whalegirl-petpet-1.1.0 这种），再扫一层
      try {
        for (const d of readdirSync(base)) {
          if (!/^(whalegirl|petpet)/i.test(d)) continue
          const p = join(base, d, 'PetPet.exe')
          if (existsSync(p)) return p
        }
      } catch { /* 目录不在就算了 */ }
    }
  }
  return undefined
}

function writePetExeIntoLauncher(exe) {
  const f = join(CLAUDE_DIR, 'hooks', 'petpet-launch.mjs')
  if (DRY) {
    say(`   [dry-run] 把 ${exe || '(没找到，跳过)'} 写进 petpet-launch.mjs 的 EXE`)
    return
  }
  // 找不到就**说出来**。这里以前第一行是静默 `return`，后果是 launcher 里继续留着上一个人
  // 写入的路径（早期版本里甚至是开发机的绝对路径），每次开 Claude 都白刷一行日志，
  // 而用户根本不知道要补 --pet-exe。
  if (!exe) {
    warn('没找到 PetPet.exe —— SessionStart 自动拉起那步先跳过（其他部分不受影响）。')
    warn('  指一下再重跑就行：')
    warn('    node install.mjs --hooks-only --pet-exe "<解压目录>\\PetPet.exe"')
    warn('  （不修也能用：自己双击绿色版的「启动.cmd」照样开她，只是开 Claude 时不会自动拉起）')
    return
  }
  if (!existsSync(f)) return
  const s = readFileSync(f, 'utf8')
  // 先分开"没找到那行"和"值本来就一样"两种情况：原来 out === s 一律报「已经是它了」，
  // 可正则没匹配上时也是 out === s —— 文件被人改过格式就走到这里，然后谎报一句成功，
  // 而自动拉起其实一直是坏的（开 Claude 她不出现，谁也不会去翻 launcher）。
  if (!/const EXE = process\.env\.PETPET_EXE \|\| '[^']*'/.test(s)) {
    warn('petpet-launch.mjs 里没找到可替换的 EXE 行（文件被改过？），没动它。')
    warn('  要自动拉起的话，手工把路径填进那句 const EXE 里：' + exe)
    return
  }
  const out = s.replace(/const EXE = process\.env\.PETPET_EXE \|\| '[^']*'/, `const EXE = process.env.PETPET_EXE || '${exe.replace(/\\/g, '\\\\')}'`)
  if (out !== s) {
    writeFileSync(f, out)
    ok('已把 PetPet 路径写进 petpet-launch.mjs：' + exe)
  } else {
    ok('petpet-launch.mjs 里的路径已经是它了：' + exe)
  }
}

// ---------------------------------------------------------------- 5. 宠物
/** 包的身份标记：大小 + mtime。重打过 petpack（哪怕只换一张表）这两样必变 */
function petpackStamp() {
  try {
    const st = statSync(PETPACK)
    return `${st.size}-${Math.floor(st.mtimeMs)}`
  } catch { return '' }
}

function installPet() {
  // 绿色版目录里**没有** petpack（素材由「启动.cmd」负责装），必须在这里就掉头。
  // 少了这道判断，下面会一路走到"没标记 → 覆盖一次"，把已装好的素材 rmSync 掉，
  // 再去解一个根本不存在的包；解包失败只是 warn，最后照样打印「完成」——
  // 宠物就这么静悄悄没了，用户只会觉得"装完反而坏了"。
  // （2026-09-20 实测复现：跑之前目录里 3 个文件，跑之后整个目录都不在了。）
  if (!existsSync(PETPACK)) {
    say('   本目录没有 whalegirl.petpack（绿色版就是这样）——宠物素材归「启动.cmd」管，这里只挂 hook')
    return
  }

  const dest = join(PETPET_DIR, 'pets', PET_ID)
  const destJson = join(dest, 'pet.json')
  const stampFile = join(dest, '.petpack-stamp')
  const stamp = petpackStamp()

  // **判"装过没"不能只看 pet.json 在不在**：那样素材升级永远不会生效——文档说"重跑
  // install.mjs 就行"，可只要目录在就整步跳过，用户拿到的还是旧素材（启动.cmd 当年同款毛病）。
  // 改成比对标记：包没换就跳过（顺带尊重你手改过的权重），包换了才覆盖。
  if (existsSync(destJson) && !FORCE) {
    let installed = ''
    try { installed = readFileSync(stampFile, 'utf8').trim() } catch { /* 旧版脚本装的，没这个文件 */ }
    if (installed && installed === stamp) {
      try {
        const d = JSON.parse(readFileSync(destJson, 'utf8'))
        say(`   已是最新（${Object.keys(d.actions || {}).length} 个动作），跳过。要强制重装加 --force`)
        return
      } catch { /* 坏文件就重装 */ }
    }
    if (!installed) {
      say('   已装过但没有标记（旧版脚本装的，判断不了素材新旧）——覆盖一次并补上标记')
    } else {
      say('   宠物素材有更新，覆盖安装（旧 pet.json 会先备份）')
    }
  }
  if (DRY) {
    say(`   [dry-run] 解 ${PETPACK} → ${dest}${existsSync(destJson) ? '（覆盖，先备份 pet.json）' : ''}`)
    return
  }
  mkdirSync(join(PETPET_DIR, 'pets'), { recursive: true })
  // 覆盖前只备份 pet.json —— 素材本身完全来自包，没有信息损失，会被手改的只有 pet.json。
  // 备份放在 dest **外面**：下一步会把 dest 整个换成解出来的新目录。
  const bak = join(PETPET_DIR, `pet.json.bak-${PET_ID}-${Date.now()}`)
  try {
    if (existsSync(destJson)) {
      cpSync(destJson, bak)
      say('   （旧的 pet.json 已备份到 ' + bak + '）')
    }
  } catch { /* 备份失败不拦着装 */ }
  // 先解到旁边一个临时目录，成了再顶替——**不能先把 dest 删了再解**。
  // 原来就是先 rmSync(dest) 再解包：tar 失败（没装/是 GNU tar/包下载不全）时旧的素材已经删了，
  // 只留一句 warn，用户手里连一份能用的都没有。绿色版用户尤其致命——素材是「启动.cmd」装好的，
  // 在这儿一删就再没有第二份来源了。
  // 解 zip 只能靠系统 tar：Node 没有内置 zip 解析，而 PATH 上的 tar 在 Windows 上
  // 往往是 git bash 的 GNU tar——它认不出 "D:/..." 这种盘符路径（报 Cannot connect to D:），
  // 也不支持 zip。必须点名用 Windows 自带的 bsdtar。
  const tarCandidates = process.platform === 'win32'
    ? ['C:/Windows/System32/tar.exe', 'tar']
    : ['tar']
  const stage = join(PETPET_DIR, '.petpack-stage-' + Date.now())
  // 返回"含 pet.json 的那一层"的绝对路径；解包或定位失败返回 undefined。
  // 口径与 viewer 的 pet-import 一致：顶层就有 pet.json 就是包根，否则在单层子目录里找。
  const extractTo = (dir) => {
    for (const bin of tarCandidates) {
      try {
        spawnSync(bin, ['-xf', PETPACK, '-C', dir], { stdio: 'inherit' })
        if (existsSync(join(dir, 'pet.json'))) return dir
        for (const name of readdirSync(dir)) {
          const sub = join(dir, name)
          try {
            if (statSync(sub).isDirectory() && existsSync(join(sub, 'pet.json'))) return sub
          } catch { /* 坏条目跳过 */ }
        }
      } catch { /* 换下一个 */ }
    }
    return undefined
  }
  let staged
  try {
    mkdirSync(stage, { recursive: true })
    staged = extractTo(stage)
  } catch (e) {
    warn('解包时出错：' + e.message)
  }
  if (staged === undefined) {
    rmSync(stage, { recursive: true, force: true })
    warn('自动解包失败——**你原来那份一点没动**，还照旧能用。也可以手动来：')
    warn('  PetPet 托盘菜单 → 导入宠物包 → 选 claude/whalegirl.petpack')
    return
  }
  // 顶替：旧的先让位，新的搬进来，最后才删旧的。中间任何一步出错都把旧的搬回去。
  // 让位目录放在 pets/ **外面**并带前导点：万一崩在两次 rename 中间，pets/ 里也不会多出一个
  // 带 pet.json 的目录被 PetPet 当成第二只宠物扫出来。
  const trash = join(PETPET_DIR, '.' + PET_ID + '.old-' + Date.now())
  let swapped = false
  try {
    mkdirSync(join(PETPET_DIR, 'pets'), { recursive: true })
    if (existsSync(dest)) renameSync(dest, trash)
    renameSync(staged, dest)
    swapped = true
  } catch (e) {
    warn('替换素材时出错：' + e.message)
    if (!existsSync(dest) && existsSync(trash)) {
      try { renameSync(trash, dest) } catch { /* 尽力，实在不行也没删掉过东西 */ }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    if (swapped) rmSync(trash, { recursive: true, force: true })
  }
  if (!swapped) return
  try { writeFileSync(stampFile, stamp) } catch { /* 写不上就算了，下次会再覆盖一遍 */ }
  ok('宠物已装到 ' + dest)
}

// ---------------------------------------------------------------- main
async function main() {
  say('鲸鱼娘桌宠 · Claude/PetPet 版安装' + (DRY ? '（dry-run，不会改任何东西）' : ''))
  say('  claude 配置目录: ' + CLAUDE_DIR)
  say('  petpet 数据目录: ' + PETPET_DIR)

  let root
  if (HOOKS_ONLY) {
    step('1-3/4 找源码 / 打补丁 / 构建 —— 已按 --hooks-only 跳过')
    say('   绿色版里的 viewer 已经打好补丁，这三步不用做，也不用碰 GitHub。')
  } else {
    step('1/4 找 petpet-playbook 源码')
    root = findViewer()
    if (!root) root = await obtainViewer()
    if (!root) {
      warn('没找到源码，后面的补丁和构建都做不了。')
      warn('（只有宠物包和 hook 能装——但它们需要打过补丁的 viewer 才有完整效果）')
      warn('用绿色版的话本来就不需要源码：加 --hooks-only 重跑，直接跳过这三步。')
    } else {
      ok('源码目录：' + root)
    }

    if (root) {
      step('2/4 打 viewer 补丁')
      if (!existsSync(PATCH)) {
        say('')
        warn('找不到补丁文件：' + PATCH)
        say('   这个包本该自带它。缺文件说明下载或解压漏了东西，请重新拿一份完整包。')
        say('   绿色版用户加 --hooks-only 可以完全跳过这一步。')
        process.exit(1)
      } else if (alreadyPatched(root)) {
        ok('看起来已经打过补丁了（函数名对得上），跳过')
        say('   --force 只管素材，不会重打补丁（以前那句提示是空头支票）。真怀疑补丁是旧的或打了一半：')
        say('   把 viewer 恢复成干净的上游再来跑；在已打过的文件上重打会明确报"上下文对不上"并停下，不会打成半截。')
      } else if (DRY) {
        say('   [dry-run] 打补丁 ' + PATCH + ' → ' + root)
      } else {
        try {
          const n = applyPatch(readFileSync(PATCH, 'utf8'), root)
          ok(`补丁已应用（${n} 个文件）`)
        } catch (e) {
          // 必须停在这里，不能警告一声接着往下走。往下走的话，下一步照样 npm build 成功、
          // 最后照样打印「完成」——装出来的是没打补丁的 viewer，用户重启后一切正常，只是
          // 干活联动、打断反应、连点摔倒统统不在，且没有任何迹象说明为什么。
          say('')
          warn('打不上：' + e.message)
          say('   补丁没有被部分应用：要么全部打上，要么一个文件都没动。')
          say('')
          say('   这个补丁是对 ' + UPSTREAM_TAG + ' 生成的。两种常见原因：')
          say('     · 源码不是 ' + UPSTREAM_TAG + '（更新或更旧）')
          say('     · 之前装过旧版补丁，旧改动还在，上下文对不上')
          say('   两种情况都用一份干净源码重来：')
          say('')
          say('     git clone --branch ' + UPSTREAM_TAG + ' ' + UPSTREAM + ' <目录>')
          say('     node install.mjs --viewer <目录>')
          say('')
          say('   想手工合并：思路写在 viewer.patch 头部。')
          say('   绿色版用户不需要这一步：加 --hooks-only 重跑即可。')
          process.exit(1)
        }
      }

      step('3/4 构建 viewer')
      if (SKIP_BUILD) {
        say('   （--no-build，跳过）')
      } else if (DRY) {
        say('   [dry-run] cd ' + join(root, 'viewer') + ' && npm install && npm run build')
      } else {
        buildViewer(root)
      }
    }
  }

  step('4/4 装 hook、装宠物' + (root ? '、写 PetPet 路径' : ''))
  installHooks()
  writePetExeIntoLauncher(findPetExe())
  installPet()

  say('\n完成。')
  if (HOOKS_ONLY) {
    say('还差一步：重启 Claude Code（让 SessionStart 钩子生效）——之后开 Claude 她就会自己起来。')
    say('  绿色版没在跑的话，双击解压目录里的「启动.cmd」开她。')
    say('  托盘菜单里能手动切成「中口吃 / 屑表情 / 祝福 / 看鲸鱼」等动作先看看。')
  } else {
    say('还差两步：')
    say('  1. 让打过补丁的 viewer 跑起来：')
    say('     · 图省事：cd ' + (root ? join(root, 'viewer') : '<petpet-playbook>/viewer') + ' && npm run dev')
    say('     · 想常驻：把 viewer/dist/ 覆盖进你那份 PetPet 应用的 resources/app/dist/（先删旧的），或自己 electron-builder 打包')
    say('  2. 重启 Claude Code（让 SessionStart 钩子生效）——之后开 Claude 她就会自己起来')
    say('     宠物也能在 PetPet 托盘菜单里手动切成「中口吃 / 屑表情 / 祝福 / 看鲸鱼」等动作先看看')
  }
}

try {
  await main()
} catch (e) {
  console.error('\n出错了：' + (e && e.message ? e.message : e))
  process.exit(1)
}
