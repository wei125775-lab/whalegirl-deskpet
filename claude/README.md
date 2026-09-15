# Claude 版（PetPet 桌宠）

同一个鲸鱼娘的 [PetPet](https://github.com/stshourenxy-dev/petpet-playbook) 版本——挂在 Claude Code 桌面上的那只。

> **不想手动折腾？让 AI 装**：把仓库链接和这句话发给你的 AI ——
> 「照 `claude/README.md` 把鲸鱼娘桌宠装上，直接跑 `node claude/install.mjs`（先 `--dry-run` 看一眼），然后按它最后打印的两步收尾。」
> 脚本是幂等的，重复跑不会出问题。

跟仓库根目录那套 dsh 版的区别：这是**精灵表 + pet.json v3** 的格式，走 PetPet 框架；dsh 那套是 **frames2d + manifest v2**，走 `@linxin666/dsh-pet` 插件。素材是同一批，动作逻辑也一样，只是打包格式不同。

---

## 装

一条命令（Windows 上也可以直接双击 `install.cmd`）：

```bash
node install.mjs             # 装
node install.mjs --dry-run   # 先看它会改什么，什么都不动
```

它依次做完这四件事，**幂等**，重复跑没有副作用：

1. 找到（本机找不到就 clone）petpet-playbook 源码
2. 把 `viewer.patch` 打上去（内置 diff 应用器，不强依赖 git，能容忍行尾 CRLF/LF 差异）
3. 在 viewer 里 `npm install && npm run build`
4. 三个 hook 放进 `~/.claude/hooks/`、**合并**进 `~/.claude/settings.json`（先备份、只加不改、不覆盖你原有配置）；再把 `whalegirl.petpack` 解到 `~/.petpet/pets/whalegirl/`

常用参数：`--viewer <源码路径>`、`--pet-exe <PetPet.exe 路径>`（写进 SessionStart 钩子，开 Claude 自动拉起她）、`--no-build`、`--force`。

跑完还剩两步（脚本结尾会打印）：

- **让它跑起来**：`cd <源码>/viewer && npm run dev`（图省事），或者把 `viewer/dist/` 覆盖进你那份 PetPet 应用的 `resources/app/dist/`（先删旧目录，文件名带 hash）
- **重启 Claude Code**（让 SessionStart 钩子生效）

### 它到底改了什么 / 不打补丁会怎样

- **补丁**是对 petpet-playbook **v1.3.0** 生成的（187 行、4 个文件：`viewer/main.js` / `src/main.ts` / `src/state-priority.ts` / `preload.cjs`），加了四件事：干活时动作可按权重换（`variants`）、收碗动作可分开（`variants[].putaway`）、外部状态多一个 `interrupted`（打断）、`loop: false` 的动作一律按一次性处理。上游比 v1.3.0 新的话可能打不上，脚本会明确报出来——按文件里每处的注释手工合并即可。
- **`whalegirl.petpack` 就是个 zip**：顶层 `whalegirl/` 目录，里面 `pet.json` + 10 张精灵表；也能用 PetPet 托盘菜单「导入宠物包」手动装。
- **不打补丁也能跑**：那几个字段会被忽略——永远吃普通的小口饭、点她只会挥手、被打断只是停下（没有屑表情）。不会报错、不会卡住。

### 手动装（不想跑脚本，或脚本卡住了）

1. 装好 PetPet（[petpet-playbook](https://github.com/stshourenxy-dev/petpet-playbook)）。它的 [Releases](https://github.com/stshourenxy-dev/petpet-playbook/releases) 有预编译版（`PetPet.<版本>.exe` 便携版 / `PetPet.Setup.<版本>.exe` 安装版 / macOS `.dmg`）——**但预编译版把应用代码打进了 `app.asar`，外部改不动，所以想要完整效果必须走源码**。
2. ```bash
   git clone --branch v1.3.0 https://github.com/stshourenxy-dev/petpet-playbook.git
   cd petpet-playbook
   git apply /path/to/claude/viewer.patch        # 或 patch -p1 < claude/viewer.patch
   cd viewer && npm install && npm run build
   ```
3. 绿色版再把 `viewer/dist/` 整个覆盖进 `resources/app/dist/`（先删旧的）。
4. 托盘菜单 → **导入宠物包** → 选 `whalegirl.petpack`。
5. 三个 hook 按下节的手动配置来挂。

---

## 想让它跟着 Claude Code 干活

桌宠本身就能跑（待机、点它挥手/比心）。要它"你干活时捧碗吃饭、干完收碗、被打断甩你一眼"还得挂三个 hook——桌宠不知道 Claude 在干什么，得有人告诉它。

把 `petpet-state.mjs`、`interrupt-watch.mjs`、`petpet-launch.mjs` 三个文件放进 `~/.claude/hooks/`（前两个没路径依赖；**`petpet-launch.mjs` 顶部的 `EXE` 那行要改成你自己的 PetPet 路径**），然后改 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node C:/Users/you/.claude/hooks/petpet-launch.mjs" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node C:/Users/you/.claude/hooks/petpet-state.mjs working" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node C:/Users/you/.claude/hooks/petpet-state.mjs idle" }] }
    ]
  }
}
```

三个各管一摊：

| hook | 干什么 |
|---|---|
| `SessionStart` | 开 Claude 时把 PetPet 和打断检测器拉起来（没在跑才拉） |
| `UserPromptSubmit` | 你按下回车 → 写 `working` → 她开始吃 |
| `Stop` | 一轮结束 → 写 `idle` → 她收碗 |

**如果你不是用绿色版 exe 跑的**（比如 `npm run dev`）：把 `SessionStart` 那行去掉，改成开机后手动跑一次 `node ~/.claude/hooks/interrupt-watch.mjs` 就行——打断检测和吃饭这两件事都不依赖它。

状态写进 `~/.petpet/state.json`，PetPet 每秒轮询那个文件。**顺带**：状态文件超过 30 分钟没更新会被当成 idle，防止 Claude 被强杀之后桌宠卡在"一直吃"。

### 打断（Esc）得单独检测

上面两个 hook 有个缺口：**官方没有任何 hook 在"用户按 Esc 打断"时触发**——hooks 文档对 `Stop` 写得明白，"Does not run if the stoppage occurred due to a user interrupt"，也没有 `Interrupt`/`TurnCancelled` 这类事件。所以只挂这两个 hook 的话，**你一按 Esc 她就会一直端着碗吃下去**，直到你下次发消息。

打断这个事实只会落进会话 transcript：

```json
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]},
 "interruptedMessageId":"<被打断那条 assistant 消息的 uuid>"}
