#!/usr/bin/env node
/**
 * 把「鲸鱼娘桌宠」装成 WorkBuddy 插件。
 *
 * 装完的东西长这样：
 *   ~/.workbuddy/plugins/marketplaces/whalegirl-local/     本地市场（插件就在里面）
 *   ~/.workbuddy/plugins/known_marketplaces.json           加一条市场登记
 *   ~/.workbuddy/plugins/installed_plugins.json            加一条已安装登记
 *
 * 为什么走"市场 + 插件"而不是直接改 `~/.workbuddy/settings.json` 的 hooks：
 * 插件是 WorkBuddy 自己的机制，能出现在插件列表里、能一键卸；而 settings.json
 * 那份要用户手改 JSON，装和卸都得教一遍。
 *
 * **但默认两条都写**：插件里的 hooks 会不会被执行跟 WorkBuddy 的版本有关，而
 * "装完没反应"对普通人来说根本没法判断 —— 所以保底那条（直接写 settings.json 的 hooks）
 * 是默认开的，两个都生效时同一个事件跑两遍（脚本是幂等的写，只多一次进程开销）。
 * 想要干净、只用插件机制就加 `--plugin-only`。
 *
 * ⚠️ **不管哪条路，都必须在 settings.json 的 `enabledPlugins` 里把它打开** ——
 * `installed_plugins.json` 只表示"装了"，真正决定插件生不生效的是那个开关，
 * 而 hooks 是从 `getActivePlugins()` 取的。少了这一步，插件在列表里看得见、
 * 状态也正常，但 hooks 一条都不会执行、日志里也不会说为什么。（实测：这台机器
 * 装了 45 个插件，只有 7 个在 `enabledPlugins` 里。）
 *
 * 用法：
 *   node install.mjs                     装插件 + 启用 + 写 settings.json 的 hooks（推荐）
 *   node install.mjs --plugin-only       装插件 + 启用，但不写保底那份 hooks
 *   node install.mjs --dry-run           只打印要做什么
 *   node install.mjs --workbuddy-home=<目录>   数据目录不是 ~/.workbuddy 时
 *
 * 前提：这台机器**已经装了 PetPet 桌宠本体**（绿色版 zip 里那个）。
 * 这个插件只负责"告诉她你在干活"，宠物本身不在这里。
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = 'whalegirl-deskpet'
const MARKET = 'whalegirl-local'

const argv = process.argv.slice(2)
const flag = (name) => argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='))
const dryRun = flag('dry-run') !== undefined
const withSettingsHooks = flag('plugin-only') === undefined

const homeArg = flag('workbuddy-home')
const home = homeArg === undefined ? '' : (homeArg.includes('=') ? homeArg.slice(homeArg.indexOf('=') + 1) : '')
const wbHome = home !== ''
  ? home
  : ((process.env.WORKBUDDY_HOME ?? '').trim() || join(homedir(), '.workbuddy'))

function fail(msg) {
  console.error('ERROR: ' + msg)
  process.exit(1)
}

// 0. 源文件得齐 —— 从别处拷一份只剩 install.mjs 的目录来跑，要在动用户数据之前就拒绝。
const srcMarket = here
const srcPlugin = join(here, 'plugins', PKG)
if (!existsSync(join(srcMarket, '.codebuddy-plugin', 'marketplace.json'))) {
  fail('这个目录里没有 .codebuddy-plugin/marketplace.json —— 不是完整的插件包（是不是只拷了 install.mjs？）')
}
if (!existsSync(join(srcPlugin, '.codebuddy-plugin', 'plugin.json'))) {
  fail('找不到 plugins/' + PKG + '/.codebuddy-plugin/plugin.json —— 包不完整。')
}
// 从"已安装的副本"里跑会把自己删掉（同 claude/install.mjs 的坑）。
if (basename(dirname(here)) === 'marketplaces') {
  fail('这是已安装的副本本身（' + here + '），换源目录再跑。')
}

const pluginsDir = join(wbHome, 'plugins')
if (!existsSync(pluginsDir)) {
  fail('找不到 ' + pluginsDir + ' —— WorkBuddy 装过并至少启动过一次吗？\n' +
    '（这个目录是它自己建的。没装就先装 WorkBuddy，打开一次，再回来跑本脚本。）')
}

const marketDir = join(pluginsDir, 'marketplaces', MARKET)
const installedJson = join(pluginsDir, 'installed_plugins.json')
const knownJson = join(pluginsDir, 'known_marketplaces.json')

console.log('workbuddy  : ' + wbHome)
console.log('市场        : ' + marketDir)
console.log('插件        : ' + PKG)

if (dryRun) {
  console.log('')
  console.log('[dry-run] would copy   ' + srcMarket + '  ->  ' + marketDir)
  console.log('[dry-run] would register ' + MARKET + ' in known_marketplaces.json')
  console.log('[dry-run] would register ' + PKG + '@' + MARKET + ' in installed_plugins.json')
  console.log('[dry-run] would enable it (settings.json: enabledPlugins)')
  if (withSettingsHooks) console.log('[dry-run] would also write hooks into settings.json')
  process.exit(0)
}

/** 先备份再改。「只备份第一次」—— 重跑不该拿被改过的文件覆盖原始备份。 */
function backup(file) {
  const bak = file + '.bak-whalegirl'
  if (!existsSync(bak)) {
    writeFileSync(bak, readFileSync(file))
    console.log('backup     : ' + bak)
  }
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    fail(what + ' 读不了或不合法：' + file + '\n' + e.message + '\n' +
      '（文件带 BOM 时也会有这个错 —— 用编辑器存成不带 BOM 的 UTF-8。）')
  }
}

