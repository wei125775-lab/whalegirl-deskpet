/**
 * @wei125775-lab/whalegirl-deskpet —— 插件入口。
 *
 * 这个包有两条路径，入口按目标 profile 的实际情况选一条：
 *
 * - **legacy**：profile 里装了 `@linxin666/dsh-pet`。素材要释放到 `$DSH_HOME/pets/`、
 *   要改它的相位白名单、看鲸鱼要包它的服务方法。自建 DshDesktop（dsh 0.1.5 + web
 *   profile）走这条。
 * - **native**：profile 里没有 dsh-pet。走 lib/engine/ 那套自研引擎，直接从包目录读
 *   素材、自己定义相位、不需要任何第三方。官方桌面版走这条。
 *
 * 判定只看"同 profile 里有没有 dsh-pet"这件事，不猜别的。**选完一定打一行日志**，
 * 静默换路径是最难查的那类问题（表现只是"宠物没了"或者"多了一只"）。
 *
 * 时序上有一处不能挪：legacy 的素材释放必须在**模块顶层**做（早于插件树 apply），
 * 因为 dsh-pet 的宠物注册表是它在自己 apply 期间扫目录建的。所以 prepare() 在这里
 * 直接调，而且只在 legacy 下调 —— native 不该白拷一份素材。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as legacy from './legacy.js'
import { applyEngine } from './engine/index.js'

const here = dirname(fileURLToPath(import.meta.url))
/** 包根（含 pet/ 与 package.json 的那一层）。 */
const packageRoot = dirname(here)

/** 目标 profile 的 node_modules 里有没有 dsh-pet。 */
function dshPetPresent() {
  // 常规：两个包是同一个 node_modules 里的兄弟（装在 profile 里时就是这样）。
  try {
    createRequire(import.meta.url).resolve('@linxin666/dsh-pet/package.json')
    return true
  } catch { /* 落到按自己的安装位置反推 */ }
  // 兜底：从自己的位置推 profile
  //   <profile>/node_modules/@wei125775-lab/whalegirl-deskpet/lib/index.js
  // 不扫 $DSH_HOME 下别的 profile —— 那样会在 A 里加载却按 B 的状态做决定。
  try {
    const profileDir = dirname(dirname(dirname(dirname(here))))
    return existsSync(join(profileDir, 'node_modules', '@linxin666', 'dsh-pet', 'package.json'))
  } catch {
    return false
  }
}

/** 判定结果，模块加载时就定下来（exports 里的 inject 依赖它）。 */
const detected = dshPetPresent() ? 'legacy' : 'native'

if (detected === 'legacy') legacy.prepare()

export const name = '@wei125775-lab/whalegirl-deskpet'

/**
 * 两条路径需要的服务不同：legacy 注 dsh-pet 的 `pet` 服务（看鲸鱼要包它的方法），
 * native 注 `webServer`（要注册状态与素材路由）。
 */
export const inject = detected === 'legacy' ? ['pet'] : ['webServer']

export function apply(ctx, config) {
  const want = typeof config?.engine === 'string' ? config.engine : 'auto'
  let mode = detected
  if (want === 'legacy' || want === 'native') {
    if (want !== detected && want === 'native') {
      // 装了 dsh-pet 还强行走 native，会两只同时画在屏幕上 —— 不接这个配置，
      // 明确说一句然后按探测结果走。
      console.warn('[whalegirl-pet] 配置要求 native，但本 profile 装了 @linxin666/dsh-pet；' +
        '两个引擎会同时渲染，已按 legacy 启动。想用 native 就先卸掉 dsh-pet。')
    } else {
      mode = want
    }
  }

  if (mode === 'legacy') {
    console.log('[whalegirl-pet] 引擎：legacy（挂在 @linxin666/dsh-pet 上，素材释放到 $DSH_HOME/pets/）')
    legacy.apply(ctx)
    return
  }

  console.log('[whalegirl-pet] 引擎：native（自研引擎，不依赖 dsh-pet）')
  try {
    applyEngine(ctx, packageRoot)
  } catch (error) {
    // 插件树加载失败会让 dsh 整个起不来，所以这里兜住。
    console.warn('[whalegirl-pet] 自研引擎启动失败：' + (error && error.message ? error.message : String(error)))
  }
}

export default { apply, inject }
