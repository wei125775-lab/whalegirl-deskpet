/**
 * 宿主给浏览器端的 HTTP 接口 + 帧图路由。
 *
 * 通道选择：**纯 HTTP 轮询**，没有 WebSocket / SSE。这是照 dsh-pet 的做法（它整个
 * 插件也没有任何推送机制），好处是简单、在桌面版的 `dsh-app://` 协议下也稳；代价
 * 是状态最多晚一个轮询周期才反映出来，所以我们把间隔从它的 2000ms 压到 400ms，
 * 并且**状态没变时回 304 空 body**，空轮询几乎不花流量。
 *
 * 素材路由是 `kind: 'prefix'` 的一条，服务全部帧图：只认扫描期建好的白名单集合，
 * 所以 `..` 之类的构造段天然匹配不上；再加一道 realpath 包含性检查兜底。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ASSET_PREFIX } from './manifest.js'
import { sanitizeDisplay } from './persist.js'

export const API_PREFIX = '/api/whalegirl'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

function mimeFor(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? 'application/octet-stream' : (MIME_BY_EXT[file.slice(dot).toLowerCase()] ?? 'application/octet-stream')
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

/** 弱校验器：状态 JSON 的指纹。内容一样就不重发 body。 */
function jsonEtag(body) {
  return '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"'
}

/** 帧图的弱校验器：大小 + mtime，和 dsh-pet 同一套。 */
function fileEtag(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'
}

/** 请求体上限（点击/配置都只有几个字段，64KB 已经很宽松）。 */
const BODY_CAP = 64 * 1024

/**
 * 读 JSON 请求体。**只接受普通对象**，其余（`null`、数组、数字、字符串、坏 JSON、
 * 超大、空）一律 undefined，由调用方回 `{ok:false,...}`。
 *
 * 以前 `JSON.parse` 成功就返回：`"null"` 能穿过检查、随后在 `body.y` / `body.display`
 * 上取属性抛 TypeError，把宿主的 400 引出来 —— 两个 POST 路由的文档化错误码形同虚设。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_CAP) return undefined
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
}

/**
 * 掷一个点击分支。概率是**累积**的（声明顺序），所以命中判定要一路减下去。
 * 掷骰子放在宿主而不是前端：概率表属于 manifest，让它只有一个权威解释。
 *
 * 逐个跳过概率不合法的分支：`roll -= undefined` 会变 NaN，那之后**所有**分支都
 * 恒不命中（而 manifest 那边已经把坏分支挑走并记了 warning，这里只是第二道）。
 */
function rollBranch(zone) {
  let roll = Math.random()
  for (const branch of zone.branches ?? []) {
    const probability = branch.probability
    if (typeof probability !== 'number' || !(probability > 0)) continue
    if (roll < probability) return branch
    roll -= probability
  }
  return undefined
}

/**
 * 造出全部路由。
 *
 * @param deps.definition 宠物定义（manifest.js）
 * @param deps.displayOf  读当前 display 的函数
 * @param deps.onDisplay  写入 display 的函数（返回消毒后的值）
 * @param deps.stateOf    读当前相位快照的函数
 * @param deps.onTouch    掷中分支后的回调（用来触发一次性动作，可空）
 */
