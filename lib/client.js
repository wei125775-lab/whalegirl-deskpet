/**
 * 浏览器半端：把鲸鱼娘画在页面右下角。
 *
 * 纯 DOM，**一个 React 都不引**。dsh-pet 那半端全靠 React + cordis slots，但它自己的
 * frames2d 渲染器其实与 React 零耦合（只吃一个容器 + 一个相位流），而 `inject` 里那
 * 七个服务全是给设置页和会话气泡跳转用的 —— 我们一个都不需要，所以 inject 是空的。
 * 顺带也就没有 react-dom 那个依赖风险了。
 *
 * 帧播放的逻辑（并发池 / 前瞻 / 插队 / 丢旧帧 / 看门狗）照 @linxin666/dsh-pet 的
 * src/client/renderers/frames2d.ts（Apache-2.0，见包内 NOTICE），去掉皮肤、游戏态
 * 那些分支。气泡原先也一并去掉了，2026-09-27 按同一份包的气泡规格（pet.module.css
 * 的 .bubble）补了回来 —— 台词由服务端选好随 `/state` 下发，前端只负责画。
 *
 * 协议：`window.__ModuleLoader__.load({id, factory})`，factory 返回 exports，
 * 末尾必须 `return module.exports`（少了它前端会拿到 undefined 并报
 * "invalid plugin ... received undefined"）。
 */

