# 鲸鱼娘桌宠

![鲸鱼娘桌宠](docs/preview/hero.png)

一只会跟着你干活的鲸鱼娘桌宠，同一个角色的两个平台版本：**Claude Code（PetPet 桌宠）** 和 **dsh（DshDesktop）**。

她不是那种只会原地晃两下的桌宠 —— 你发消息她捧着碗一口一口吃，这一轮干完她收碗，偶尔双手合十给你祝福，你按 Esc 打断她，她会停下手里的事甩你一个屑表情，点她会挥手/比心。

![她在 Claude Code 上干活的样子](docs/preview/scene.png)

*实拍：左边是 Claude Code 正在跑任务，右边就是她——干活期间一直端着碗吃，气泡是她自己弹的。*

![她会做什么](docs/preview/actions.png)

*上图是她的十个动作，全部实拍自宠物素材。*

## 她什么时候做什么

| 你做什么 | Claude Code 版 | dsh 版 |
|---|---|---|
| 你发消息 / 模型开始干活 | 捧着碗吃（循环）；**10% 的轮次换成端着中碗、拿筷子正经吃一顿** | 同上；**模型进入推理阶段就换成中口吃** |
| 这一轮结束 | 收碗 → 55% 托腮发呆 / **10% 双手合十祝福** / 35% 待机 | 收碗 → 待机 |
| **按 Esc 打断她** | 立刻停下手里的动作，甩你一个屑表情 | 工具失败/本轮出错时同样甩屑表情 |
| 点她 | 挥手（**8% 换成屑表情**） | 65% 挥手 / 20% 托腮 / 15% 比心 |
| 什么都不做 | 老实待机——长发和尾巴轻轻晃，偶尔眨眼 | 同左 |

![待机时她就长这样](docs/preview/idle.gif)

*上面这段就是宠物里真实的待机循环（24 帧 @12fps）：呼吸、飘发、眨眼都是程序化烘焙的，不是抽帧——AI 画不出这种幅度的小动作。其余动作由 AI 视频转序列帧、再逐帧抠像配准，工具链在 [whalegirl-pet-kit](https://github.com/wei125775-lab/whalegirl-pet-kit)。*

## 装

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

## phase 映射

dsh-pet 把会话事件投影成 7 个 phase，宠物按 phase 播动作：

| phase | 什么时候 | 播什么 |
|---|---|---|
| `idle` | 没有会话活动 / 一轮被中止 | 待机（循环） |
| `waiting` | 你发出消息、每步开始 | 吃饭 |
| `thinking` | 模型在推理 | 中口吃（播一遍回端碗吃，见坑四） |
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

所以现在三个点击分支的 `stateMs` 都按各自素材的帧数 × 83ms 对齐（托腮 2490、挥手/比心 2700 兜底多留 210ms——它们是非循环 track，播完落回 fallback，多占一会儿没有副作用）。

**三、frames2d 没有 pingpong。**

petpet 那边靠 `pingpong` 往返播放解决"素材首尾接不上"，dsh 这边没有。所以吃饭那 13 帧在 manifest 里是**手工展开成 24 帧往返序列**的（`f01..f13, f12..f02`）。同一个文件名可以重复引用，客户端按 URL 缓存，不会重复解码。

**四、轨道名不许有下划线，单轨最多 64 帧，phase 映射没有概率。**

- 轨道名走 `/^[a-z0-9][a-z0-9-]*$/`，**下划线不合法**（叫 `eat_mid` 会让整条轨道被拒）；`frames` 里的必须是**相对该轨道自己目录**的纯文件名（写成 `eat/f01.png` 这种带路径的会被当缺帧逐个丢掉）
- 单轨 `frames` 最多 **64** 条。所以"端碗吃 N 轮之后换成中口吃"这种写法（12 轮 288 帧 + 中口吃 30 帧 = 318 条）直接超限，而超限是**整只宠物被静默丢弃**、界面上直接没有她。64 条里最多塞 24+30=54，中口吃每 4.5 秒出现一次（占一半时间），是常态不是"偶尔"。想写真正的长循环只能改 dsh-pet 的 `FRAMES2D_MAX_FRAMES`（`src/manifest-v2.ts` 与编译产物 `lib/` 各一处，改完会被下次升级覆盖）
- **phase 映射没有概率**。dsh-pet 里带随机的只有四处：点击分支 `branches[].probability`、待机导演 `idleDirector.acts[].weight`（**只在 `phase === 'idle'` 时开火**）、打工 `work.successProbability`、商店 `shop.lottery`。想要"某个 phase 按概率换动作"，manifest 表达不了
- 所以 `thinking → 中口吃` 是这套限制下的折中：**每次进入思考阶段吃一顿**（`loop: false` + `fallback: eat`，播完自动回到端碗吃的循环），频率取决于她思考多少次，**不是随机**

---

# 素材与授权

`pet/` 和 `claude/whalegirl.petpack` 里的素材全部由 AI 生成：立绘经 [see-through](https://github.com/ModelsLab/see-through) 分层，动作由豆包图生视频再抽帧。**要用在自己的项目里，请先确认对应平台的服务条款**——不同平台对生成内容的商用和再分发规定不一样。

脚本部分 MIT。
