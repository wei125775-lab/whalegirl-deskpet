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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
const hasRenderer = existsSync(join(profile.dir, 'node_modules', ...REQUIRED.split('/')))
if (hasRenderer) {
  console.log('renderer   : ' + REQUIRED + ' found')
} else {
  console.log('renderer   : ' + REQUIRED + ' ** NOT INSTALLED ** — she will not show up yet (see the end)')
}

if (dryRun) {
  console.log('')
  console.log('[dry-run] would copy   ' + here + '  ->  ' + installedAt)
  console.log('[dry-run] would register ' + PKG_NAME + ' in dependencies + bundles (pet v' + petVersion + ')')
  console.log('[dry-run] would patch @linxin666/dsh-pet phases with ' + 'whale-in / whale-loop / whale-out')
  process.exit(0)
}

// 2. Copy the package (drop any previous copy first so stale frames cannot linger).
if (existsSync(installedAt)) rmSync(installedAt, { recursive: true, force: true })
mkdirSync(dirname(installedAt), { recursive: true })
cpSync(here, installedAt, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
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
  if (pnpmStore !== undefined) console.log('           --store-dir=' + pnpmStore)
  console.log('           --virtual-store-dir=' + virtualStore)
  console.log('')
  console.log('   Both store flags are required: the pnpm bundled with dsh does not read the')
  console.log("   profile's .npmrc, and leaving either one out fails with ERR_PNPM_UNEXPECTED_STORE.")
  console.log('')
  console.log('   Then restart DshDesktop — she shows up in the pet picker as 鲸鱼娘 (whalegirl-hd).')
}
