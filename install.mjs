/**
 * Install @wei125775-lab/whalegirl-deskpet into a dsh profile.
 *
 * Copies this package into <DSH_HOME>/profiles/<profile>/node_modules/ and
 * wires it into that profile's package.json (dependencies + dsh.profile.bundles).
 * The bundle entry is placed right before @linxin666/dsh-pet so this plugin's
 * module side effect (releasing the pet into $DSH_HOME/pets/) runs before the
 * pet registry scans that directory.
 *
 * Works for an npm-installed dsh (web profile) and for the official desktop app
 * (its own DSH_HOME + `desktop` profile) — pass --dsh-home / --profile, and for
 * the desktop app also --desktop-app so the renderer installs through the pnpm
 * bundled inside that app instead of the npm-global `dsh` CLI.
 *
 * Run with: node install.mjs   (or double-click install.cmd)
 * Options:  --profile=<name>       pick a profile other than the auto-detected one
 *           --dsh-home=<dir>       harness home (default: $DSH_HOME, else ~/.dsh)
 *           --renderer-spec=<spec> what to install as the renderer, version included
 *                                  (default: @linxin666/dsh-pet@latest)
 *           --desktop-app=<dir>    official desktop app dir; install the renderer
 *                                  with the pnpm bundled in it
 *           --no-renderer          never auto-install the renderer
 *           --dry-run              show what would happen, change nothing
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = '@wei125775-lab/whalegirl-deskpet'
/** Bundle whose apply must come after ours, so the pet is on disk in time. */
const ANCHOR = '@linxin666/dsh-pet'
/** Pet dependency: without it the released files have nothing to render them. */
const REQUIRED = '@linxin666/dsh-pet'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='))
  return hit === undefined ? undefined : hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}
const dryRun = flag('dry-run') !== undefined
const skipRenderer = flag('no-renderer') !== undefined
const wantProfile = flag('profile')
const desktopApp = flag('desktop-app')
/**
 * 要装的渲染器 spec（可以带版本）。默认不带版本。
 *
 * **给 web profile 装时必须钉版本**：桌面版用的是 dsh 0.1.7，要 dsh-pet 0.4.2
 * （它的 peerDeps 是 `dsh >=0.1.7-rc.1`），而 npm 全局的 dsh 是 0.1.5 —— 不钉版本
 * 就会把 0.4.2 装进 0.1.5 的 profile 里，web 侧直接坏掉。所以：
 *   web     -> --renderer-spec=@linxin666/dsh-pet@0.3.23
 *   desktop -> --renderer-spec=@linxin666/dsh-pet@0.4.2
 */
const rendererSpec = flag('renderer-spec') || REQUIRED

const dshHome = flag('dsh-home') || (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

function fail(message) {
  console.error('ERROR: ' + message)
  process.exit(1)
}

/** Pick the profile to install into. */
function resolveProfile() {
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) fail('no dsh profiles directory at ' + root + '\nIs dsh installed, or is DSH_HOME right?')
  const names = readdirSync(root).filter((name) => existsSync(join(root, name, 'package.json')))
  if (names.length === 0) fail('no profile with a package.json under ' + root)
  if (wantProfile !== undefined) {
    if (!names.includes(wantProfile)) {
      fail('profile ' + JSON.stringify(wantProfile) + ' not found. Available: ' + names.join(', '))
    }
    return { name: wantProfile, dir: join(root, wantProfile) }
  }
  // Prefer the profile that actually has the pet plugin — that is the one whose
  // bundles list needs this entry to mean anything.
  const withRenderer = names.filter((name) =>
    existsSync(join(root, name, 'node_modules', ...REQUIRED.split('/'))))
  // 多个候选时**不能盲选**：readdirSync 的顺序在 Windows 上不是字母序，挑中的那个不可预期，
  // 而挑错的代价是改了另一个 profile 的 bundles。以前这里是取循环里第一个命中的。
  if (withRenderer.length === 1) return { name: withRenderer[0], dir: join(root, withRenderer[0]) }
  if (withRenderer.length > 1) {
    fail('several profiles have ' + REQUIRED + ' installed (' + withRenderer.join(', ') + ').\n' +
      'Pass --profile=<name> to say which one to install into.')
  }
  if (names.includes('web')) return { name: 'web', dir: join(root, 'web') }
  if (names.length === 1) return { name: names[0], dir: join(root, names[0]) }
  fail('cannot tell which profile to use (' + names.join(', ') + '). Pass --profile=<name>.')
}

