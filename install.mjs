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
if (existsSync(join(profile.dir, 'node_modules', ...REQUIRED.split('/')))) {
  console.log('renderer   : ' + REQUIRED + ' found')
} else {
  console.log('')
  console.log('WARNING: ' + REQUIRED + ' is not installed in this profile.')
  console.log('         The pet files will be released, but nothing will render them.')
  console.log('         Install it first:  dsh plugin add ' + REQUIRED)
  console.log('')
}

if (dryRun) {
  console.log('')
  console.log('[dry-run] would copy   ' + here + '  ->  ' + installedAt)
  console.log('[dry-run] would register ' + PKG_NAME + ' in dependencies + bundles (pet v' + petVersion + ')')
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

console.log('')
console.log('Done. Restart DshDesktop to load the pet (pet v' + petVersion + ').')
console.log('The pet shows up as 鲸鱼娘 (id: whalegirl-hd) in the pet picker.')
console.log('If it does not appear, restart once more — the pet directory is scanned during startup.')
