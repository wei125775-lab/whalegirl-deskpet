# whalegirl-deskpet

一只鲸鱼娘桌宠，同一个角色的两个平台版本：

| 版本 | 给谁用 | 在哪 | 怎么装 |
|---|---|---|---|
| **dsh 版** | [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) + [`@linxin666/dsh-pet`](https://www.npmjs.com/package/@linxin666/dsh-pet) | 仓库根目录（`pet/` + `install.mjs`） | 双击 `install.cmd` → 重启 dsh |
| **Claude 版** | [PetPet](https://github.com/stshourenxy-dev/petpet-playbook) | [`claude/`](claude/) | 托盘菜单导入 `whalegirl.petpack` |

**下面整份文档讲的是 dsh 版**；Claude 版的说明在 [`claude/README.md`](claude/README.md)。

两边素材是同一批：待机由分层 PSD 烘焙（呼吸 + 飘发 + 眨眼），其余动作由 AI 视频抽帧配准。行为逻辑也一致——干活时捧着碗一直吃、干完收碗、点她会挥手/比心。

> ⚠️ **这个仓库的主体是素材，而且全部由 AI 生成** —— 立绘经 [see-through](https://github.com/ModelsLab/see-through) 分层，动作由豆包图生视频抽帧。拿去做别的事情之前，先确认所用平台的服务条款：不同平台对生成内容的商用和再分发规定不一样。插件代码本身是 MIT（见文件末尾）。

装完在宠物选择里叫**鲸鱼娘**（id `whalegirl-hd`）。她会跟着模型干活：你发消息她就端着碗吃，干完回待机，点她会挥手/比心。

素材上走两条路：**大动作由 AI 视频转序列帧**（吃饭、挥手、比心、托腮、收碗），**待机的小幅呼吸感从分层 PSD 程序化烘焙**（呼吸 + 飘发 + 眨眼）。工具链在 [whalegirl-pet-kit](https://github.com/wei125775-lab/whalegirl-pet-kit)。

---

## 装

**双击 `install.cmd`**（或者 `node install.mjs`）。它做三件事：

1. 把包复制到 `<DSH_HOME>/profiles/web/node_modules/@wei125775-lab/whalegirl-deskpet/`
2. 在 profile 的 `package.json` 里加 `dependencies` 条目和 `dsh.profile.bundles` 条目
3. 备份改之前的 manifest 到 `package.json.bak-whalegirl`

然后**重启 DshDesktop**。

插件本身不注册任何东西，它只负责在启动时把包内的 `pet/` 释放到 `<DSH_HOME>/pets/whalegirl-hd/` —— 因为 dsh-pet 的 `frames2d` 宠物**只能从那个目录扫出来**（内联 manifest 的通道只认 v1 sprite2d 精灵表，喂 frames2d 进去会静默降级，而 sprite2d 只有固定 9 个 Codex 动画名，装不下这些自定义动作）。

释放是幂等的：目标目录的 `pet.json` 版本号和包内一致就跳过。想强制覆盖就先把 `<DSH_HOME>/pets/whalegirl-hd/` 删掉再重启。

### 如果宠物没出现

再重启一次。插件释放素材和 dsh-pet 扫目录都发生在启动期间，安装脚本已经把 bundle 排在 `@linxin666/dsh-pet` 前面，但万一加载顺序还是反了，第二次启动必然正确。

---

## 给别人装

整个文件夹拷过去就行（zip / 网盘 / git clone 都行），对方双击 `install.cmd` 或跑 `node install.mjs`，然后重启 DshDesktop。

对方那边需要：

- **dsh** ≥ 0.1.5-rc.1（插件走 `dsh.bundle.patch` 机制）
- **[`@linxin666/dsh-pet`](https://www.npmjs.com/package/@linxin666/dsh-pet)**（0.3.20 已验证）—— 没装的话宠物会照常释放到目录里，但没有任何东西渲染它，脚本会警告一句。先 `dsh plugin add @linxin666/dsh-pet` 装上
- **node**（dsh 本身就依赖它）

安装脚本自己会找地方：`DSH_HOME` 环境变量优先，否则 `~/.dsh`；profile 优先挑装了 `dsh-pet` 的那个，找不到再退回 `web`。有多个 profile 或者想指定，用 `--profile=<名字>`；想先看不改，用 `--dry-run`。

**改配置前先备份**：脚本只在首次安装时把 profile 的 `package.json` 存成 `.bak-whalegirl`，重装不会覆盖它——所以那个备份永远是"装之前"的样子，可以随时拿来回滚。

---

## 卸

删掉这三处：

- `<DSH_HOME>/profiles/web/node_modules/@wei125775-lab/whalegirl-deskpet/`
- profile `package.json` 里的 `dependencies` 条目和 `bundles` 条目（或直接用 `package.json.bak-whalegirl` 覆盖回去）
- `<DSH_HOME>/pets/whalegirl-hd/`（插件释放出来的，不删会继续出现在宠物列表里）

---

## 她怎么动

dsh-pet 会把模型的会话事件投影成 7 个 phase，宠物按 phase 播对应动作：

| phase | 什么时候 | 播什么 |
|---|---|---|
| `idle` | 没有会话活动 / 一轮被中止 | 待机（循环） |
| `waiting` | 你发出消息、每步开始 | 吃饭 |
| `thinking` | 模型在推理 | 吃饭 |
| `tool` | 工具调用中 | 吃饭 |
| `review` | 模型在输出回复 | 吃饭 |
| `done` | 一轮完成 | 待机 |
| `failed` | 工具失败 / 本轮出错 | 托腮（循环） |

**点击**（概率 roll，带气泡台词）：

| 概率 | 动作 |
|---|---|
| 65% | 挥手 |
| 20% | 托腮 |
| 15% | 比心 |

改动这些就是改 `pet/pet.json` 里的 `frames2d.phases` 和 `gameplay.touch.zones`，两个都是 dsh-pet 的 manifest v2 字段，改了要重启 dsh（宠物是启动时扫的）。

### 两个踩过的坑，改 manifest 前先看

**一、`done` 和 `failed` 是粘性 phase，映射到它们的 track 必须是循环动作或者 idle。**

`phase` 字段只在收到新事件时才变 —— dsh-pet 里只有 sprite2d 走的 `animation` 字段带 2.4 秒回落窗口，frames2d 直接吃 `phases[phase]`，没有回落。而 track 默认 `loop: true`。所以：

- 映射**循环动作** → 一直播到你下次发消息（一开始配的 `done → 比心` 就是这样，比心循环个没完）
- 映射**一次性动作** → 每次点击后都会补播一次。因为点击走的是"占住 override + 定时释放"，释放时会重新按当前 phase 解析，那会儿 phase 多半还粘在 `done` 上，于是又播一遍（改成 `done → 收碗` 后，每次点完都多收一次碗）

所以最终 `done` 只能映射 `idle`。想在 dsh 里表达"干完活"这类一次性动作，只能挂到 `gameplay.touch` 上。

**二、frames2d 没有 pingpong。**

petpet 那边靠 `pingpong` 往返播放解决"素材首尾接不上"，dsh 这边没有。所以吃饭那 13 帧在 manifest 里是**手工展开成 24 帧往返序列**的（`f01..f13, f12..f02`）。同一个文件名可以重复引用，客户端按 URL 缓存，不会重复解码。

---

## 素材

`pet/` 里的素材是 AI 生成的：立绘经 [see-through](https://github.com/ModelsLab/see-through) 分层，动作由豆包图生视频再抽帧。**如果你要用在自己的项目里，请先确认对应平台的服务条款** —— 不同平台对生成内容的商用和再分发规定不一样。

脚本部分 MIT。
