# Claude 版（PetPet 桌宠）

同一个鲸鱼娘的 [PetPet](https://github.com/stshourenxy-dev/petpet-playbook) 版本——挂在 Claude Code 桌面上的那只。

跟仓库根目录那套 dsh 版的区别：这是**精灵表 + pet.json v3** 的格式，走 PetPet 框架；dsh 那套是 **frames2d + manifest v2**，走 `@linxin666/dsh-pet` 插件。素材是同一批，动作逻辑也一样，只是打包格式不同。

---

## 装

1. 先装好 PetPet（[petpet-playbook](https://github.com/stshourenxy-dev/petpet-playbook)）并启动
2. 托盘菜单 → **导入宠物包** → 选 `whalegirl.petpack`
3. 完事。宠物会装到 `~/.petpet/pets/whalegirl/`

`whalegirl.petpack` 就是个 zip：顶层一个 `whalegirl/` 目录，里面是 `pet.json` + 6 张精灵表。导入器会自动在单层子目录里找 `pet.json`，也支持你手动解压后选目录导入。如果你已经装过一只同 id 的宠物，导入会覆盖它。

---

## 想让它跟着 Claude Code 干活

桌宠本身就能跑（待机、点它挥手/比心）。要它"你干活时捧碗吃饭、干完收碗"还得挂两个 hook——桌宠不知道 Claude 在干什么，得有人告诉它。

`petpet-state.mjs` 就是干这个的：把状态写进 `~/.petpet/state.json`，PetPet 每秒轮询那个文件。

改 `~/.claude/settings.json`（**路径换成你放这个文件的实际位置**）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node D:/path/to/petpet-state.mjs working" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node D:/path/to/petpet-state.mjs idle" }] }
    ]
  }
}
```

`working` 是你按下回车那一刻，`idle` 是这一轮结束。中间不用管，桌宠自己维持。

**顺带**：状态文件超过 30 分钟没更新会被当成 idle，防止 Claude 被强杀之后桌宠卡在"一直吃"。

---

## 她的行为

| 你做什么 | 她做什么 |
|---|---|
| 发出消息、Claude 干活期间 | 捧着碗一口一口吃（循环），并弹出气泡「白饭真好吃」 |
| 这一轮结束 | 收碗，然后 60% 概率双手托腮发呆 / 40% 回待机 |
| 什么都不做 | 老实待机——长发和尾巴轻轻晃，偶尔眨眼 |
| 单击她 | 挥手打招呼 |
| 连续点 4 次以上 | 每次有 45% 概率改比心 |

除待机外所有动作 `weight: 0`，所以不会自己随机乱播（这是刻意的）。

待机那套呼吸、飘发、眨眼不是抽帧来的——是从分层 PSD 程序化烘焙的，24 帧，AI 画不出这种幅度的小动作。其余动作由 AI 视频抽帧配准而来。工具链在 [whalegirl-pet-kit](https://github.com/wei125775-lab/whalegirl-pet-kit)。

---

## 素材

`whalegirl.petpack` 里的立绘和动作帧**全部由 AI 生成**（立绘经 see-through 分层，动作由豆包图生视频抽帧）。拿去做别的事情之前，先确认所用平台的服务条款——不同平台对生成内容的商用和再分发规定不一样。

脚本（包括 `petpet-state.mjs`）是 MIT。