/** 找得到 dsh 命令行就返回它的路径；找不到返回 undefined（非 Windows 交给 PATH）。 */
function findDshCli() {
  if (process.platform !== 'win32') return 'dsh'
  const candidates = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'dsh.cmd'))
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'nodejs', 'dsh.cmd'))
  if (process.env['ProgramFiles(x86)']) candidates.push(join(process.env['ProgramFiles(x86)'], 'nodejs', 'dsh.cmd'))
  for (const c of candidates) if (existsSync(c)) return c
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (dir === '') continue
    for (const name of ['dsh.cmd', 'dsh.exe', 'dsh']) {
      const c = join(dir, name)
      if (existsSync(c)) return c
    }
  }
  return undefined
}

/**
 * pnpm 的两个 store 目录 —— 从 profile 的 `.npmrc` 读，读不到再退回默认。
 * 必须显式传给 `dsh plugin`：dsh 内置的 pnpm v11 不再自动读 profile 的 .npmrc，
 * 少任一个都会以 ERR_PNPM_UNEXPECTED_STORE 退出。
 */
function storeDirs(profileDir) {
  let storeDir
  let virtualStoreDir
  try {
    for (const line of readFileSync(join(profileDir, '.npmrc'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(store-dir|virtual-store-dir)\s*=\s*(.+?)\s*$/.exec(line)
      if (m === null) continue
      if (m[1] === 'store-dir') storeDir = m[2]
      else virtualStoreDir = m[2]
    }
  } catch { /* 没 .npmrc 就用默认 */ }
  return {
    storeDir: storeDir ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'store') : undefined),
    virtualStoreDir: virtualStoreDir ?? join(profileDir, 'node_modules', '.pnpm'),
  }
}

/**
 * 用桌面版**自带的** pnpm 装渲染器，与它的运行时版本完全对齐。
 *
 * 官方侧边栏「插件」页走的就是这条命令：把 Electron 本体当 Node 用（ELECTRON_RUN_AS_NODE），
 * 执行 app 内 `resources/runtime/pnpm/bin/pnpm.mjs`，cwd 是 profile 目录。不这么做就只能退回
 * npm 全局的 `dsh` CLI —— 那是另一套版本（dsh 0.1.5 / pnpm 11.23），往 0.1.7 的 profile 里装
 * 东西不合适。
 *
 * 和桌面版一样不给子进程 DSH_HOME：pnpm 只认 cwd，留着反而可能误导包脚本。
 */
function installRendererViaDesktopApp(profile, appDir) {
  const exe = join(appDir, 'DeepSeek Harness.exe')
  const pnpmEntry = join(appDir, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const binDir = join(appDir, 'resources', 'runtime', 'bin')
  if (!existsSync(exe) || !existsSync(pnpmEntry)) {
    console.log('   在 ' + appDir + ' 里找不到 DeepSeek Harness.exe 或自带 pnpm，这条路径走不通。')
    return false
  }
  const args = ['--expose-internals', pnpmEntry, 'add', rendererSpec]
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: exe,
    PATH: binDir + delimiter + (process.env.PATH ?? ''),
  }
  delete env.DSH_HOME
  console.log('   ' + exe + ' ' + args.join(' '))
  const r = spawnSync(exe, args, { cwd: profile.dir, stdio: 'inherit', env })
  if (r.error !== undefined) {
    console.log('   启动失败：' + r.error.message)
    return false
  }
  if (r.status !== 0) {
    console.log('   pnpm 退出码 ' + r.status + '（多半是网络或 registry 的问题）')
    return false
  }
  return existsSync(join(profile.dir, 'node_modules', ...REQUIRED.split('/')))
}

/**
 * 没装渲染器就替你装上。
 *
 * 默认走 dsh 自己的 `plugin add`（= 转发给 pnpm）—— 实测它一条命令把两件事都做了：
 * 装包 + 写进 `dsh.profile.bundles`，所以不用我们手动改 profile manifest。
 * 给了 `--desktop-app` 时改走桌面版自带的 pnpm（见上）。
 *
 * 失败一律只警告、返回 false，绝不抛：素材这时已经放好了，最坏结果只是"暂时还看不到她"，
 * 按收尾那段手动装即可。返回是否装成。
 */