export function makeRoutes(deps) {
  const { definition, displayOf, onDisplay, stateOf } = deps

  // 计数器。不是给终端用户看的，是排查"宠物没出现"用的：它能一句话分开
  // 「浏览器半端根本没执行」（beacon 是 0）和「执行了但挂载失败」（beacon 有、pet 没有）。
  // 这两类的修法完全不同，靠猜要来回好几轮。
  const hits = { beacon: 0, pet: 0, state: 0, frame: 0, touch: 0, config: 0 }
  const startedAt = Date.now()

  const petRoute = {
    kind: 'exact',
    path: API_PREFIX + '/pet',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      hits.pet += 1
      sendJson(res, 200, {
        id: definition.id,
        displayName: definition.displayName,
        version: definition.version,
        idleTrack: definition.idleTrack,
        phases: definition.phases,
        tracks: definition.tracks,
        touch: definition.touch,
        display: displayOf(),
      })
    },
  }

  const stateRoute = {
    kind: 'exact',
    path: API_PREFIX + '/state',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      hits.state += 1
      const body = JSON.stringify(stateOf())
      const etag = jsonEtag(body)
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
        etag,
      })
      res.end(body)
    },
  }

  const touchRoute = {
    kind: 'exact',
    path: API_PREFIX + '/touch',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      hits.touch += 1
      // 前端报的是**归一化**的纵向位置（0..1，相对精灵盒），和 dsh-pet 一致。
      const y = Number(body.y)
      if (!Number.isFinite(y)) {
        sendJson(res, 400, { ok: false, error: 'bad-y' })
        return
      }
      // 分区是半开区间 [y0, y1)，所以 y 正好落在 1（精灵盒最下沿，或前端算出的
      // 1.0000001 这类浮点越界）会谁也匹配不上。夹进 [0, 1) 再查。
      const yn = y <= 0 ? 0 : y >= 1 ? 1 - 1e-9 : y
      const zone = definition.touch.find((entry) => yn >= entry.y0 && yn < entry.y1)
      if (zone === undefined) {
        sendJson(res, 200, { ok: true, hit: false })
        return
      }
      const branch = rollBranch(zone)
      if (branch === undefined) {
        sendJson(res, 200, { ok: true, hit: false })
        return
      }
      const phrase = Array.isArray(branch.phrases) && branch.phrases.length > 0
        ? branch.phrases[Math.floor(Math.random() * branch.phrases.length)]
        : undefined
      sendJson(res, 200, {
        ok: true,
        hit: true,
        zone: zone.name,
        state: branch.state,
        stateMs: branch.stateMs,
        // 台词这一批还不显示（气泡没做），但先回传，将来接台词系统时不用改协议。
        ...(phrase === undefined ? {} : { phrase }),
      })
    },
  }

  const configRoute = {
    kind: 'exact',
    path: API_PREFIX + '/config',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      // 只接受 display 块，且逐字段消毒 —— 前端送什么都不该把位置存成 NaN。
      hits.config += 1
      const next = sanitizeDisplay({ ...displayOf(), ...(body.display ?? {}) })
      onDisplay(next)
      sendJson(res, 200, { ok: true, display: next })
    },
  }

  const assetRoute = {
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://pet.local')
      let rel
      try {
        rel = decodeURIComponent(url.pathname.slice(ASSET_PREFIX.length + 1))
      } catch {
        res.writeHead(400).end()
        return
      }
      // 白名单之外一律 404 —— 集合是扫描期从磁盘列出来的，不含任何构造段。
      if (rel === '' || !definition.servable.has(rel)) {
        res.writeHead(404).end()
        return
      }
      const file = join(definition.petDir, rel)
      // realpath 包含性检查：白名单已经挡了构造段，这里再挡一层软链逃逸。
      try {
        const root = realpathSync(definition.petDir)
        const resolved = realpathSync(file)
        const relToRoot = relative(root, resolved)
        if (relToRoot.startsWith('..')) {
          res.writeHead(403).end()
          return
        }
      } catch {
        res.writeHead(404).end()
        return
      }
      void (async () => {
        try {
          const info = await stat(file)
          if (info.size > definition.imageCap) {
            res.writeHead(413).end()
            return
          }
          const etag = fileEtag(info)
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end()
            return
          }
          const body = await readFile(file)
          hits.frame += 1
          res.writeHead(200, {
            'content-type': mimeFor(file),
            'content-length': String(body.byteLength),
            // no-cache 而不是 immutable：帧图换素材后必须能立刻拿到新的，
            // 但 etag 让没换的帧仍然走 304。
            'cache-control': 'no-cache',
            etag,
          })
          if (req.method === 'HEAD') res.end()
          else res.end(body)
        } catch {
          res.writeHead(404).end()
        }
      })()
    },
  }

  /**
   * 排查用：浏览器半端到底有没有跑起来。
   * 带 `?client=1` 的请求只由浏览器半端在**模块执行时**发一次（见 lib/client.js 顶部）。
   * 所以 beacon=0 意味着它压根没进入浏览器；beacon 有而 pet=0 意味着进来了但挂载失败。
   */
  const diagnosticsRoute = {
    kind: 'exact',
    path: API_PREFIX + '/diagnostics',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://pet.local')
      if (url.searchParams.get('client') === '1') hits.beacon += 1
      sendJson(res, 200, {
        hits,
        uptimeMs: Date.now() - startedAt,
        tracks: Object.keys(definition.tracks).length,
        servable: definition.servable.size,
        // 这个响应绝不能进缓存：命中缓存的 beacon 不落到服务端，计数为 0，
        // 而 0 正是"浏览器半端没进页面"的判据。
      }, { 'cache-control': 'no-store' })
    },
  }

  return [petRoute, stateRoute, touchRoute, configRoute, diagnosticsRoute, assetRoute]
}