window.__ModuleLoader__.load({
  id: '@wei125775-lab/whalegirl-deskpet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 排查用的一次性信标：在**模块执行时**就发，早于 apply。服务端的 /diagnostics
    // 靠它区分「这个 bundle 压根没进浏览器」和「进来了但挂载失败」—— 这两类的修法
    // 完全不同，而"宠物没出现"本身对这两种情况长得一模一样。
    try {
      // 必须 no-store：命中缓存时不发请求，服务端 beacon 就是 0，而 README 拿
      // 「beacon: 0」当"浏览器半端压根没进页面"的判据 —— 不能让诊断自己骗人。
      void fetch('/api/whalegirl/diagnostics?client=1', { cache: 'no-store' }).catch(() => {})
    } catch { /* 拿不到就算了，不影响插件本体 */ }

    /** 状态轮询间隔。dsh-pet 用 2000ms，这里压到 400ms 换取跟手；
     *  状态没变服务端回 304 空 body，所以空轮询几乎不花流量。 */
    const POLL_MS = 400

    /** 帧解码并发上限。整库一次性预热会撞浏览器的 in-flight 上限并拉满内存。 */
    const FRAME_POOL_LIMIT = 8

    /** 前瞻窗口：只解码"马上要播到的"那几帧。 */
    const PREFETCH_AHEAD = 12

    /** 看门狗：后台标签页被节流后 setTimeout 链会死掉，超时了就补一脚。 */
    const WATCHDOG_MS = 1200

    /** 拖拽判定阈值：位移超过它才算拖，否则算点击。 */
    const DRAG_SLOP = 4

    /** 认不出帧尺寸时的初始宽高比（512×683），拿到真帧后立刻纠正。 */
    const GUESS_ASPECT = 0.75

    const STYLE_ID = 'whalegirl-pet-style'

    /** 点击反馈的那句话占住气泡多久（照 dsh-pet 的 feedback 时长）。 */
    const FEEDBACK_MS = 2600

    /** 滚轮缩放的规格，照 Claude 版（`viewer/src/main.ts` 的 `applyZoom`）。 */
    const ZOOM_MIN = 0.5
    const ZOOM_MAX = 2
    const ZOOM_STEP = 1.08
    const WHEEL_THRESHOLD = 40    // 滚轮 deltaY 累积到这个数才走一档
    const WHEEL_RESET_MS = 300    // 停这么久就重新开始累积
    const WHEEL_GUARD_MS = 250    // 刚在她身上松过手，这段时间内不缩放（防误触）
    const ZOOM_PERSIST_MS = 400   // 落库防抖：滚轮是一串连续事件，不能每次都发请求
    const ZOOM_HOLD_MS = 1500     // 改完这段时间内不跟随服务端下发的大小（否则会被旧值弹回去）
    const BASE_SIZE = 160         // 默认大小，和服务端 `DEFAULT_DISPLAY.size` 一致

    const CSS = [
      // 容器是**无样式裸 div**，高度 0、永在文档流末尾，所以从不遮挡页面。
      // 真正显示的是它下面 position:fixed 的 .float —— 命中区域恰好等于精灵盒，
      // 这就是它不需要"整块穿透"的原因。
      '.wg-root{position:static}',
      // 气泡要挂在这个盒子上（bottom:100%），而 `position:fixed` 的元素**本身就是**
      // absolute 后代的包含块，所以这里不用再补 position:relative —— 补了反而会把
      // fixed 覆盖掉，整个客体的定位方式就变了。
      '.wg-float{position:fixed;pointer-events:auto;user-select:none;-webkit-user-select:none;',
      'display:flex;align-items:center;justify-content:center;will-change:transform;contain:layout style}',
      '.wg-float.wg-dragging{cursor:grabbing}',
      '.wg-float canvas,.wg-float img{width:100%;height:100%;object-fit:contain;pointer-events:none;',
      'touch-action:none;-webkit-user-drag:none}',
      // 气泡：绝对定位在精灵盒正上方（bottom:100% —— 跟着盒子走，缩放/换动作都不会跑偏），
      // 水平居中。**pointer-events:none**：它永远不能挡住点击，那是她的脸。
      // 单行不换行 + 超长省略号，照着 dsh-pet 的气泡规格来。
      '.wg-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:6px;',
      'pointer-events:none;white-space:nowrap;max-width:min(280px,calc(100vw - 24px));',
      'overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:1.4;padding:5px 12px;',
      'border-radius:999px;color:#f4f7ff;letter-spacing:.02em;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
      'background:linear-gradient(160deg,rgba(19,28,54,.9),rgba(7,11,26,.94));',
      'border:1px solid rgba(126,152,255,.45);backdrop-filter:blur(8px);',
      'box-shadow:0 2px 10px rgba(0,0,0,.35),0 0 12px rgba(77,107,254,.18)}',
      '.wg-bubble.wg-whisper{letter-spacing:.03em}',
      '.wg-bubble.wg-hidden{display:none}',
      '.wg-bubble.wg-in{animation:wg-bubble-in 240ms ease-out}',
      '@keyframes wg-bubble-in{from{opacity:0;transform:translateX(-50%) translateY(6px) scale(.96)}',
      'to{opacity:1;transform:translateX(-50%) scale(1)}}',
      '@media (prefers-reduced-motion: reduce){.wg-bubble.wg-in{animation:none}}',
    ].join('')

    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, body) {
      const response = await fetch(path, body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      // 304 要先判：它不属于 ok（2xx），原来那句 `if (!response.ok) throw` 排在前面，
      // 于是"状态没变"和"请求出错"在调用点被混成一类 —— 以后谁在 catch 里加打点或重试，
      // 每次空轮询都会被记成错误。
      if (response.status === 304) return undefined
      if (!response.ok) throw new Error(path + ' -> ' + response.status)
      return await response.json()
    }

    /**
     * frames2d 播放器。一个 canvas + 一条 setTimeout 链。
     *
     * 每帧用它**自己的**时长（durations[i]），不是累积时间戳 —— 这样每帧精确，
     * 代价是不做掉帧追赶（dsh-pet 也是这个取舍）。
     */
    function createPlayer(container, def) {
      let disposed = false
      let timer
      let watchdog
      let track = def.idleTrack
      let frameIndex = 0
      let lastAdvance = Date.now()
      let override
      let drawToken = 0
      let lastDrawnUrl
      /** 本次（同一个 seq）里已经认过的**一次性**轨（见 follow）。 */
      let honoredTrack
      /** 上次跟随的"新一次"判据：优先用服务端的相位序号，拿不到才退回相位名。 */
      let syncedKey
      /** 本次退场链上已经放过的轨（防 transitions 里 A→B→A 来回）。 */
      let chain = []

      const decoding = new Map()
      const pending = []
      let active = 0

      let canvas = null
      let ctx2d = null
      let img = null
      try {
        if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
          const probe = document.createElement('canvas')
          const got = probe.getContext('2d')
          if (got !== null) {
            canvas = probe
            ctx2d = got
          }
        }
      } catch {
        canvas = null
        ctx2d = null
      }
      const element = canvas !== null ? canvas : document.createElement('img')
      if (canvas === null) {
        // img 兜底这条路以前是死的：`img` 永远是 null，show() 里那个分支进不去，
        // 而 paint() 又因为 canvas 是 null 直接 return —— 没有 canvas 就什么都不画。
        img = element
        img.alt = ''
        img.addEventListener('load', () => {
          if (img.naturalWidth > 0 && typeof def.onFrameSize === 'function') {
            def.onFrameSize(img.naturalWidth, img.naturalHeight)
          }
        })
      }
      element.draggable = false
      container.appendChild(element)

      const decode = async (url) => {
        try {
          const response = await fetch(url)
          if (!response.ok) throw new Error('http ' + response.status)
          const bitmap = await createImageBitmap(await response.blob())
          return { source: bitmap, width: bitmap.width, height: bitmap.height }
        } catch {
          // 退回经典 Image 解码，老运行时也能跑。
          return await new Promise((resolve) => {
            try {
              const pre = new Image()
              pre.onload = () => resolve(pre.naturalWidth > 0 ? { source: pre, width: pre.naturalWidth, height: pre.naturalHeight } : undefined)
              pre.onerror = () => resolve(undefined)
              pre.src = url
            } catch {
              resolve(undefined)
            }
          })
        }
      }

      const pump = () => {
        while (active < FRAME_POOL_LIMIT && pending.length > 0) {
          const queued = pending.shift()
          active += 1
          queued.release()
        }
      }

      const load = (url, jump = false) => {
        const cached = decoding.get(url)
        if (cached !== undefined) return cached
        let release
        const gate = new Promise((resolve) => { release = resolve })
        const job = gate.then(() => (disposed ? undefined : decode(url)))
        job.then((frame) => { if (frame === undefined) decoding.delete(url) }, () => decoding.delete(url))
        void job.finally(() => {
          active -= 1
          pump()
        })
        decoding.set(url, job)
        const entry = { url, release }
        if (jump) pending.unshift(entry)
        else pending.push(entry)
        pump()
        return job
      }

      const prefetchAhead = (trackId, index) => {
        const entry = def.tracks[trackId]
        if (entry === undefined) return
        const end = Math.min(entry.frames.length, index + 1 + PREFETCH_AHEAD)
        for (let ahead = index + 1; ahead < end; ahead += 1) void load(entry.frames[ahead])
      }

      const paint = (url) => {
        if (ctx2d === null || canvas === null) return
        const myToken = ++drawToken
        void load(url, true).then((frame) => {
          if (disposed || frame === undefined || myToken !== drawToken) return
          if (lastDrawnUrl === url) return
          lastDrawnUrl = url
          if (canvas.width !== frame.width || canvas.height !== frame.height) {
            canvas.width = frame.width
            canvas.height = frame.height
            if (typeof def.onFrameSize === 'function') def.onFrameSize(frame.width, frame.height)
          } else {
            ctx2d.clearRect(0, 0, canvas.width, canvas.height)
          }
          ctx2d.drawImage(frame.source, 0, 0)
        }).catch(() => { /* 保住上一帧 */ })
      }

      const show = (trackId, index) => {
        const entry = def.tracks[trackId]
        const url = entry?.frames[index]
        if (url === undefined) return
        prefetchAhead(trackId, index)
        if (img !== null) {
          if (img.getAttribute('src') !== url) img.src = url
          return
        }
        paint(url)
      }

      const schedule = (ms) => {
        if (disposed) return
        timer = setTimeout(tick, ms)
      }

      function tick() {
        if (disposed) return
        const entry = def.tracks[track]
        if (entry === undefined || entry.frames.length === 0) return
        lastAdvance = Date.now()
        const next = frameIndex + 1
        if (next < entry.frames.length) {
          frameIndex = next
          show(track, frameIndex)
          schedule(entry.durations[frameIndex] ?? 200)
          return
        }
        if (entry.loop) {
          frameIndex = 0
          show(track, frameIndex)
          schedule(entry.durations[0] ?? 200)
          return
        }
        // 非循环轨播完。先看它有没有声明动作链（`transitions.json`）：有就按权重掷
        // 下一个动作 —— 收碗之后接摸头/祝福/待机那套。**只在相位驱动时掷**，点击动作
        // 有 override 和释放定时器，插进来两边会打架。
        if (override === undefined && entry.transitions !== undefined) {
          const pick = rollTransition(entry.transitions)
          if (pick !== undefined && !chain.includes(pick)) {
            chain.push(track)
            play(pick, true)
            return
          }
        }
        // 没链可走：回到 fallback（缺省是待机轨）。若回落目标正好是当前相位该播的
        // 那条，说明一次性动作结束了，把 override 放掉让相位重新接管。
        const target = entry.fallback ?? def.idleTrack
        if (target === def.track()) override = undefined
        play(target)
      }

      /**
       * 按权重掷一个下一动作。`transitions` 是 {目标轨: 权重}（不是概率，不要求和为 1），
       * 声明顺序即累计顺序；不在 def 里的目标、非正数的权重都跳过。
       */
      const rollTransition = (transitions) => {
        const entries = Object.entries(transitions)
          .filter(([name, weight]) => def.tracks[name] !== undefined && typeof weight === 'number' && weight > 0)
        const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
        if (total <= 0) return undefined
        let roll = Math.random() * total
        for (const [name, weight] of entries) {
          roll -= weight
          if (roll < 0) return name
        }
        return entries[entries.length - 1][0]
      }

      /** fromChain 是内部参数：走动作链进新轨时不要把链清掉。 */
      function play(trackId, fromChain) {
        if (disposed) return
        if (def.tracks[trackId] === undefined) trackId = def.idleTrack
        if (fromChain !== true) chain = []
        if (timer !== undefined) clearTimeout(timer)
        track = trackId
        frameIndex = 0
        lastAdvance = Date.now()
        show(track, frameIndex)
        schedule(def.tracks[track].durations[0] ?? 200)
      }

      watchdog = setInterval(() => {
        if (disposed) return
        const entry = def.tracks[track]
        if (entry === undefined || !entry.loop) return
        const expected = (entry.durations[frameIndex] ?? 200) + WATCHDOG_MS
        if (Date.now() - lastAdvance > expected) tick()
      }, WATCHDOG_MS)

      play(def.idleTrack)

      /**
       * 跟随服务端说该播的那条轨。
       *
       * **一次性轨（loop:false）在同一相位里只认一次。** 它播完会按 fallback 自己落回
       * 待机，而服务端在这个相位里还会继续说"该播它"——400ms 一次的轮询于是把收碗一遍遍
       * 重播。相位换了才算新的一次（由 syncToPhase 重置）。
       * 循环轨不设这道闸：点击插进来之后她落回的是待机，那口饭得追回来。
       */
      const follow = (trackId) => {
        if (def.tracks[trackId] === undefined) trackId = def.idleTrack
        if (def.tracks[trackId].loop === false) {
          if (trackId === honoredTrack) return
          honoredTrack = trackId
        }
        if (trackId !== track) play(trackId)
      }

      return {
        /**
         * 相位（或服务端让播的轨）变了时调用。
         *
         * "新的一次动作"用服务端的 **`seq`** 判，不看相位名：done/failed 允许重复提交
         * （重新计时），相位名不变时只看名字会把第二次的一次性动作（第二次收碗）
         * 静默吞掉 —— 触发条件是客户端错过了中间那些相位（窗口最小化时它不轮询）。
         * 服务端没给 seq（旧部署）才退回相位名。
         */
        syncToPhase(trackId, phase, seq) {
          if (disposed) return
          if (override !== undefined) return
          const key = typeof seq === 'number' ? 's' + seq : 'p' + String(phase)
          if (key !== syncedKey) {
            syncedKey = key
            honoredTrack = undefined
          }
          follow(trackId)
        },
        /** 播一遍某个轨道（点击动作）。传 undefined 表示放开。 */
        setOverride(next, holdMs) {
          if (disposed) return
          if (next === undefined) {
            override = undefined
            follow(def.track())
            return
          }
          if (def.tracks[next] === undefined) return
          override = next
          if (next !== track) play(next)
          return holdMs
        },
        currentTrack: () => track,
        dispose() {
          if (disposed) return
          disposed = true
          if (timer !== undefined) clearTimeout(timer)
          if (watchdog !== undefined) clearInterval(watchdog)
          for (const queued of pending.splice(0)) queued.release()
          void Promise.allSettled([...decoding.values()]).then(() => {
            for (const job of decoding.values()) {
              void job.then((frame) => {
                const close = frame?.source?.close
                if (frame !== undefined && typeof close === 'function') {
                  try { close.call(frame.source) } catch { /* 已释放 */ }
                }
              }).catch(() => {})
            }
            decoding.clear()
          })
          element.remove()
        },
      }
    }

    function apply(ctx) {
      let state
      let cleanupDom = () => {}
      try {
        cleanupDom = mount(ctx)
      } catch (error) {
        console.error('[whalegirl-pet] 挂载失败：', error)
      }
      ctx.effect(() => () => {
        try { cleanupDom() } catch { /* 卸载路径不抛 */ }
      })
    }

    function mount(ctx) {
      injectStyle()

      // 清掉上一次挂载残留（热重载会留下孤儿节点）。
      for (const stale of Array.from(document.querySelectorAll('.wg-root'))) stale.remove()

      const root = document.createElement('div')
      root.className = 'wg-root'
      document.body.appendChild(root)

      const float = document.createElement('div')
      float.className = 'wg-float'
      root.appendChild(float)

      // 气泡挂在 float 里、绝对定位到它正上方 —— 跟着精灵盒走，缩放和换动作都不会跑偏。
      const bubble = document.createElement('div')
      bubble.className = 'wg-bubble wg-hidden'
      float.appendChild(bubble)

      let def = null
      let player = null
      let aspect = GUESS_ASPECT
      let display = { visible: true, size: 160, right: 24, bottom: 20 }
      let touchLockUntil = 0
      let releaseTimer

      /**
       * 现在该播哪条轨 —— **以最近一次轮询回来的 state 为准**。
       * 曾经写成 `def.track()`，而 def 上的 track 正是这个函数自己，一调就无限递归：
       * 每次点击动作播完（非循环轨走 fallback 分支）都抛 RangeError，卡在最后一帧。
       */
      const currentTrack = () => (
        state !== undefined && typeof state.track === 'string'
          ? state.track
          : (def === null ? '' : def.idleTrack)
      )

      const layout = () => {
        const width = Math.round(display.size * aspect)
        float.style.width = width + 'px'
        float.style.height = display.size + 'px'
        float.style.right = display.right + 'px'
        float.style.bottom = display.bottom + 'px'
        float.style.zIndex = '2147483000'
        float.style.display = display.visible ? 'flex' : 'none'
      }

      // ---- 气泡 ----
      /**
       * 现在显示的是哪一句。判据一样就不重画、也就不重播入场动画。
       *
       * **用服务端给的 `say.id` 当判据，不比文本**：同一句话隔了几轮又出现时（比如连着两次
       * "捞上来了。"），比文本会漏掉一次重播；id 是服务端按"最终显示出来的那句"发的，
       * 变了就是新的一句。
       *
       * 点击反馈用它自己的 key（`fb:`）暂时占住气泡，2.6 秒后这次轮询就把它让回状态句。
       * 没有定时器 —— 收起是在轮询里按时间戳判的，和这个文件其它地方一个路子。
       */
      let bubbleKey = ''
      let feedback

      const paintBubble = (key, text, whisper) => {
        if (key === bubbleKey) return
        bubbleKey = key
        // 碎碎念用「」括起来 —— 和 web 版一样，一眼能分出"这是顺口念叨"还是"在报状态"。
        bubble.textContent = whisper ? '「' + text + '」' : text
        bubble.classList.toggle('wg-whisper', whisper)
        bubble.classList.remove('wg-hidden')
        // 重播入场动画：先摘 class、强制一次重排，再挂回去。
        bubble.classList.remove('wg-in')
        void bubble.offsetWidth
        bubble.classList.add('wg-in')
      }

      const hideBubble = () => {
        if (bubbleKey === '') return
        bubbleKey = ''
        bubble.classList.add('wg-hidden')
      }

      const syncBubble = () => {
        if (feedback !== undefined && Date.now() < feedback.until) {
          paintBubble('fb:' + feedback.text, feedback.text, false)
          return
        }
        feedback = undefined
        const say = state === undefined ? null : state.say
        // 服务端说 `null`（待机、或做完 2.4 秒之后）就是不说话。
        if (say === null || say === undefined) {
          hideBubble()
          return
        }
        paintBubble('say:' + say.id, say.text, say.kind === 'whisper')
      }

      // ---- 滚轮缩放 ----
      /**
       * 规格照 Claude 版（`viewer/src/main.ts` 的 `applyZoom`）：每档 ×1.08、范围 0.5~2 倍、
       * 滚轮 deltaY 累积够 40 才走一档、停 300ms 重新累积、双击回默认、Ctrl+滚轮放过。
       *
       * 两处额外的保护：
       * - `WHEEL_GUARD_MS`：刚在她身上松过手（多半是拖拽）就不响应滚轮，免得拖完手一抖把她缩了。
       * - `ZOOM_HOLD_MS`：改完到落库成功之间有个窗口，而 `/state` 每轮都在下发服务端的
       *   display。不挡一下的话本地刚放大、下一轮就被旧值改回去 —— 表现是"滚一下弹回去"。
       *   拖拽那边靠 `dragging !== null` 挡，缩放没有这个状态，所以用时间戳。
       */
      let wheelAccum = 0
      let wheelLastTs = 0
      let lastPointerUp = 0
      let zoomHoldUntil = 0
      let zoomTimer

      const persistZoom = () => {
        zoomTimer = undefined
        void api('/api/whalegirl/config', { display }).catch((error) => {
          console.warn('[whalegirl-pet] 大小没存上（下一轮会被服务端的旧值改回去）：', error)
        })
      }

      const schedulePersistZoom = () => {
        zoomHoldUntil = Date.now() + ZOOM_HOLD_MS
        if (zoomTimer !== undefined) clearTimeout(zoomTimer)
        zoomTimer = window.setTimeout(persistZoom, ZOOM_PERSIST_MS)
      }

      /**
       * 换一个大小，同时把 `right` / `bottom` 让出一半的差值 —— **让盒子的中心不动**。
       * 只改 size 的话，因为是靠右下角定位的，她会一直往左上角长（Claude 版是围绕中心缩的）。
       */
      const resizeTo = (next) => {
        const delta = display.size - next
        display = {
          ...display,
          size: next,
          right: Math.max(0, Math.round(display.right + (delta * aspect) / 2)),
          bottom: Math.max(0, Math.round(display.bottom + delta / 2)),
        }
        layout()
        schedulePersistZoom()
      }

      const applyZoom = (factor) => {
        const next = Math.round(
          Math.min(BASE_SIZE * ZOOM_MAX, Math.max(BASE_SIZE * ZOOM_MIN, display.size * factor)),
        )
        if (next === display.size) {
          // 到边界给个反馈。静默钳制最让人困惑 —— 继续滚什么都没发生，会以为坏了。
          feedback = {
            text: next >= BASE_SIZE * ZOOM_MAX ? '已经最大啦～' : '已经最小啦～',
            until: Date.now() + FEEDBACK_MS,
          }
          syncBubble()
          return
        }
        resizeTo(next)
      }

      const onWheel = (e) => {
        if (e.ctrlKey) return    // Ctrl+滚轮是页面缩放，放过
        if (Date.now() - lastPointerUp < WHEEL_GUARD_MS) return
        e.preventDefault()
        const now = Date.now()
        if (now - wheelLastTs > WHEEL_RESET_MS) wheelAccum = 0
        wheelLastTs = now
        wheelAccum += e.deltaY
        while (Math.abs(wheelAccum) >= WHEEL_THRESHOLD) {
          applyZoom(wheelAccum < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
          wheelAccum -= Math.sign(wheelAccum) * WHEEL_THRESHOLD
        }
      }

      // 双击回默认大小（照 Claude 版）。双击必然先触发两次 click，她会连做两个点击动作
      // —— 那边也是这个行为，保持一致。
      const onDoubleClick = (e) => {
        e.preventDefault()
        if (display.size !== BASE_SIZE) resizeTo(BASE_SIZE)
      }

      // ---- 拖拽 ----
      let dragging = null
      let draggedRef = false
      let dragPos = null

      const clampOffset = (value, max) => Math.max(0, Math.min(max, value))

      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return
        endDrag()
        e.preventDefault()
        e.target.setPointerCapture?.(e.pointerId)
        dragging = { startX: e.clientX, startY: e.clientY, right: display.right, bottom: display.bottom }
        draggedRef = false
        dragPos = null
      }

      const onPointerMove = (e) => {
        if (dragging === null) return
        const dx = e.clientX - dragging.startX
        const dy = e.clientY - dragging.startY
        if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) {
          draggedRef = true
          float.classList.add('wg-dragging')
        }
        if (!draggedRef) return
        // 拖拽时按精灵尺寸夹取，别只留 40px —— dsh-pet 那个硬编码会让宠物被拖出屏幕一截。
        dragPos = {
          right: clampOffset(dragging.right - dx, Math.max(0, window.innerWidth - float.offsetWidth)),
          bottom: clampOffset(dragging.bottom - dy, Math.max(0, window.innerHeight - float.offsetHeight)),
        }
        display = { ...display, ...dragPos }
        layout()
      }

      /**
       * 落库拖拽后的位置。
       *
       * 失败**不能静默吞**：写不进去的话下一轮轮询会拿服务端的旧位置把她拽回去，
       * 用户看到的是"拖了没用"，而日志里一个字都没有。
       */
      const persistDrag = () => {
        if (dragPos === null) return
        void api('/api/whalegirl/config', { display }).catch((error) => {
          console.warn('[whalegirl-pet] 位置没存上（下一轮会被服务端的旧位置拽回去）：', error)
        })
        dragPos = null
      }

      const onPointerUp = () => {
        lastPointerUp = Date.now()   // 滚轮缩放的防误触判据：刚从她身上松手
        if (dragging === null) return
        const moved = draggedRef
        dragging = null
        float.classList.remove('wg-dragging')
        if (moved) persistDrag()
      }

      /**
       * pointercancel（触摸被系统抢走、设备切换、原生菜单弹出）也要落库：
       * 以前只清状态，DOM 和 display 已经是新位置而服务端不知道 —— 下一轮悄悄撤回，
       * 而且 `draggedRef` 还留在 true 上，会白白吞掉下一次点击。
       */
      function endDrag() {
        if (dragging === null && dragPos === null) return
        const moved = draggedRef
        dragging = null
        draggedRef = false
        float.classList.remove('wg-dragging')
        if (moved) persistDrag()
      }

      // ---- 点击 ----
      const onActivate = (e) => {
        // 拖完尾随的那个 click 不算点击（dsh-pet 也是这么防的）。
        if (draggedRef) {
          draggedRef = false
          return
        }
        const rect = float.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        const y = (e.clientY - rect.top) / rect.height
        if (Date.now() < touchLockUntil) return
        void api('/api/whalegirl/touch', { y }).then((result) => {
          if (result === undefined || result.hit !== true || player === null) return
          const holdMs = Number.isFinite(result.stateMs) ? result.stateMs : 3000
          touchLockUntil = Date.now() + holdMs
          player.setOverride(result.state, holdMs)
          if (typeof result.phrase === 'string' && result.phrase !== '') {
            // 点击的台词服务端一直在回传（`/touch` 的 phrase），此前没人显示它。
            feedback = { text: result.phrase, until: Date.now() + FEEDBACK_MS }
            syncBubble()
          }
          if (releaseTimer !== undefined) clearTimeout(releaseTimer)
          releaseTimer = window.setTimeout(() => {
            // 条件释放：这期间又点了一次的话 touchLockUntil 已经被推远，旧定时器不许放。
            if (Date.now() >= touchLockUntil && player !== null) player.setOverride(undefined)
          }, holdMs)
        }).catch(() => {})
      }

      float.addEventListener('pointerdown', onPointerDown)
      float.addEventListener('pointermove', onPointerMove)
      float.addEventListener('pointerup', onPointerUp)
      float.addEventListener('pointercancel', endDrag)
      float.addEventListener('click', onActivate)
      // passive:false 是必需的 —— 要在里面 preventDefault，不然滚轮会连带把页面滚了。
      float.addEventListener('wheel', onWheel, { passive: false })
      float.addEventListener('dblclick', onDoubleClick)

      // ---- 拉定义 + 起播放器 ----
      let disposed = false

      /**
       * 拉宠物定义。**失败要重试，不能只取一次**：宿主的路由注册、启动抖动、
       * 一次 500 都会让这一发失败，而 `player` 就此永远是 null —— 表现是"她压根没出现、
       * 只能重开应用"，/diagnostics 还会把它误判成"进来了但挂载失败"（beacon 已经计过数）。
       * 重试次数有限，失败时把原因留在 console 里。
       */
      let petTries = 0
      let petRetryTimer
      const loadPet = () => {
        void api('/api/whalegirl/pet').then((pet) => {
          if (disposed) return
          if (pet === undefined || pet === null || typeof pet.tracks !== 'object' || pet.tracks === null) {
            throw new Error('宠物定义不完整（没有 tracks）')
          }
          def = {
            idleTrack: pet.idleTrack,
            phases: pet.phases,
            tracks: pet.tracks,
            touch: pet.touch,
            track: currentTrack,
            onFrameSize(width, height) {
              if (width > 0 && height > 0) {
                aspect = width / height
                layout()
              }
            },
          }
          display = { ...display, ...(pet.display ?? {}) }
          layout()
          player = createPlayer(float, def)
        }).catch((error) => {
          console.error('[whalegirl-pet] 取宠物定义失败：', error)
          if (disposed || petTries >= 5) return
          petTries += 1
          petRetryTimer = window.setTimeout(loadPet, 800 * petTries)
        })
      }
      loadPet()

      // ---- 状态轮询 ----
      let stateSeq = 0
      const pollNow = () => {
        const seq = stateSeq + 1
        stateSeq = seq
        void api('/api/whalegirl/state').then((next) => {
          if (disposed || seq !== stateSeq) return
          if (next !== undefined) {
            state = next
            if (next.display !== undefined) {
              // 跟随服务端下发的位置/大小 —— 但拖拽中和刚缩放的独占期里不跟（见 ZOOM_HOLD_MS）。
              if (dragging === null && Date.now() >= zoomHoldUntil) {
                display = { ...display, ...next.display }
                layout()
              }
            }
            if (player !== null && typeof next.track === 'string') player.syncToPhase(next.track, next.phase, next.seq)
          }
          // **304 也要走这一趟。** 服务端对没变的状态回 304（这里拿到 undefined），
          // 而点击反馈气泡是"到点自己让位"的 —— 只在新状态到达时才同步的话，
          // 她一句话不说的时候反馈气泡就永远挂着不收了。
          syncBubble()
        }).catch(() => { /* 下个 tick 再试 */ })
      }

      let pollTimer
      const stopPoll = () => {
        if (pollTimer !== undefined) {
          window.clearInterval(pollTimer)
          pollTimer = undefined
        }
      }
      const startPoll = () => {
        if (pollTimer === undefined && document.visibilityState === 'visible') {
          pollTimer = window.setInterval(pollNow, POLL_MS)
        }
      }
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          pollNow()
          startPoll()
        } else {
          stopPoll()
        }
      }
      startPoll()
      pollNow()
      document.addEventListener('visibilitychange', onVisibility)

      return () => {
        disposed = true
        stopPoll()
        document.removeEventListener('visibilitychange', onVisibility)
        float.removeEventListener('pointerdown', onPointerDown)
        float.removeEventListener('pointermove', onPointerMove)
        float.removeEventListener('pointerup', onPointerUp)
        float.removeEventListener('pointercancel', endDrag)
        float.removeEventListener('click', onActivate)
        float.removeEventListener('wheel', onWheel)
        float.removeEventListener('dblclick', onDoubleClick)
        if (zoomTimer !== undefined) clearTimeout(zoomTimer)
        if (releaseTimer !== undefined) clearTimeout(releaseTimer)
        if (petRetryTimer !== undefined) clearTimeout(petRetryTimer)
        if (player !== null) player.dispose()
        root.remove()
      }
    }

    exports.apply = apply
    // 宠物渲染一个服务都不需要（dsh-pet 那七个是给设置页和会话气泡用的）。
    exports.inject = []
    return module.exports
  },
})
