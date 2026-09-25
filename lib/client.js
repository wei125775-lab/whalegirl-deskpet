/**
 * 浏览器半端：把鲸鱼娘画在页面右下角。
 *
 * 纯 DOM，**一个 React 都不引**。dsh-pet 那半端全靠 React + cordis slots，但它自己的
 * frames2d 渲染器其实与 React 零耦合（只吃一个容器 + 一个相位流），而 `inject` 里那
 * 七个服务全是给设置页和会话气泡跳转用的 —— 我们一个都不需要，所以 inject 是空的。
 * 顺带也就没有 react-dom 那个依赖风险了。
 *
 * 帧播放的逻辑（并发池 / 前瞻 / 插队 / 丢旧帧 / 看门狗）照 @linxin666/dsh-pet 的
 * src/client/renderers/frames2d.ts（Apache-2.0，见包内 NOTICE），去掉皮肤、游戏态、
 * 气泡那些分支。
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
      void fetch('/api/whalegirl/diagnostics?client=1').catch(() => {})
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

    const CSS = [
      // 容器是**无样式裸 div**，高度 0、永在文档流末尾，所以从不遮挡页面。
      // 真正显示的是它下面 position:fixed 的 .float —— 命中区域恰好等于精灵盒，
      // 这就是它不需要"整块穿透"的原因。
      '.wg-root{position:static}',
      '.wg-float{position:fixed;pointer-events:auto;user-select:none;-webkit-user-select:none;',
      'display:flex;align-items:center;justify-content:center;will-change:transform;contain:layout style}',
      '.wg-float.wg-dragging{cursor:grabbing}',
      '.wg-float canvas,.wg-float img{width:100%;height:100%;object-fit:contain;pointer-events:none;',
      'touch-action:none;-webkit-user-drag:none}',
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
      if (!response.ok) throw new Error(path + ' -> ' + response.status)
      return response.status === 304 ? undefined : await response.json()
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
      if (canvas === null) element.alt = ''
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
        // 非循环轨播完：回到 fallback（缺省是待机轨）。若回落目标正好是当前相位
        // 该播的那条，说明一次性动作结束了，把 override 放掉让相位重新接管。
        const target = entry.fallback ?? def.idleTrack
        if (target === def.track()) override = undefined
        play(target)
      }

      function play(trackId) {
        if (disposed) return
        if (def.tracks[trackId] === undefined) trackId = def.idleTrack
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

      return {
        /** 相位变了（或一次性动作要放开了）时调用。 */
        syncToPhase(trackId) {
          if (disposed) return
          if (override !== undefined) return
          if (trackId !== track) play(trackId)
        },
        /** 播一遍某个轨道（点击动作）。传 undefined 表示放开。 */
        setOverride(next, holdMs) {
          if (disposed) return
          if (next === undefined) {
            override = undefined
            const target = def.track()
            if (target !== track) play(target)
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

      let def = null
      let player = null
      let aspect = GUESS_ASPECT
      let display = { visible: true, size: 160, right: 24, bottom: 20 }
      let touchLockUntil = 0
      let releaseTimer

      const track = () => (def === null ? '' : def.track())

      const layout = () => {
        const width = Math.round(display.size * aspect)
        float.style.width = width + 'px'
        float.style.height = display.size + 'px'
        float.style.right = display.right + 'px'
        float.style.bottom = display.bottom + 'px'
        float.style.zIndex = '2147483000'
        float.style.display = display.visible ? 'flex' : 'none'
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

      const onPointerUp = () => {
        if (dragging === null) return
        const moved = draggedRef
        dragging = null
        float.classList.remove('wg-dragging')
        if (moved && dragPos !== null) void api('/api/whalegirl/config', { display }).catch(() => {})
      }

      function endDrag() {
        dragging = null
        float.classList.remove('wg-dragging')
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

      // ---- 拉定义 + 起播放器 ----
      let disposed = false

      void api('/api/whalegirl/pet').then((pet) => {
        if (disposed || pet === undefined) return
        def = {
          idleTrack: pet.idleTrack,
          phases: pet.phases,
          tracks: pet.tracks,
          touch: pet.touch,
          track,
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
      })

      // ---- 状态轮询 ----
      let stateSeq = 0
      const pollNow = () => {
        const seq = stateSeq + 1
        stateSeq = seq
        void api('/api/whalegirl/state').then((next) => {
          if (disposed || seq !== stateSeq || next === undefined) return
          state = next
          if (next.display !== undefined) {
            // 只要不是在拖拽中，就跟随服务端的位置（拖完那次写回也会走这里）。
            if (dragging === null) {
              display = { ...display, ...next.display }
              layout()
            }
          }
          if (player !== null && typeof next.track === 'string') player.syncToPhase(next.track)
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
        if (releaseTimer !== undefined) clearTimeout(releaseTimer)
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
