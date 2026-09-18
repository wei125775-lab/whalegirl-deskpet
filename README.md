# 鲸鱼娘桌宠

![鲸鱼娘桌宠](docs/preview/hero.png)

一只会跟着你干活的鲸鱼娘桌宠，同一个角色的两个平台版本：**Claude Code（PetPet 桌宠）** 和 **dsh（DshDesktop）**。

她不是那种只会原地晃两下的桌宠 —— 你发消息她捧着碗一口一口吃，这一轮干完她收碗，偶尔双手合十给你祝福，你按 Esc 打断她，她会停下手里的事甩你一个屑表情，点她会挥手/比心。

**English**: a desktop pet that reacts to your AI coding session. Same character, two builds: **Claude Code** ([PetPet](https://github.com/stshourenxy-dev/petpet-playbook)) and **dsh**. She eats from a bowl while you work, puts it away when the turn ends, and gives you a smug look if you hit Esc to interrupt. On **Windows** you can grab the [green build](https://github.com/wei125775-lab/whalegirl-deskpet/releases/latest), unzip it and double-click `启动.cmd`.

![她在 Claude Code 上干活的样子](docs/preview/scene.png)

*实拍：左边是 Claude Code 正在跑任务，右边就是她——干活期间一直端着碗吃，气泡是她自己弹的。*

![她会做什么](docs/preview/actions.png)

*上图是她的十个动作，全部实拍自宠物素材。*

## 她什么时候做什么

| 你做什么 | Claude Code 版 | dsh 版 |
|---|---|---|
| 你发消息 / 模型开始干活 | 捧着碗吃（循环）；**10% 的轮次换成端着中碗、拿筷子正经吃一顿** | 捧着碗吃（循环，全程一条轨道，见坑五） |
| 这一轮结束 | 收碗 → 55% 托腮发呆 / **10% 双手合十祝福** / 35% 待机 | 收碗 → 待机 |
| **按 Esc 打断她** | 立刻停下手里的动作，甩你一个屑表情 | 工具失败/本轮出错时同样甩屑表情 |
| 点她 | 挥手（**8% 换成屑表情**） | 57% 挥手 / 20% 托腮 / 15% 比心 / **8% 屑表情** |
| **起子代理** | 收碗 → 脚边游出一只小海豚转圈 → 跑完沉下去 | 同左（**靠打补丁，见「看鲸鱼」一节**） |
| 什么都不做 | 老实待机——长发和尾巴轻轻晃，偶尔眨眼 | 同左 |

![待机时她就长这样](docs/preview/idle.gif)

*上面这段就是宠物里真实的待机循环（24 帧 @12fps）：呼吸、飘发、眨眼都是程序化烘焙的，不是抽帧——AI 画不出这种幅度的小动作。其余动作由 AI 视频转序列帧、再逐帧抠像配准，工具链在 [whalegirl-pet-kit](https://github.com/wei125775-lab/whalegirl-pet-kit)。*

## 装

**最省事：下 [绿色版](https://github.com/wei125775-lab/whalegirl-deskpet/releases/latest)** —— Windows x64，解压后双击 `启动.cmd` 就有她。不用装 Node、不用 clone 源码、不用编译。代价是包大（200MB，整个 Electron 运行时都在里面）。

绿色版就是下面「Claude Code 版」预先构建好的成品；想自己构建，或者要用 dsh 版，走这两条：

| 版本 | 给谁用 | 怎么装 |
|---|---|---|
| **Claude Code 版** | [PetPet](https://github.com/stshourenxy-dev/petpet-playbook) 桌宠，跟 Claude Code 联动的那只 | `node claude/install.mjs` → 按它打印的收尾。详见 [`claude/README.md`](claude/README.md) |
| **dsh 版** | [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（桌面外壳 DshDesktop）里那只 | 双击根目录的 `install.cmd`（或 `node install.mjs`）→ 重启 dsh |

两个安装脚本都是**幂等**的：会自己找/下依赖，改配置前先备份，重复跑不会出问题；都能加 `--dry-run` 先看它会改什么。

**给 AI 的一句话**：

> 「照这个仓库把鲸鱼娘桌宠装上：Claude 版跑 `claude/install.mjs`，dsh 版跑根目录的 `install.mjs`（先 `--dry-run` 看一眼），然后按脚本最后打印的两步收尾。」

## 仓库里都有什么

```
pet/            dsh 版素材 + manifest（frames2d 格式）
lib/ · install.mjs · install.cmd      dsh 版插件：把 pet/ 释放给 dsh-pet
claude/         Claude Code 版：宠物包（petpack）+ 一键安装 + viewer 补丁 + 钩子脚本
docs/preview/   README 用的预览图
```

两个版本用的是同一批动作素材，只是打包格式不同：Claude 版是**精灵表 + pet.json v3**（PetPet 框架），dsh 版是**逐帧 PNG + manifest v2**（`@linxin666/dsh-pet` 插件）。

> ⚠️ **素材全部由 AI 生成** —— 立绘经 [see-through](https://github.com/ModelsLab/see-through) 分层，动作由豆包图生视频抽帧。拿去做别的事情之前，先确认所用平台的服务条款：不同平台对生成内容的商用和再分发规定不一样。代码部分是 MIT（见 [LICENSE](LICENSE)）。

---

# dsh 版细节

装完在宠物选择里叫**鲸鱼娘**（id `whalegirl-hd`）。

## 装 / 卸

**双击 `install.cmd`**（或 `node install.mjs`），它做三件事：

1. 把包复制到 `<DSH_HOME>/profiles/web/node_modules/@wei125775-lab/whalegirl-deskpet/`
2. 在 profile 的 `package.json` 里加 `dependencies` 和 `dsh.profile.bundles` 条目
3. 备份改之前的 manifest 到 `package.json.bak-whalegirl`

然后**重启 DshDesktop**。插件本身不注册任何东西，只在启动时把包内的 `pet/` 释放到 `<DSH_HOME>/pets/whalegirl-hd/` —— dsh-pet 的 `frames2d` 宠物只能从那个目录扫出来（它内联 manifest 的通道只认 v1 sprite2d 精灵表，喂 frames2d 进去会静默降级，而 sprite2d 只有固定 9 个 Codex 动画名，装不下这些自定义动作）。

释放是幂等的：目标目录的 `pet.json` 版本号和包内一致就跳过。想强制覆盖，先把 `<DSH_HOME>/pets/whalegirl-hd/` 删掉再重启。**宠物没出现就再重启一次**——插件释放和 dsh-pet 扫目录都发生在启动期间，安装脚本已经把 bundle 排在 `@linxin666/dsh-pet` 前面，但万一顺序还是反了，第二次必然正确。

卸：删掉上面那三处（`node_modules` 里的包、profile `package.json` 的条目、`<DSH_HOME>/pets/whalegirl-hd/`）。

## 给对方装

整个文件夹拷过去（zip / 网盘 / clone 都行），对方双击 `install.cmd` 或跑 `node install.mjs`，重启 DshDesktop。对方那边需要：

- **dsh** ≥ 0.1.5-rc.1（插件走 `dsh.bundle.patch` 机制）
- **[`@linxin666/dsh-pet`](https://www.npmjs.com/package/@linxin666/dsh-pet)** —— 没装的话宠物会照常释放到目录里，但没有任何东西渲染它；脚本会警告一句。先 `dsh plugin add @linxin666/dsh-pet`
- **node**（dsh 本身就依赖它）

安装脚本自己会找地方：`DSH_HOME` 环境变量优先，否则 `~/.dsh`；profile 优先挑装了 `dsh-pet` 的那个，找不到退回 `web`。多个 profile 或想指定用 `--profile=<名字>`。

## 她的台词（`pet/voice.json`）

dsh-pet 把会话事件投影成 phase，**同时也会投影出一句台词**冒在气泡里。台词默认来自官方内置文案（"准备开始""正在思考""爬取中"…）—— 那不是鲸鱼娘在说话。所以她在 dsh 里的话由 `pet/voice.json` 提供。

**`voice` 不能写进 `pet.json`** —— manifest v2 的顶层白名单里没有这个字段。它是一个**跟 `pet.json` 平级的独立文件**，放在宠物目录里就会被读走（`scanPetDir` 里 `loadVoicePackFile(join(entryDir, "voice.json"))`）。宠物被释放到 `~/.dsh/pets/<id>/` 时会一起带过去。

能配四块：

| 字段 | 覆盖什么 | 允许的键 |
|---|---|---|
| `status` | 各 phase 的状态台词 | `prepare` `waiting` `thinking` `review` `toolResult` `done` `failed` `toolFailed` `maxTokens` `interrupted` `blocked` |
| `tools` | 按工具类别出词 | `read` `write` `edit` `shell` `grep` `find` `ls` `webSearch` `webFetch` `mcp` `memory` `subagent` `todo` `browser` `git` `ask` `generic` |
| `toolRemaining` | 还有几个工具在跑 | 可用占位符 `{n}` |
| `whispers` | 干活期间的碎碎念（分类 9 秒、结果 5 秒节流） | `categories`：`thinking` `writing` `reading` `editing` `running` `searching` `git` `delegating` `browsing` `generic`；`results`：`pass` `fail` `done` |

另外 `panel`（面板标签）、`remarks`、`ranks` 也能覆盖，本宠物没用。

**占位符按块白名单校验**：`tools` 只认 `{tool}` 和 `{hint}`，`toolRemaining` 只认 `{n}`，`status` 一个都不认（写了会被丢掉并记一条 warning）。单行 ≤160 字，单池 ≤64 条。写错不会崩 —— 整包解析失败只是被忽略，**降级回官方文案**，所以 `voice.json` 是低风险改动。

想确认改动生效、又不想起 dsh：`loadPetRegistry` 的 `warnings` 应当为空，且 `reg.byId('<id>').voice.overrides` 里能看到你的池子。链路是 `voicePools()` = `mergeVoicePacks(globalVoice, entry.voice).overrides` → `emptyProjectionRuntime(pools)` → `new StatusVoice(pools)` / `new WhisperEngine(pools)`。

## 看鲸鱼（子代理来了，脚边游出一只小海豚）

起子代理的时候，她会收碗、脚边游出一只小海豚转圈，等子代理跑完，海豚沉下去，她回去吃饭。

**这一块是三层非官方机制搭出来的，dsh-pet 一升级就可能失效，所以单独写清楚。**

### 它靠什么跑起来

1. **给 dsh-pet 的相位白名单打补丁。** `frames2d.phases` 是 fail-closed 校验的 —— 写进去不认识的名字（`unknown activity phase`）会让**整只宠物被静默丢弃**，界面上直接没有她。所以要往 dsh-pet 的 `PET_ACTIVITY_PHASES` 里补 `whale-in / whale-loop / whale-out`，补丁落在两个文件：`lib/index.js`（服务端那份，实际校验走它）和 `lib/types/manifest-v2.js`。
   脚本是 `patch-dshpet.mjs`（`install.mjs` 会自动调它），幂等，`--dry-run` 可预览。
2. **相位是"偷渡"过去的。** `pet` 服务上的 `applyActivity()` 内部直接 `machine.onActivityStatus(input)`，**不校验相位**；相位原样流到客户端，而客户端的 `trackForPhase` 只是查 `config.phases[phase]` 这张表。所以只要表里挂得上键就能播。
3. **演出期间吞掉子代理的事件。** dsh-pet 对子代理会话**没有任何过滤** —— 子代理自己的 `tool/call` 之类会 `applyActivity` 到自己身上并抢走 `displaySession`，不处理的话鲸鱼每被子代理的一次工具调用打断就**从头重播一遍**。所以插件把 `applyActivity` 包了一层，演出期间只吞来源是子代理会话的调用，主会话照常放行。

### dsh-pet 升级之后怎么办

补丁会被冲掉。**宠物不会消失** —— 插件里的护栏 `stripWhalePhasesIfUnsupported()` 会在 dsh-pet 读 manifest 之前，先探一下它认不认那几个相位（读主文件里有没有 `"whale-in"` 字面量），不认就把相位键从部署的 manifest 里摘掉，降级成"没有看鲸鱼"的版本，并在日志里喊一声。

恢复：`node patch-dshpet.mjs`，然后重启 DshDesktop。

### 不要了怎么关

把 `pet/pet.json` 里 `frames2d.phases` 的 `whale-in / whale-loop / whale-out` 三个键删掉就行，补丁留着无害（白名单只是放行，多几个名字不影响别的宠物）。插件会因为你没声明那几个相位而不启动演出。

## phase 映射

dsh-pet 把会话事件投影成 7 个 phase，宠物按 phase 播动作：

| phase | 什么时候 | 播什么 |
|---|---|---|
| `idle` | 没有会话活动 / 一轮被中止 | 待机（循环） |
| `waiting` | 你发出消息、每步开始 | 吃饭 |
| `thinking` | 模型在推理 | 吃饭 |
| `tool` | 工具调用中 | 吃饭 |
| `review` | 模型在输出回复 | 吃饭 |
| `done` | 一轮完成 | 待机 |
| `failed` | 工具失败 / 本轮出错 | 屑表情（播一遍回待机） |

改这些就是改 `pet/pet.json` 里的 `frames2d.phases` 和 `gameplay.touch.zones`，两个都是 dsh-pet 的 manifest v2 字段，**改了要重启 dsh**（宠物是启动时扫的）。

### 四个踩过的坑，改 manifest 前先看

**一、`done` 和 `failed` 是粘性 phase，映射到它们的 track 必须是循环动作或者 idle。**

`phase` 只在收到新事件时才变 —— dsh-pet 里只有 sprite2d 走的 `animation` 字段带 2.4 秒回落窗口，frames2d 直接吃 `phases[phase]`，没有回落。而 track 默认 `loop: true`。所以映射**循环动作**会一直播到你下次发消息（一开始配的 `done → 比心` 就是这样，比心循环个没完）；映射**一次性动作**则每次点击后都会补播一次（点击是"占住 override + 定时释放"，释放时重新按当前 phase 解析，那会儿 phase 多半还粘在 `done` 上）。

所以 `done` 只能映射 `idle`。想在 dsh 里表达"干完活"这类一次性动作，只能挂到 `gameplay.touch` 上。

`failed → 屑表情` 是这条规则的有意例外：屑表情是**一次性** track（`loop: false` + `fallback: idle`），那 30 帧是"抬手/眨眼 → 保持得意表情 → 收回"的完整表情动作，循环播会变成反复眨眼。代价是出错后那个窗口里点她一下会补播一次屑表情——补的正是当前 phase 该有的动作，看着还算连贯，就接受了。（之前这里挂的是托腮，换成屑表情是因为**表情类素材在宠物尺寸下读得出来**，比肢体动作更贴"被打断了"的语境；托腮现在只做点击反应。）

**二、一次性动作的 `stateMs` 必须等于素材总时长（帧数 × 帧长）。**

点击分支的 `stateMs` 是"占住 override 多久"，**不写时默认 3000ms**（`gameplay-hud.tsx` 里 `result.stateMs ?? 3000`），不是素材时长。它和素材对不上就会切在动作中段：比素材长 → 循环动作**多播小半遍**再被切走（托腮原来配 3200ms、素材只有 2490ms，于是"做完之后手又抬了一次"，就是被这个问题坑的）；比素材短 → 一次性动作被**砍掉尾巴**。

所以三个点击分支的 `stateMs` 都按各自素材的帧数 × 83ms 对齐、再多留一帧（剪完死帧后：挥手 23 帧 → 1992、托腮 27 帧 → 2324、比心 30 帧 → 2700）。**剪了素材的帧就必须回来改这里**，否则就退回"多播一截"。多留的那一帧是防定时器抖动：`stateMs` 比素材短会把一次性动作砍掉尾巴。

**三、frames2d 没有 pingpong。**

petpet 那边靠 `pingpong` 往返播放解决"素材首尾接不上"，dsh 这边没有。所以吃饭那 13 帧在 manifest 里是**手工展开成 24 帧往返序列**的（`f01..f13, f12..f02`）。同一个文件名可以重复引用，客户端按 URL 缓存，不会重复解码。

**四、轨道名不许有下划线，单轨最多 64 帧。**

- 轨道名走 `/^[a-z0-9][a-z0-9-]*$/`，**下划线不合法**（叫 `eat_mid` 会让整条轨道被拒）；`frames` 里的必须是**相对该轨道自己目录**的纯文件名（写成 `eat/f01.png` 这种带路径的会被当缺帧逐个丢掉）
- 单轨 `frames` 最多 **64** 条。超限是**整只宠物被静默丢弃**、界面上直接没有她，所以"端碗吃 N 轮之后换成中口吃"这种长循环写不出来。想改只能动 dsh-pet 的 `FRAMES2D_MAX_FRAMES`（`src/manifest-v2.ts` 与编译产物 `lib/` 各一处，改完会被下次升级覆盖）

**五、同一段工作里别给不同 phase 映射不同轨道。**

每次 phase 变化，只要映射到的轨道名和当前的不一样，就从**第 0 帧重播**（`renderers/frames2d.ts`：订阅里 `if (target !== track) play(target)`，而 `play()` 第一件事就是 `frameIndex = 0`）。

而一轮里 `tool` 和 `thinking` 是**交替**出现的 —— `tool/call` → tool，`tool/result` → thinking，`reasoning-delta` → thinking。所以这两者映射到不同轨道时，**每调用一次工具就会重播两次**。原来 `thinking → 中口吃` 就是这么坏的：一轮十几个工具调用，等于二十几次"把碗放下又端起来"，看起来极乱。

修法是把 `waiting / thinking / tool / review` 全部映射到同一条 `eat`，一轮里轨道只在开头和结尾各切一次。（中口吃素材还在 `pet/frames/eat-mid/`，轨道也保留着，只是现在没人引用。）

**六、phase 映射没有概率，而 `idleDirector` 在这版里是死的。**

带随机的只有四处：点击分支 `branches[].probability`、待机导演 `idleDirector.acts[].weight`、打工 `work.successProbability`、商店 `shop.lottery`。想要"某个 phase 按概率换动作"，manifest 表达不了。

`idleDirector` 本来是最像"闲着时小概率做个动作"的机制，但它的守卫是 `phaseRef.current !== 'idle'`，而 `phase` 是粘性的（见坑一）——正常跑完一轮后永久停在 `done`，只有"一轮被中止"或"会话被 dispose"才会回到 `idle`。官方自带的四只宠物也没有一只用它（`grep idleDirector assets/*/pet.json` 全空）。所以别指望它。

**七、素材首尾自带"动作之外"的帧，要剪。**

`build_video.py` 是 `np.linspace(0, total-1, n)` 均匀抽帧，抽出来的窗口是按"整条视频"切的，**不是按动作边界切的**。所以每条轨道的开头/结尾都挂着动作之外的帧：开头是她还没起手的站桩（点了之后先愣一下），结尾是动作做完后的站桩、有时候还混进**下一段动作的开头几帧**。

实测（`eat` 那条最严重）：

- `eat`：源视频第 63~84 帧（约 0.9 秒）她本身就是定住的，抽中的 5 帧全是这段；而窗口取到第 91 帧，**把下一口的起手也切了进来**。循环里 38% 是死气。
- `wave`：30 帧里开头 3 帧 + 末尾 4 帧是站桩，占 30%。
- `touchface` / `smug` / `putaway` / `heart`：各有 2~3 帧。

**剪法**：直接改 `frames` 数组（文件不用删，留着方便回退）。`eat` 因为是手工展开的往返序列，剪完要重新补上回程。`putaway` 有 `frameMs` 数组，**剪 `frames` 必须同步剪 `frameMs`**，长度不等会让整只宠物被静默丢弃。

判断"哪几帧是多余的"用逐帧相邻差：取整条轨道的相邻差中位数，**低于它 35% 的连续首/尾段就是死帧**。注意区分"死帧"和"有意的保持"——`smug`（保持得意表情）、`touchface`（托住）、`heart`（红心成型后停一拍）中间那些小差异是动作本身，别剪。

**八、所有动作都在以约 2 倍速播放。**

`build_video.py` 从 121 帧 @24fps（5.04 秒）的视频里均匀抽 30 帧 = 每 4.03 帧抽一张（等效 6fps），而播放是 12fps → **整个动作 2.02 倍速**。每一条 30 帧的动作都如此。

这是设计时就这样的（12fps 是精灵动画的常规速率），一直没人抱怨；但如果哪天觉得"动作太急"，先把这条对上。想改就加轨道级的 `frameMs` 数组（`KNOWN_FRAMES2D_TRACK` 允许 `frames`/`frameMs`/`loop`/`fallback`），把 83 调成约 166。`eat` 因为往返播放，前向速度本来就和源视频接近，改速要连 `eat-mid` 一起改，否则两种吃法会一快一慢。

---

# 素材与授权

`pet/` 和 `claude/whalegirl.petpack` 里的素材全部由 AI 生成：立绘经 [see-through](https://github.com/ModelsLab/see-through) 分层，动作由豆包图生视频再抽帧。**要用在自己的项目里，请先确认对应平台的服务条款**——不同平台对生成内容的商用和再分发规定不一样。

脚本部分 MIT。