// 1. 拷市场（含插件）。先拷到暂存目录再换名：拷到一半失败时旧的那份还在。
mkdirSync(dirname(marketDir), { recursive: true })
const stage = marketDir + '.stage-' + process.pid
const trash = marketDir + '.old-' + process.pid
rmSync(stage, { recursive: true, force: true })
rmSync(trash, { recursive: true, force: true })
try {
  cpSync(srcMarket, stage, { recursive: true })
} catch (e) {
  rmSync(stage, { recursive: true, force: true })
  fail('拷贝到暂存目录失败：' + e.message + '\n（磁盘满 / 杀软占着文件？）')
}
let hadOld = false
try {
  if (existsSync(marketDir)) { renameSync(marketDir, trash); hadOld = true }
  renameSync(stage, marketDir)
} catch (e) {
  if (hadOld) { try { renameSync(trash, marketDir) } catch { /* 下面那句话盖得住 */ } }
  rmSync(stage, { recursive: true, force: true })
  fail('换名失败：' + e.message + '\n（WorkBuddy 正开着？先退干净再跑。）')
}
if (hadOld) { try { rmSync(trash, { recursive: true, force: true }) } catch { console.log('note       : 旧副本留在 ' + trash + '（可以删）') } }
console.log('copied     : -> ' + marketDir)

// 2. 登记市场 + 已安装。两个文件各自备份、各自幂等。
for (const f of [knownJson, installedJson]) {
  if (!existsSync(f)) fail('找不到 ' + f + ' —— WorkBuddy 的数据目录看起来不完整。')
  backup(f)
}

const known = readJson(knownJson, 'known_marketplaces.json')
const now = new Date().toISOString()
// `type` 只能是 `zip` 或 `directory`（内置市场用的就是 directory）。写别的值它认不认
// 没验过 —— 而这台机器上现成的样本就是 directory + 本地路径，照着写最稳。
known[MARKET] = {
  manifestName: MARKET,
  type: 'directory',
  source: { source: 'directory', path: marketDir },
  installLocation: marketDir,
  description: '本地插件市场：鲸鱼娘桌宠',
  lastUpdated: now,
  autoUpdate: false,
  isBuiltIn: false,
}
writeFileSync(knownJson, JSON.stringify(known, null, 2) + '\n')
console.log('registered : marketplace ' + MARKET)

const installed = readJson(installedJson, 'installed_plugins.json')
installed.plugins ??= {}
const key = PKG + '@' + MARKET
const version = readJson(join(srcPlugin, '.codebuddy-plugin', 'plugin.json'), 'plugin.json').version
const prev = installed.plugins[key]?.[0]
installed.plugins[key] = [{
  scope: 'user',
  installPath: join(marketDir, 'plugins', PKG),
  version,
  installedAt: prev?.installedAt ?? now,
  lastUpdated: now,
}]
writeFileSync(installedJson, JSON.stringify(installed, null, 2) + '\n')
console.log('registered : ' + key + ' v' + version)

// 3. **启用它** —— 这一步不能省，而且和下面那条保底路是两件事。
//
// `installed_plugins.json` 只表示"装了"；真正决定插件生不生效的是 settings.json 里的
// `enabledPlugins`。新装的插件默认**不在**里面（实测：这台机器装了 45 个插件，只有 7 个
// 是 true），而 hook 是从 `getActivePlugins()` 取的 —— 少了这一条，插件在列表里看得见、
// 状态也没问题，但它的 hooks **一条都不会执行**，日志里也不会说为什么。
// 所以即使 `--plugin-only`（不要保底那条），这一条也照写。
const settingsPath = join(wbHome, 'settings.json')
backup(settingsPath)
const settingsCfg = existsSync(settingsPath) ? readJson(settingsPath, 'settings.json') : {}
settingsCfg.enabledPlugins ??= {}
if (settingsCfg.enabledPlugins[key] !== true) {
  settingsCfg.enabledPlugins[key] = true
  writeFileSync(settingsPath, JSON.stringify(settingsCfg, null, 2) + '\n')
  console.log('registered : enabledPlugins[' + key + '] = true')
}

// 4. 保底那条路（默认开）：直接往 settings.json 写 hooks。
//    插件里的 hooks 会不会被执行取决于 WorkBuddy 的版本，写这份是让"装完就能用"
//    不押在那件事上。代价是两条都生效时同一事件会跑两遍（无害，脚本是幂等的写）。
//    想要干净就 --plugin-only。
if (withSettingsHooks) {
  const h = (cmd) => [{ hooks: [{ type: 'command', command: cmd }] }]
  // 指向**已安装的插件目录**，这样脚本只有一份。
  const root = join(marketDir, 'plugins', PKG).replace(/\\/g, '/')
  settingsCfg.hooks = {
    SessionStart: h('node "' + root + '/hooks/petpet-launch.mjs"'),
    UserPromptSubmit: h('node "' + root + '/hooks/petpet-state.mjs" working'),
    Stop: h('node "' + root + '/hooks/petpet-state.mjs" idle'),
    SubagentStart: h('node "' + root + '/hooks/petpet-subagent.mjs"'),
    SubagentStop: h('node "' + root + '/hooks/petpet-subagent.mjs"'),
  }
  writeFileSync(settingsPath, JSON.stringify(settingsCfg, null, 2) + '\n')
  console.log('registered : hooks -> settings.json（保底那条路）')
}

console.log('')
console.log('Done. 重启 WorkBuddy（完全退出再打开）让它加载插件。')
console.log('桌宠本体不在这里 —— 没有 PetPet 的话先装绿色版：')
console.log('  https://github.com/wei125775-lab/whalegirl-deskpet/releases/latest')