function installRenderer(profile) {
  if (desktopApp !== undefined && desktopApp !== '') {
    return installRendererViaDesktopApp(profile, desktopApp)
  }
  const cli = findDshCli()
  if (cli === undefined) {
    console.log('   找不到 dsh 命令行（PATH 上和 npm 全局都没有），没法自动装。')
    return false
  }
  const { storeDir, virtualStoreDir } = storeDirs(profile.dir)
  const args = [
    'plugin', '--profile', profile.name, 'add', rendererSpec,
    ...(storeDir === undefined ? [] : ['--store-dir=' + storeDir]),
    '--virtual-store-dir=' + virtualStoreDir,
  ]
  // Windows 上的 dsh.cmd 是批处理，必须走 shell；可 shell:true 时 Node 把命令拼成一整行交给
  // cmd.exe，**参数里的空格会被当成分隔符**——用户名带空格（C:\Users\John Doe\…）或 dsh 装在
  // Program Files 下时，pnpm store 路径被拆成两个参数，这一步必失败。所以走 shell 时逐个加引号。
  // （cmd /s 会剥掉最外层那一对引号，所以每段自己带引号是正解。）
  const shell = process.platform === 'win32'
  const q = (s) => '"' + String(s) + '"'
  const argv = shell ? args.map(q) : args
  const shown = shell ? [q(cli), ...argv].join(' ') : [cli, ...args].join(' ')
  console.log('   ' + shown)
  const r = spawnSync(shell ? q(cli) : cli, argv, { stdio: 'inherit', shell })
  if (r.error !== undefined) {
    console.log('   启动失败：' + r.error.message)
    return false
  }
  if (r.status !== 0) {
    console.log('   dsh 退出码 ' + r.status + '（多半是网络或 pnpm store 的问题）')
    return false
  }
  return existsSync(join(profile.dir, 'node_modules', ...REQUIRED.split('/')))
}

/**
 * 手动装渲染器的命令 —— dry-run 和收尾提示都要用，单独一处，免得两边说法不一致
 * （以前收尾那段自己抄了一份 store 默认值，还不读 profile 的 .npmrc）。
 * 返回的命令可能带换行。
 */
