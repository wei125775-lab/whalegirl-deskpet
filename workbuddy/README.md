# 鲸鱼娘桌宠 · WorkBuddy 插件

让鲸鱼娘跟着你在 [WorkBuddy](https://www.codebuddy.cn/work/) 里干活：你在里面发消息，她端着碗吃饭；干完了，收碗、偶尔托腮；你派子代理干活时，她脚边游出一只小海豚绕一圈。

**English**: A [WorkBuddy](https://www.codebuddy.cn/work/) plugin that drives the whale-girl desktop pet (PetPet build) — she eats while WorkBuddy works, puts the bowl away when the turn ends, and a little whale swims out when a subagent runs.

---

## ⚠️ 先看清楚：这个插件里没有宠物

这个包**只有"让她知道你在干活"的那部分** —— 几个 hook 脚本。宠物本体（那只画在桌面上的鲸鱼娘）在**另一个东西**里：

👉 **[下载绿色版](https://github.com/wei125775-lab/whalegirl-deskpet/releases/latest)**（Windows x64，解压双击 `启动.cmd` 就能看见她）

**两个都要装**：绿色版负责"画出来"，这个插件负责"她该吃饭还是待机"。只装这个插件，桌面上什么都不会多出来。

## 装

1. 先装绿色版，确认桌面上有她（点她会挥手）
2. 再装这个插件 —— 解压后在这个目录里跑：

```bash
node install.mjs
```

脚本会：把插件拷到 `~/.workbuddy/plugins/marketplaces/whalegirl-local/`，然后在 WorkBuddy 的两份登记文件里各加一条（**改之前会备份**成 `*.bak-whalegirl`，而且重跑不会重复加）。

3. **完全退出 WorkBuddy 再打开**（插件是启动时加载的）。

装完可以在 WorkBuddy 的「插件管理」里看到 **whalegirl-deskpet**。

### 装不上 / 装完没反应

先看 `node install.mjs --dry-run` 打印的东西对不对，再试：

```bash
node install.mjs --settings-hooks
```

多加的这个参数会把同一份 hook 直接写进 `~/.workbuddy/settings.json`（**保底那条路**）。插件的 hooks 会不会被执行跟 WorkBuddy 的版本有关，这条路不依赖插件机制，装上一定能用 —— 代价是两条都生效时同一个事件会跑两遍（脚本是幂等的，只是多跑一次，没别的影响）。

## 她会做什么

| WorkBuddy 里发生的事 | 她的反应 |
|---|---|
| 你发一条消息 | 端碗吃饭（循环） |
| 一轮回答结束 | 收碗 → 一半概率继续托腮，偶尔合十祝福一下 |
| 你派子代理干活 | 脚边游出小海豚，绕一圈，干完沉下去 |
| 开 WorkBuddy | 桌宠自动起（如果本来没开） |

## 卸

删掉这三处就干净了（都在 `~/.workbuddy/` 下）：

```
plugins/marketplaces/whalegirl-local/          整个目录
plugins/known_marketplaces.json                去掉 "whalegirl-local" 那一项
plugins/installed_plugins.json                 去掉 "whalegirl-deskpet@whalegirl-local" 那一项
```

两个 json 都有 `*.bak-whalegirl` 备份，直接换回来也行（但那样会丢掉你后来装的别的插件）。

## 几个说明

- **hook 干什么、不干什么**：脚本只做一件事 —— 把"在干活 / 待机 / 有几个子代理"写进 `~/.petpet/state.json`。**不读你的对话内容**，也不往任何地方发数据。
- **和 Claude Code 那版共用同一个状态文件**。两边同时开着、一边干活一边待机时她会闪 —— 那是"一个文件两个写入方"，不是 bug。只用其中一个就没事。
- **她的动作和台词**都在宠物包里（`~/.petpet/pets/whalegirl/`），改文案不用动这个插件。
- 素材由 AI 生成，用前请自行确认所用平台的条款。代码 MIT。
