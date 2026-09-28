# 鲸鱼娘桌宠 · WorkBuddy 插件

让鲸鱼娘跟着你在 [WorkBuddy](https://www.codebuddy.cn/work/) 里干活：你在里面发消息，她端着碗吃饭；干完了，收碗、偶尔托腮；你派子代理干活时，她脚边游出一只小海豚绕一圈。

**English**: A [WorkBuddy](https://www.codebuddy.cn/work/) plugin that drives the whale-girl desktop pet (PetPet build) — she eats while WorkBuddy works, puts the bowl away when the turn ends, and a little whale swims out when a subagent runs.

---

## 最快的路：下带插件的那版绿色版

👉 **[releases/latest](https://github.com/wei125775-lab/whalegirl-deskpet/releases/latest)** 里挑 **`whalegirl-workbuddy-win-x64.zip`**

那个包 = 宠物本体 + 这个插件，解压后：

1. 双击 **`启动.cmd`** —— 桌面上就有她了
2. 双击 **`装WorkBuddy钩子.cmd`** —— 挂上联动
3. 完全退出 WorkBuddy 再打开

（同一个 release 里还有一个 `whalegirl-petpet-win-x64.zip`，那是给 Claude Code 的，别下错。）

## 或者：单独装这个插件

如果你已经有绿色版（Claude Code 那版）不想重下，在这个目录里跑：

```bash
node install.mjs
```

它会装插件 + 写 hooks。**注意这个包本身不含宠物** —— 桌宠本体得先有（绿色版 zip 里那个），否则装完桌面上什么都不会多出来。

脚本会做四件事，**改之前都会备份**成 `*.bak-whalegirl`（重跑不会重复加）：

1. 把插件拷到 `~/.workbuddy/plugins/marketplaces/whalegirl-local/`
2. 在市场登记文件（`known_marketplaces.json`）和已安装列表（`installed_plugins.json`）里各加一条
3. **在 `settings.json` 的 `enabledPlugins` 里把它打开** —— 这一步不能省：**装了不等于启用**，不打开的话插件在列表里看得见、状态也正常，但它的 hooks 一条都不会执行，日志里也不会说为什么
4. 再把同一份 hook 直接写进 `settings.json`（见下面的「为什么默认装两份」）

3. **完全退出 WorkBuddy 再打开**（插件是启动时加载的）。

装完可以在 WorkBuddy 的「插件管理」里看到 **whalegirl-deskpet**。

### 为什么默认装两份

WorkBuddy 支持插件带 hooks，但**"插件里的 hooks 会不会被执行"跟它的版本有关**，而"装完没反应"对普通人来说根本没法判断。所以脚本默认**两条路都写**：

1. 装成插件（能出现在插件列表里、能一键卸）
2. 同时把同一份 hook 写进 `~/.workbuddy/settings.json`（不依赖插件机制，装上一定能用）

两个都生效时，同一个事件会跑两遍脚本 —— 脚本是幂等的写，只是多一次进程开销，没别的影响。

**想只用插件机制**（干净、可管理）加 `--plugin-only`，代价是万一你的 WorkBuddy 版本不执行插件 hooks，就得回头再跑一次不带这个参数的。

### 装完没反应

```bash
node install.mjs --dry-run
```

看输出里有没有 `would also write hooks into settings.json`。没有的话是之前用过 `--plugin-only`，去掉它重跑。然后**完全退出 WorkBuddy 再打开**（hooks 是启动时读的，插件更是）。

## 她会做什么

| WorkBuddy 里发生的事 | 她的反应 |
|---|---|
| 你发一条消息 | 端碗吃饭（循环） |
| 一轮回答结束 | 收碗 → 一半概率继续托腮，偶尔合十祝福一下 |
| 你派子代理干活 | 脚边游出小海豚，绕一圈，干完沉下去 |
| 开 WorkBuddy | 桌宠自动起（如果本来没开） |

## 卸

删掉这四处就干净了（都在 `~/.workbuddy/` 下）：

```
plugins/marketplaces/whalegirl-local/     整个目录
plugins/known_marketplaces.json           去掉 "whalegirl-local" 那一项
plugins/installed_plugins.json            去掉 "whalegirl-deskpet@whalegirl-local" 那一项
settings.json                             去掉 enabledPlugins 里的 "whalegirl-deskpet@whalegirl-local"
                                          以及（装过保底那份的话）整个 hooks 段
```

几个文件都有 `*.bak-whalegirl` 备份，直接换回来也行（但那样会丢掉你后来装的别的插件）。

## 几个说明

- **hook 干什么、不干什么**：脚本只做一件事 —— 把"在干活 / 待机 / 有几个子代理"写进 `~/.petpet/state.json`。**不读你的对话内容**，也不往任何地方发数据。
- **和 Claude Code 那版共用同一个状态文件**。两边同时开着、一边干活一边待机时她会闪 —— 那是"一个文件两个写入方"，不是 bug。只用其中一个就没事。
- **她的动作和台词**都在宠物包里（`~/.petpet/pets/whalegirl/`），改文案不用动这个插件。
- 素材由 AI 生成，用前请自行确认所用平台的条款。代码 MIT。