function rendererInstallHint(profile) {
  if (desktopApp !== undefined && desktopApp !== '') {
    return join(desktopApp, 'DeepSeek Harness.exe') + ' --expose-internals \\\n' +
      '           "' + join(desktopApp, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs') + '" add ' + rendererSpec +
      '\n         （先设 ELECTRON_RUN_AS_NODE=1，cwd 用 ' + profile.dir + '）'
  }
  const { storeDir, virtualStoreDir } = storeDirs(profile.dir)
  return 'dsh plugin --profile ' + profile.name + ' add ' + rendererSpec +
    (storeDir === undefined ? '' : '\n           "--store-dir=' + storeDir + '"') +
    '\n           "--virtual-store-dir=' + virtualStoreDir + '"'
}

/**
 * 渲染器是不是 bundle 型插件（manifest 带 `dsh.bundle.patch`）。
 * 不是的话登记进 bundles 也没用，只会给 loader 添一条报错的 entry。
 */
function rendererDeclaresBundle(profile) {
  try {
    const manifest = join(profile.dir, 'node_modules', ...REQUIRED.split('/'), 'package.json')
    return JSON.parse(readFileSync(manifest, 'utf8'))?.dsh?.bundle !== undefined
  } catch {
    return false
  }
}

const profile = resolveProfile()
const profileJson = join(profile.dir, 'package.json')
const installedAt = join(profile.dir, 'node_modules', ...PKG_NAME.split('/'))

console.log('dsh home   : ' + dshHome)
console.log('profile    : ' + profile.name + '  (' + profile.dir + ')')

// 0. Sanity: the pet payload has to be here, or there is nothing to install.
const petJson = join(here, 'pet', 'pet.json')
if (!existsSync(petJson)) {
  fail('pet/pet.json is missing — the package looks incomplete (did the download drop the pet/ folder?)')
}
let petVersion
try {
  petVersion = JSON.parse(readFileSync(petJson, 'utf8')).version
} catch (error) {
  fail('pet/pet.json is not readable JSON: ' + error.message)
}

// 1. Warn (do not fail) when the pet renderer is absent: the files still land
// in the right place, they just will not show up until dsh-pet is installed.
// The closing message depends on this, so it is computed once here.
let hasRenderer = existsSync(join(profile.dir, 'node_modules', ...REQUIRED.split('/')))
if (hasRenderer) {
  console.log('renderer   : ' + REQUIRED + ' found')
} else {
  console.log('renderer   : ' + REQUIRED + ' ** NOT INSTALLED ** — she will not show up yet (see the end)')
}

// 1.5 Refuse to run from the installed copy itself. install.cmd lives inside the plugin
// directory, so double-clicking it again after installing is a natural thing to do --
// and then `here` IS `installedAt`. The copy step would delete this very copy first and
// then copy from a source that no longer exists, leaving the plugin gone while its entry
// stayed in the profile's bundles list. Checked before anything that does work: no point
// spending a `dsh plugin add` on an install we are about to refuse.
const relHere = relative(installedAt, here)
if (relHere === '' || (!relHere.startsWith('..') && !isAbsolute(relHere))) {
  fail('this is the installed copy itself: ' + here + '\n' +
    'Going on would delete this copy first — i.e. uninstall the plugin.\n' +
    'Run it from the source checkout instead, or unpack a fresh copy elsewhere.')
}

if (dryRun) {
  console.log('')
  console.log('[dry-run] would copy   ' + here + '  ->  ' + installedAt)
  console.log('[dry-run] would register ' + PKG_NAME + ' in dependencies + bundles (pet v' + petVersion + ')')
  console.log('[dry-run] would patch @linxin666/dsh-pet phases with ' + 'whale-in / whale-loop / whale-out')
  if (!hasRenderer && !skipRenderer) {
    console.log('[dry-run] would install the renderer:  ' + rendererInstallHint(profile))
  }
  process.exit(0)
}

// 1.7 渲染器：没装就替你装上。没有它什么都不会显示，而这一步对陌生人最容易漏。
// 默认装（用户要的行为）；不想要这个副作用就加 --no-renderer。
if (!hasRenderer && !skipRenderer) {
  console.log('renderer   : not installed — installing it now (pass --no-renderer to skip)')
  hasRenderer = installRenderer(profile)
  console.log('')
  console.log('renderer   : ' + (hasRenderer ? 'installed OK' : 'auto-install did not succeed — see the manual steps at the end'))
}

// 2. Copy the package, staging first: the old code deleted the installed copy up
// front, so a failure part-way through left nothing behind (or half a tree) and the
// script still printed "copied". Swapping in a finished stage keeps the installed
// copy intact until the new one is complete.
mkdirSync(dirname(installedAt), { recursive: true })
const stage = join(dirname(installedAt), '.' + basename(installedAt) + '.stage-' + process.pid)
const trash = join(dirname(installedAt), '.' + basename(installedAt) + '.old-' + process.pid)
rmSync(stage, { recursive: true, force: true })
rmSync(trash, { recursive: true, force: true })
// `src` arrives as a full path, so the test has to be relative to `here`. With the old
// src.includes('node_modules') form, a source tree that itself sat under some
// node_modules had its own root rejected -- and when cpSync rejects the root it says
// nothing, creates nothing and copies nothing, while the script carries on and prints
// "copied" as if it had worked.
cpSync(here, stage, {
  recursive: true,
  filter: (src) => {
    const parts = relative(here, src).split(sep)
    return !parts.includes('node_modules') && !parts.includes('.git')
  },
})

let hadOld = false
try {
  // A lock on the installed copy (antivirus, a running dsh) can make the rename fail,
  // so the old tree goes back rather than leaving the profile without the plugin.
  if (existsSync(installedAt)) {
    renameSync(installedAt, trash)
    hadOld = true
  }
  renameSync(stage, installedAt)
} catch (error) {
  if (hadOld) {
    try { renameSync(trash, installedAt) } catch { /* the message below covers it */ }
  }
  rmSync(stage, { recursive: true, force: true })
  fail('could not swap in the new copy: ' + error.message + '\n' +
    'The previous copy is ' + (hadOld ? 'back in place' : 'untouched') + '.')
}
if (hadOld) {
  try { rmSync(trash, { recursive: true, force: true }) }
  catch { console.log('note       : old copy left at ' + trash + ' (safe to delete)') }
}
console.log('copied     : -> ' + installedAt)

// 3. Wire it into the profile manifest, keeping a backup of the previous one.
// Only the first run snapshots: re-installing must not overwrite the pristine
// copy with an already-modified one.
const raw = readFileSync(profileJson, 'utf8')
const backupPath = profileJson + '.bak-whalegirl'
if (!existsSync(backupPath)) writeFileSync(backupPath, raw)
const profilePkg = JSON.parse(raw)

profilePkg.dependencies ??= {}
profilePkg.dependencies[PKG_NAME] = 'file:./node_modules/' + PKG_NAME

if (profilePkg.dsh === undefined) profilePkg.dsh = {}
if (profilePkg.dsh.profile === undefined) profilePkg.dsh.profile = {}
if (!Array.isArray(profilePkg.dsh.profile.bundles)) {
  console.log('note       : dsh.profile.bundles was missing — creating it (this profile may be non-standard)')
  profilePkg.dsh.profile.bundles = []
}
const bundles = profilePkg.dsh.profile.bundles

// 渲染器也得在 bundles 里。走 `dsh plugin add` 时它自己会登记，但走 `--desktop-app`
// 那条路是直接调 pnpm 的 —— 只装了包、没登记，而 dsh-pet 带 `dsh.bundle.patch`，
// 不在 bundles 里就**根本不会被加载**（症状：装完一切正常，宠物就是不出现）。
// 补在登记自己之前，这样下一步的锚点查找才排得到它前面。
if (!bundles.includes(REQUIRED) && rendererDeclaresBundle(profile)) {
  bundles.push(REQUIRED)
  console.log('note       : ' + REQUIRED + ' was not in bundles — registered it (pnpm 那条路不会自己登记)')
}

const existing = bundles.indexOf(PKG_NAME)
if (existing !== -1) bundles.splice(existing, 1)
const anchorAt = bundles.indexOf(ANCHOR)
bundles.splice(anchorAt === -1 ? bundles.length : anchorAt, 0, PKG_NAME)

writeFileSync(profileJson, JSON.stringify(profilePkg, null, 2) + '\n')
console.log('registered : ' + PKG_NAME + ' at index ' + bundles.indexOf(PKG_NAME) + (anchorAt === -1 ? ' (anchor not found, appended)' : ' (before ' + ANCHOR + ')'))
console.log('backup     : ' + profileJson + '.bak-whalegirl')

// 4. dsh-pet 的相位白名单补丁 —— 「看鲸鱼」用的三个自定义 phase 靠它放行。
// 失败只警告不中断：补丁不在时宠物照样装、照样显示，只是没有看鲸鱼
// （插件里的护栏会把那几个相位从 manifest 摘掉，不会让她被校验拒绝）。
try {
  const { patchDshPet } = await import('./patch-dshpet.mjs')
  patchDshPet({ dshHome, profileDir: profile.dir })
} catch (error) {
  console.log('note       : dsh-pet phase patch skipped (' + (error && error.message ? error.message : error) + ')')
}

console.log('')
if (hasRenderer) {
  console.log('Done. Restart dsh to load the pet (pet v' + petVersion + ').')
  console.log('The pet shows up as 鲸鱼娘 (id: whalegirl-hd) in the pet picker.')
  console.log('If it does not appear, restart once more — the pet directory is scanned during startup.')
} else if (skipRenderer) {
  // 显式说了不要渲染器 = 目标 profile 走自研引擎（没装 dsh-pet）。这时候"没有渲染器"
  // 是**正常状态**，不能再提示去装 dsh-pet —— 那会把用户推到一个两只宠物同时渲染的
  // 局面上（自研引擎画一只，dsh-pet 再画一只）。
  console.log('Done. Restart dsh to load the pet (pet v' + petVersion + '，自研引擎模式)。')
  console.log('')
  console.log('   没有渲染器是你要的：这个 profile 走 lib/engine/ 那套自研引擎，不依赖')
  console.log('   @linxin666/dsh-pet。启动日志里会打一行「引擎：native」可以对照。')
  console.log('')
  console.log('   如果这个 profile 其实装了 dsh-pet，就别用 --no-renderer —— 入口探到它')
  console.log('   会自己改走 legacy（释放素材 + 打相位补丁），两条路只走一条。')
} else {
  // 收尾必须是"还差一步"，不能是乐观的 Done —— 否则人家装完重启、什么都没看到，只会以为这包是坏的。
  console.log('!! She will NOT show up yet — this profile has no renderer.')
  console.log('')
  console.log('   ' + REQUIRED + ' is the plugin that actually draws her. Our package only')
  console.log('   puts the assets in place, so nothing renders them until it is installed.')
  console.log('')
  console.log('   The good news: the assets are already there. Install the renderer and she')
  console.log('   appears on the next restart — no need to run this script again.')
  console.log('')
  console.log('   Either way works:')
  console.log('     - In the dsh UI: open the plugin market and search for "dsh-pet".')
  console.log('     - Or from a terminal:')
  // 命令里带空格的路径都要加引号：用户名或安装目录带空格时，照抄原样会被 cmd 拆成两个参数
  console.log('         ' + rendererInstallHint(profile))
  if (desktopApp === undefined || desktopApp === '') {
    console.log('')
    console.log('   Both store flags are required: the pnpm bundled with dsh does not read the')
    console.log("   profile's .npmrc, and leaving either one out fails with ERR_PNPM_UNEXPECTED_STORE.")
  }
  console.log('')
  console.log('   Then restart dsh — she shows up in the pet picker as 鲸鱼娘 (whalegirl-hd).')
}