```

所以仓库里另有一个 `interrupt-watch.mjs`（放 `~/.claude/hooks/`，由 `SessionStart` 钩子顺带拉起、自带 pid 文件保证单实例）：它每秒瞄一眼最近动过的 transcript，读到新的 `interruptedMessageId` 就往 `state.json` 写 `{"state":"interrupted"}`。桌宠这边收到这个状态就停下吃饭、按 `pet.json` 的 `reactions.interrupted` 播个反应动作（这里是屑表情），然后回待机。

**注意**：这段依赖 transcript 的内部格式（没有官方背书），字段名变了它只会静默失效——变成"打断后还是停不下来"的老样子，不会报错。日志在 `~/.petpet/interrupt-watch.log`。

---

## 她的行为

| 你做什么 | 她做什么 |
|---|---|
| 发出消息、Claude 干活期间 | 捧着碗一口一口吃（循环），并弹出气泡「白饭真好吃」。**其中 10% 的轮次会换成端出中碗、拿筷子正经吃一顿**（同样循环，直到这轮结束） |
| 这一轮结束 | 收碗，然后 55% 双手托腮发呆 / 10% 双手合十给你祝福一下 / 35% 回待机 |
| **你按 Esc 打断她** | 立刻停下手里的动作，甩你一个屑表情（眨眼 + 半眯眼笑），然后回待机 |
| 什么都不做 | 老实待机——长发和尾巴轻轻晃，偶尔眨眼 |
| 单击她 | 挥手打招呼（**8% 的几率改成甩你一个屑表情**） |
| 连续点 4 次以上 | 每次有 45% 概率改比心 |

除待机外所有动作 `weight: 0`，所以不会自己随机乱播（这是刻意的）。

概率都写在 `pet.json` 里，就两处：

- **`actions.eat.variants`** —— 干活时吃哪碗饭。`[{ "action": "eat_mid", "weight": 10, "putaway": "eat_mid_putaway" }]` 的意思是"10% 换成中口吃"，剩下的 90% 仍是普通的吃；`putaway` 指明这一碗收工后走哪条收碗动作（中碗要放下的是中碗，用小口吃那条收碗会硬跳）。想让中口吃更常见就调大 `weight`，不想要就删掉这个字段（删了就永远只吃小口饭）。**每次从待机进入干活时掷一次骰子**，一轮对话里不会反复重掷。

  中口吃用的**不是**素材的完整 30 帧：那 30 帧是一整套"空手站 → 端起碗 → 吃 → 放下碗 → 空手站"，loop 起来会变成每 2.5 秒放一次碗。这里只取 f11~f22 那 12 帧"碗举在脸前、筷子扒饭"，配 pingpong 往返（共 22 格），和小口吃是同一套做法；**收碗也从同一条素材里单独切了 f22~f30 那 9 帧**（放下中碗 + 手收回），生成脚本在 `whalegirl-pet-kit` 的 `tools/build_eat_mid_core.py`。
- **`putaway.transitions`** —— 收碗之后按权重挑下一个动作（现在是 `{touchface: 60, idle: 40}`）。

PetPet 只在启动时读 `pet.json`，改完要重启它。

**`variants` / `reactions` 是本仓库对 viewer 的扩展**，不是 petpet-playbook 官方字段（见上面「装」第 1 步的 `claude/viewer.patch`）：`viewer/src/main.ts` 里加了 `pickVariant()`，按 `actions.<动作>.variants` 的权重决定播哪个动作；`reactions` 则把外部状态映射到反应动作。用**官方未改版**的 viewer 打开这个宠物包，这些字段会被忽略——不会报错，只是没有中口吃/屑表情这些花样。改动本身也不影响别的宠物（没配这些字段时行为与原来完全一致）。

待机那套呼吸、飘发、眨眼不是抽帧来的——是从分层 PSD 程序化烘焙的，24 帧，AI 画不出这种幅度的小动作。其余动作由 AI 视频抽帧配准而来。工具链在 [whalegirl-pet-kit](https://github.com/wei125775-lab/whalegirl-pet-kit)。

---

## 素材

`whalegirl.petpack` 里的立绘和动作帧**全部由 AI 生成**（立绘经 see-through 分层，动作由豆包图生视频抽帧）。拿去做别的事情之前，先确认所用平台的服务条款——不同平台对生成内容的商用和再分发规定不一样。

脚本（包括 `petpet-state.mjs`）是 MIT。
