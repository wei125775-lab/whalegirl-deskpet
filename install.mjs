/**
 * Install @wei125775-lab/whalegirl-deskpet into a dsh web profile.
 *
 * Copies this package into <DSH_HOME>/profiles/<profile>/node_modules/ and
 * wires it into that profile's package.json (dependencies + dsh.profile.bundles).
 * The bundle entry is placed right before @linxin666/dsh-pet so this plugin's
 * module side effect (releasing the pet into $DSH_HOME/pets/) runs before the
 * pet registry scans that directory.
 *
 * Run with: node install.mjs   (or double-click install.cmd)
 * Options:  --profile=<name>   pick a profile other than the auto-detected one
 *           --dry-run         show what would happen, change nothing
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
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

const dshHome = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

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
  for (const name of names) {
    if (existsSync(join(root, name, 'node_modules', ...REQUIRED.split('/')))) {
      return { name, dir: join(root, name) }
    }
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
 * 没装渲染器就替你装上。
 *
 * 走 dsh 自己的 `plugin add`（= 转发给 pnpm）—— 实测它一条命令把两件事都做了：
 * 装包 + 写进 `dsh.profile.bundles`，所以不用我们手动改 profile manifest。
 *
 * 失败一律只警告、返回 false，绝不抛：素材这时已经放好了，最坏结果只是"暂时还看不到她"，
 * 按收尾那段手动装即可。返回是否装成。
 */
function installRenderer(profile) {
  const cli = findDshCli()
  if (cli === undefined) {
    console.log('   找不到 dsh 命令行（PATH 上和 npm 全局都没有），没法自动装。')
    return false
  }
  const { storeDir, virtualStoreDir } = storeDirs(profile.dir)
  const args = [
    'plugin', '--profile', profile.name, 'add', REQUIRED,
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
    console.log('[dry-run] would install the renderer:  dsh plugin --profile ' + profile.name + ' add ' + REQUIRED)
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

// 2. Copy the package (drop any previous copy first so stale frames cannot linger).
if (existsSync(installedAt)) rmSync(installedAt, { recursive: true, force: true })
mkdirSync(dirname(installedAt), { recursive: true })
// `src` arrives as a full path, so the test has to be relative to `here`. With the old
// src.includes('node_modules') form, a source tree that itself sat under some
// node_modules had its own root rejected -- and when cpSync rejects the root it says
// nothing, creates nothing and copies nothing, while the script carries on and prints
// "copied" as if it had worked.
cpSync(here, installedAt, {
  recursive: true,
  filter: (src) => {
    const parts = relative(here, src).split(sep)
    return !parts.includes('node_modules') && !parts.includes('.git')
  },
})
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
  console.log('Done. Restart DshDesktop to load the pet (pet v' + petVersion + ').')
  console.log('The pet shows up as 鲸鱼娘 (id: whalegirl-hd) in the pet picker.')
  console.log('If it does not appear, restart once more — the pet directory is scanned during startup.')
} else {
  // 收尾必须是"还差一步"，不能是乐观的 Done —— 否则人家装完重启、什么都没看到，只会以为这包是坏的。
  const pnpmStore = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'pnpm', 'store')
    : undefined
  const virtualStore = join(profile.dir, 'node_modules', '.pnpm')
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
  console.log('         dsh plugin --profile ' + profile.name + ' add ' + REQUIRED)
  // 这两条路径要加引号：用户名或安装目录带空格时，照抄圆括号里的原样命令会被 cmd 拆成两个参数
  if (pnpmStore !== undefined) console.log('           "--store-dir=' + pnpmStore + '"')
  console.log('           "--virtual-store-dir=' + virtualStore + '"')
  console.log('')
  console.log('   Both store flags are required: the pnpm bundled with dsh does not read the')
  console.log("   profile's .npmrc, and leaving either one out fails with ERR_PNPM_UNEXPECTED_STORE.")
  console.log('')
  console.log('   Then restart DshDesktop — she shows up in the pet picker as 鲸鱼娘 (whalegirl-hd).')
}
