# spec：首轮命名去墙钟化 + 退出/重开兜底（pi-auto-rename issue #9）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T08:55:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T08:40:00+08:00 — 用户要求增补「自然语言修复方案」章节（无设计变更）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T08:43:00+08:00 — 用户反馈「只是缓解不是解决：2 分钟会话活着时拿不到标题」→ 首轮命名去墙钟化（`firstAfterMin` 从命名门槛改为锁定门槛），定时器方案整体移除，保留退出兜底与重开自愈
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-12T08:15:00+08:00 — 第 1 轮复核修订：R1-G1 补 U1–U4 部署前置 + D9 状态自证标记；R1-D1 写点表述；R1-D2 补 final 失败分支验收（A11）；R1-D3 补 `SessionStartEvent.reason` 出处 + 防御式判据；R1-D4 补文档一致性验收（A13）；R1-D5 补 board→session 通道证据 + 外部命名冻结显式化
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-12T08:25:00+08:00 — 第 2 轮复核收敛后折叠 5 项细化：R2-D1 版本陈述改为实查口径（npm 副本已是 0.3.0）；R2-D2 部署前置加「关掉 board 自带 title-runner」+ U1 来源自证；R2-D3 声明 final 与在飞 run 撞车边界并补 A11 用例；R2-D4 三处引用行号校正；R2-D5 模型调用次数陈述改写
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-12T09:10:00+08:00 — 实现期发现：`capTitle` 按 issue #10 D7 转小写，与 A3 验收串 `Greeting exchange` 冲突 → 裁定验收矩阵优先，机械 core 绕过 `capTitle`；改动二散文与 D3 行同步，A3 增宽度不变量断言
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-12T09:41:00+08:00 — Task 9 实现期发现 brief 的三目判据与受强制用例 2 不可同时成立（Task 8 自愈把命名提前到 session_start 内）→ 裁定改为析取式 `name === lastSetTitle || name === initialNameSeen`（与 plan 注释原语义一致），并补「首轮之前窗口」用例；D6 行与边界段同步，记录已接受的盲点（用户把名字改回原种子名不会暂停）
状态：**收敛**（第 2 轮复核无真缺口）→ ⏸ 等待用户确认设计 → 步 5 worktree
仓库：zhuxixi/pi-auto-rename（main @ 3e88e34，v0.3.0；本机实际加载的 npm 副本以 `~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/package.json` 实查为准——2026-10-12 第 2 轮复核时为 `0.3.0`，含 issue #7 代码、无 issue #9 修复）
调研：`research/R1-根因复核与量化证据.md`、`research/R2-设计先例与约束.md`（结论已评论回 issue #9）

## 问题与根因（一句话版）

首轮命名的触发只有 `agent_settled` 一个事件，且首轮 due 要求会话存活 ≥ `firstAfterMin`（5 分钟）、未到期直接 return 不写状态——于是「最后一次 agent 活动发生在门槛之内」的会话永远不会再被求值，标题停在 board 种子名（本机 46 个 `hello*`，其中 22 个做过真实工作）。详见 R1。

**用户补充的关键要求（第二版修订的动因）**：不只要求「会话结束后有个名字」，而是要求**会话活着的时候标题尽快变**——一个 2 分钟的会话，在它的 2 分钟生命里就要能看到真标题，而不是等到退出时才补。

## 修复方案（自然语言）

一句话：**把 5 分钟门槛从「什么时候允许出标题」改成「什么时候允许锁死标题」——第一个有内容的 settle 就命名（秒级），5 分钟前保持可修正；再加退出兜底与重开自愈两条后路。**

### 改动一：首轮命名去墙钟化（这是真正「解决」的那一刀）

现在的首轮 due 判定是「会话活了 ≥5 分钟」，这导致短会话和闲置会话永远等不到求值。改成：**首轮 due 不再看墙钟，只要会话里有用户消息，第一个 `agent_settled` 就命名**。这条改动的依据是仓内既有设计哲学：`earlySelection` 本来就是「取第一条实质用户消息 = 会话的 ORIGINAL INTENT」，标题从原始意图推导——等 5 分钟并不会让「原始意图」变得更原始，只会让标题来得更晚。

`firstAfterMin` 不删，而是语义改为**锁定门槛**：会话满 5 分钟之前，标题保持「未锁定」状态——每次 due 的刷新都会重推 core（沿用现有「未锁即重推」语义），意图漂移可以被修正；满 5 分钟后的第一次刷新才锁定。这与现状的可观察行为对长会话**完全一致**（今天首轮命名必然发生在 ≥5 分钟，那时锁定立即生效），只是短会话不再被排除在外。

### 改动二：纯问候会话用本地备用标题，且不占用冷却

「整段开场只有问候语」的会话（本机 45 个里占 23 个）不叫模型：本地直接给固定 core（`lang === "zh"` → 「问候交流」，否则 `Greeting exchange`），跳过质量门（门是给模型输出兜底的，本地构造字符串不需要过），不锁核心。机械 core 是**最终形态常量**，不再经 `capTitle`——`capTitle` 会按 issue #10 D7 把英文转小写，与 A3 的验收串 `Greeting exchange` 冲突，此处裁定验收矩阵优先；宽度由常量自身保证，并由 A3 的 `truncateDisplay` 断言机器校验（防止将来改常量时静默超宽）。

关键细节：**机械标题不写入 `lastRunEpoch`**，也就是不启动 `repeatEveryMin` 的 3 分钟冷却。否则「先 `hello` 后说正事」的会话会在正事那轮撞上冷却，标题要等 3 分钟才升级——用户的 2 分钟场景又回来了。写法：机械路径算出标题后，若与现状相同则直接返回（零写入）；若不同则写标题 + 同步 board + 记 state（不含 `lastRunEpoch`）。这样下一个带实质内容的 settle 会被当作「首轮」立即命名。

### 改动三：关门前兜底（保留上一版）

`session_shutdown`（`reason !== "reload"`）到来时，若这个会话**从未被命名过**（`!lastRunEpoch`），补跑一次命名并跳过门槛与冷却，总预算 5 秒（`AbortSignal`，超时放弃不阻塞退出）。它兜的是「连第一个 settle 都没等到就死了」的会话：首 turn 中途被 Ctrl-C、模型全程故障等。机制依据（pi 会 await shutdown handler、SIGTERM/SIGHUP 同路）见 R2 §1。

### 改动四：重开自愈（替代上一版的「延迟 0 定时器」）

`session_start` 时若「从未命名过 且 会话里已有用户消息 且 reason ≠ reload」，立即触发一次命名。这让存量 46 个 `hello` view 只要被重开就自动补名（重开一个 92 小时前的会话，开场就有完整上下文，命名质量反而更好），也让被 SIGKILL 杀掉的会话在下次打开时补上。`reload` 排除在外：reload 后同一个会话还会继续，避免每次重载扩展都白调一次模型。

### 改动五：手工改名保护（保留上一版）

现状的暂停条件是「我设过标题 且 当前标题 ≠ 我设的」——从没被自动命名过的会话里，用户手工改名不会产生 `paused`，新加的 settle 即命名 / 兜底命名就会覆盖它。修法：`session_start` 时用 `pi.getSessionName()` 记下初始名，判据扩为「当前标题 ≠ 我设的 且（没有自动标题时）≠ 初始名」。board 重复下发种子名不会误触发，用户改名一定触发。

### 修复后各场景的行为对照

| 场景 | 现在 | 修复后 |
|---|---|---|
| 发 `hello <真问题>` 的 2 分钟会话 | 永远叫 `hello` | **第一次 settle（秒级）就有真标题**，会话活着时 board 上就能看到 |
| 先 `hello`、再补真问题 | 永远叫 `hello` | 第一句后变「问候交流」，第二句的 settle 立刻升级为真标题（机械路径不占冷却） |
| 纯 `hello`、再没下文 | 停在 `hello` | 第一次 settle 变「问候交流」/`Greeting exchange`，零模型调用 |
| 闲置 92 小时的会话（R1 的极端样本） | 92 小时都是 `hello` | 开场 4 分钟那次 settle 就会命名（它当时有实质消息） |
| 首 turn 中途被 Ctrl-C / SIGKILL | 停在种子名 | 优雅退出时补一次（5s 预算）；SIGKILL 的下次重开时补 |
| 存量 46 个 `hello` view | 一直 `hello` | 重开即补名 |
| 用户手工改过名的会话 | 过了门槛可能被覆盖 | 任何新时机都不改写（冻结） |
| 正常长会话 | 5 分钟时首次命名并锁定 | 首次 settle 即命名（未锁），5 分钟后的首次刷新锁定——最终锁定的标题与现状等价 |

### 大致工作量

`lib/auto-rename-core.ts` 新增四个纯函数（`renameDue`、`coreLocksNow`、`trivialCore`、`shouldRenameOnStart`），`index.ts` 改四处接线（due 判定换函数、机械分支、`session_start` 自愈、`session_shutdown` 兜底 + 手工改名判据），`test/` 新增测试与假模型 stub，`README.md` 改写时机描述。**不引入定时器、不新增 state 字段**，出问题单 commit 回滚。

## 目标

1. 会话活着时尽快有标题：第一个有内容的 settle（通常秒级）即命名，2 分钟的会话在它的生命里就能看到真标题。
2. `firstAfterMin` 的「意图定型观察期」保留，但表现形式从「没标题」改为「有标题、未锁定、可修正」。
3. 退出与重开各有一次兜底，做到「除被 SIGKILL 且永不重开外，没有会话停在种子名」。
4. 纯问候会话零模型成本拿到有信息量的名字。
5. 不覆盖用户手工改名。

## 非目标（设计约束）

1. 不动 agent-board 侧（`title-runner.mjs` / `fallbackName` 种子策略）。
2. **不引入定时器**（settle 驱动 + 退出兜底 + 重开自愈已覆盖全部会话结局；定时器对本设计无增量价值）。
3. 不改质量门分叉语义（issue #5），仅新增「机械 core 不过门」豁免。
4. 不改锚点与证据通道语义（issue #7 成果逐字节保持）。
5. 不做存量 view 的批量回填工具（重开自愈替代）。
6. 不改 `repeatEveryMin` 冷却语义：首轮锁定前的措辞刷新仍受冷却约束，「实质 → 实质」意图漂移在冷却内的即时升级不在本次范围（有标题远好于没标题；需要时另议）。
7. 不在 turn 中途命名（等 settle，不引入 `turn_end`/`message_end` 触发）。
8. 不改标题形态决策（不加 repo 前缀、core ≤ `maxCoreWidth`）。

## 决策表

| # | 决策 | 选择 | 备选（弃用原因） |
|---|------|------|------------------|
| D1 | 首轮命名时机 | **去墙钟化**：第一个有用户消息的 `agent_settled` 即命名 | 保留 5 分钟门槛 + 定时器（标题在门槛前依旧不存在——用户明确反馈这是缓解不是解决）；`turn_end`/`message_end`（turn 中途命名，抖动大且无必要） |
| D2 | `firstAfterMin` 语义 | 从「命名门槛」改为「核心锁定门槛」：`nextLocked` 增 `age ≥ firstAfterMin` 条件 | 首轮即锁（开场意图未定型就锁死，质量回退）；直接删除该配置（破坏既有「观察期」语义，且长会话行为会发生变化） |
| D3 | 纯问候会话 | 机械 core（zh「问候交流」/ 否则 `Greeting exchange`）+ 不调模型 + 跳过质量门 + **不写 `lastRunEpoch`（不占冷却）**；机械 core 为最终形态常量，绕过 `capTitle` | 走模型（0 信息量输入也花钱）；占冷却（hello→真问题 的升级要等 3 分钟，用户场景复现） |
| D4 | 退出兜底 | `session_shutdown`（reason ≠ reload）且从未命名时补跑一次，跳门槛、5s `AbortSignal` 预算 | 移除（首 turn 中途被杀/模型故障的会话无解） |
| D5 | 重开自愈 | `session_start`（reason ≠ reload、从未命名、有用户消息）触发一次命名 | 不处理（存量 46 个 view 永远 hello）；批量回填脚本（成本高、脱离会话上下文质量差） |
| D6 | 手工改名保护 | 初始名判据（同上一版）：`session_start` 记 `pi.getSessionName()`，暂停条件为「当前标题既 ≠ 我设过的标题、也 ≠ `session_start` 时读到的初始名」（析取判定：等于任一即视为我方命名或种子名，不暂停） | 现状（新时机会覆盖首跑期手工改名 = 引入回归）；任何名字变化都暂停（board 种子名会误暂停） |
| D7 | 定时器 | **移除**（第一版的 D1/D7 作废）：三个结局（活到 settle、提前结束、被杀后重开）都被事件覆盖 | 保留（对已死进程无意义；对活着的会话 settle 比闹钟到得更早） |
| D8 | 文档 | README「How It Works」与配置表按新语义改写；CHANGELOG 记 `feat`（行为变更，发 minor） | 不更新（README:100,119-120 与实现将不符） |
| D9 | 部署自证标记（R1-G1） | `/autorename-status` 增印 `timing=first@settle,lock@<firstAfterMin>m`，行文本由纯函数 `formatStatusLine` 生成 | 不设标记（U1–U4 无法自证「新代码已加载」，实测可能全跑在 npm 旧副本上） |

**D6 的边界（R1-D5 修订）**：`session_info_changed` 的外部命名源只有两类——用户 `/name`（或 pi 的改名入口）与其它命名扩展；**board 不写 session 名**（证据：`pi-agent-board` 仓库 `src/` + `runner/` 全量 grep `setSessionName|session_info|sessionInfo|appendSessionInfo` 零命中；board 的 title-runner 只写 `meta.name`，`runner/title-runner.mjs:40-41` 仅在 `meta.name === fallbackName` 时改写 meta）。因此「board 重复下发种子名」不会触发 `session_info_changed`；若将来出现外部命名源（含 board 侧改动），D6 判据会冻结该会话——**这是预期语义**：尊重外部命名，不与其争抢（与现状「手工改名即冻结」的意图一致）。**已接受的盲点**：用户若把标题手工改回「原种子名」那一个字符串，判定会当作种子名重放而不暂停（与 board 重放不可区分）；概率极低，接受。

### `lib/auto-rename-core.ts`（纯函数，全部可测）

```ts
/** due 判定：force / final 恒 true；首轮（无 lastRunEpoch）恒 true；否则按 repeatEveryMin 冷却。 */
export function renameDue(input: {
  st: { lastRunEpoch?: number };
  nowSec: number;
  repeatEveryMin: number;
  force?: boolean;
  final?: boolean;
}): boolean;

/** 核心是否此刻锁定：已锁 / force / rederive 恒 true；实质锚点另要求会话年龄 ≥ firstAfterMin。 */
export function coreLocksNow(input: {
  alreadyLocked?: boolean;
  substantive: boolean;
  ageSec: number;
  firstAfterMin: number;
  force?: boolean;
  rederive?: boolean;
}): boolean;

/** 琐碎锚点的机械 core；lang === "zh" → 中文，否则英文。 */
export function trivialCore(lang: TitleLang): string;

/** session_start 是否补命名：从未命名、有用户内容，且非 reload。
 *  SDK 出处：SessionStartEvent.reason ∈ startup|reload|new|resume|fork
 *  （@earendil-works/pi-coding-agent dist/core/extensions/types.d.ts:562-568）。
 *  判据按防御式实现：只显式排除 "reload"，未知/缺失 reason 一律放行。 */
export function shouldRenameOnStart(input: {
  reason: string;                 // SessionStartEvent.reason（出处见上）
  lastRunEpoch?: number;
  hasUserMessages: boolean;
}): boolean;

/** /autorename-status 的单行文本（D9 部署自证标记）；字段：title/core/locked/paused/lastRun + timing。 */
export function formatStatusLine(
  st: { lastSetTitle?: string; lastCore?: string; coreLocked?: boolean; paused?: boolean; pausedReason?: string; lastRunEpoch?: number },
  config: { firstAfterMin: number },
): string;
```

### `index.ts`（副作用层，只做接线与传参）

- `runAutoRename(pi, ctx, opts)`：`opts` 增 `final?: boolean`、`signal?: AbortSignal`。due 检查改调 `renameDue`（不再读 `firstAfterMin`）；`sessionStartSec`（`firstTimestamp(sessionFile) ?? now`）只用于算 `ageSec` 传给 `coreLocksNow`；`early && !sel.substantive` 时 `coreRaw = trivialCore(config.lang)` 走机械路径（不过门、不调模型、不写 `lastRunEpoch`、标题未变时零写入）；`generateCore(..., opts.signal)` 透传；`nextLocked` 改调 `coreLocksNow`。
- `session_start`：`sessionCtx = ctx`；记 `initialName = pi.getSessionName()`；`shouldRenameOnStart(...)` 为真时 `trigger(false)`。
- `agent_settled`：不变（`trigger(false)`）。
- `session_shutdown`：`reason !== "reload"` 且 `!readState(branch).lastRunEpoch` 时 `await runSerialized(ctx, false, { final: true, signal: AbortSignal.timeout(FINAL_BUDGET_MS) })`，全程 try/catch 只 log，绝不阻断退出。
- `/autorename-status`：改用 `formatStatusLine(st, config)` 渲染（新增 `timing=first@settle,lock@<firstAfterMin>m` 字段，作为「新代码已加载」的自证标记，D9）。
- `session_info_changed`：暂停条件按 D6 扩展。
- `loadConfig`：`firstAfterMin` 的注释/语义随 D2 更新（配置键不变，存量配置无需迁移）。

### `test/support/pi-ai-stub.ts`（新增，仅测试用）

导出可配置的 `complete(...)`：默认返回一个合法 title，记录调用次数；测试用它断言「琐碎锚点零模型调用」「机械路径不消费冷却」。

## 数据流（修复后）

```
session_start（reason≠reload 且未命名且有内容）──► trigger(false) ──┐
agent_settled ────────────────────────────────────────────────────►├─► runAutoRename
session_shutdown（reason≠reload 且从未命名）──► final run（5s 预算）──►┘      │
                                                                              v
                                  renameDue（首轮恒 true / 冷却 / force / final）
                                              │
                       ├─ 琐碎锚点 ──► trivialCore（不过门 / 不调模型 / 不占冷却 / 未变不写入）
                       └─ 否则 ──► generateCore(signal) ──► qualityGate ──► capTitle
                                                                              │
                          coreLocksNow（age ≥ firstAfterMin 才锁）──► setSessionName + board sync + state
```

## 降级

- 模型失败 → 不写 state，下个 settle 自动重试；会话结束前仍失败 → final 路径再试一次（5s 预算）；再失败保持种子名。
- `sessionFile` 不存在（内存会话）→ `ageSec = 0` → 可命名但不锁，文件出现后自愈。
- 机械标题已存在且仍琐碎 → 零写入返回（每个 settle 的开销 = 一次正则判断）。
- 质量门拒绝（模型给了垃圾 core）→ 保持现名退避，下个 settle 重试（`lastRunEpoch` 不被拒写——与现状语义一致）。
- `/autorename` 并发 → 现有 `running` 串行化不变。
- **final 与在飞 run 撞车（R2-D3）**：`runSerialized` 的 `running` 守卫会让 final 静默返回 `null`（不抛错，try/catch 与日志都覆盖不到）——典型场景是 settle 触发的模型调用（单次最长 12s × 重试）进行中用户关 view。**接受的边界**：本次退出跳过补命名、不写状态，下次重开走 D5 自愈（后果良性）；实现需在该分支打一条 `debugLog`，并纳入 A11 用例 b。

## 验收矩阵

### 用户实测的部署前置（U1–U4 共同，R1-G1）

U1–U4 验证的是**正在运行的扩展**，而本机当前加载的是 npm 副本（以 `~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/package.json` 实查为准；2026-10-12 第 2 轮复核时为 `0.3.0`，含 issue #7 代码、无 issue #9 修复、无 D9 标记），步 5 的 worktree 产物不在 pi 的加载路径上——不写前置，四条实测都会跑在旧代码上（README:88 记的安装位置是 `~/.pi/agent/extensions/pi-auto-rename`；本机实际由 settings 的 `packages` 里 `npm:@zhuxixi/pi-auto-rename` 提供，`~/.pi/agent/extensions/` 下无本扩展）。执行顺序：

1. 摘掉旧包：`pi remove npm:@zhuxixi/pi-auto-rename`。
2. 装载 worktree 产物：`pi install <WT>`（目录形式，读其 `package.json` 的 `pi.extensions`；`pi install` 支持本地路径，见 `docs/packages.md` 的「Install from npm, git, or a local path」节与 `pi install ./local-package` 示例）。
3. **关掉 board 自带的标题生成，避免 U1 归因被污染**：给 board 宿主设 `AGENT_BOARD_TITLE_MODEL=off`（`runner/title-runner.mjs:26-27` 显式支持）。否则 board 在 view 创建时会用启动 prompt 自己生成标题并直接写 `meta.name`（`runner/title-runner.mjs:40-41`，仅当 `meta.name === fallbackName`）——与 U1 的观测面完全重合，它出标题时 U1 可在扩展未生效的情况下「假通过」。
4. 让新进程生效：board 视图由 board 宿主拉起 pi，需等 warm host 过期（`AGENT_BOARD_WARM_HOST_TTL_MS=2700000`，45 分钟）或重启 board 宿主，再新开 view。
5. 自证新代码已加载：`/autorename-status` 输出含 `timing=first@settle,lock@<firstAfterMin>m`（旧副本无该字段，见 D9）。
6. U1–U4 全部在第 5 步确认之后执行（U3 尤其：未确认就重开，加载的是旧代码）。
7. 收尾恢复：`pi remove <WT>`、撤掉 `AGENT_BOARD_TITLE_MODEL=off`，发版后 `pi install npm:@zhuxixi/pi-auto-rename@0.4.0`，重启 pi。

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 首轮 due 去墙钟化 | 自动化验证（unit） | `bash test/run-all.sh`（新增 `test/first-rename-timing.test.ts`） | 无 `lastRunEpoch` → 恒 true（与年龄无关）；有 → `repeatEveryMin` 冷却分支不变；`force`/`final` 恒 true |
| A2 | 锁定门槛 | 自动化验证（unit） | 同上 | `substantive && age ≥ firstAfterMin` → true；`substantive && age < firstAfterMin` → false；`force`/`rederive`/`alreadyLocked` → true；非实质 → false |
| A3 | 机械问候 core | 自动化验证（unit） | 同上 | `zh` → 「问候交流」；`auto`/`en` → `Greeting exchange`（常量最终形态，绕过 `capTitle`）；两条 `truncateDisplay(trivialCore(lang), MAX_CORE_WIDTH) === trivialCore(lang)` 断言宽度不变量 |
| A4 | 机械路径不占冷却 | 自动化验证（unit + integration） | 同上 + `test/first-rename-timing.test.ts` | 机械改名后 state 无 `lastRunEpoch`；标题未变时零写入；随后的实质 settle 立即命名（不等冷却） |
| A5 | 首个 settle 即命名 | 自动化验证（integration） | 同上（fake pi + alias stub） | 新会话 fire `agent_settled` 后**立即**调用 `setSessionName`（不等 5 分钟）；琐碎锚点场景 stub `complete` 调用数 = 0 |
| A6 | 锁定时序 | 自动化验证（integration） | 同上 | `age < firstAfterMin` 的实质改名 → state `coreLocked=false`；`age ≥ firstAfterMin` → true |
| A7 | 重开自愈 | 自动化验证（integration） | 同上 | `session_start{reason:"resume"}` + 有内容 + 无状态 → 立即命名一次；`reload` / 无内容 → 不动 |
| A8 | 退出兜底 | 自动化验证（integration） | 同上 | `session_shutdown{reason:"quit"}` + 从未命名 → 命名；`reload` → 不动；已命名 → 不动 |
| A9 | paused 与手工改名保护 | 自动化验证（integration） | 同上 | `paused` 会话在 start/settle/shutdown 三个时机都不被改写；手工改名 → `paused: manual_rename`，种子名重放不置 paused |
| A10 | 既有行为不回归 | 自动化验证（unit） | `bash test/run-all.sh` | 既有 `auto-rename-core.test.ts` / `work-evidence.test.ts` 全绿（含金测） |
| U1 | 真实短会话活着时改名 | 用户实测 | 新开 view 发 `hello <真问题>`，30 秒内看 board 列表（不关会话） | 名字已变，不等会话结束、不等 5 分钟；且 `/autorename-status` 显示的 title 与 board 行名一致（来源自证，排除 board 自带 title-runner 的污染，见部署前置第 3 步） |
| U2 | hello → 追加真问题的升级 | 用户实测 | 先发 `hello`，再发真问题 | 第一句后名字变「问候交流」，第二句 settle 后立即升级（不受 3 分钟冷却影响） |
| U3 | 存量自愈 | 用户实测 | 重开 2–3 个当前名为 `hello` 的存量 view | 打开后数秒内被命名 |
| U4 | 退出延迟 | 用户实测 | 关掉一个从未命名的 view | 退出等待 ≤5s，之后 board 行名已变 |
| A11 | final 失败/超时分支（R1-D2） | 自动化验证（integration） | `test/first-rename-timing.test.ts`：用例 a = stub `complete` 恒失败或挂起超过 5s 预算；用例 b = stub 挂起使一次后台 run 在飞，此时触发 `session_shutdown{reason:"quit"}` | 用例 a：`session_shutdown{reason:"quit"}` 仍正常完成（不挂起、不抛错）；标题保持种子名；无半写状态（会话文件不新增 `auto-rename-state`）；`debugLog` 含放弃原因。用例 b：final 被 `running` 守卫跳过（返回 null）、不抛错、不写状态、退出照常完成 |
| A12 | 部署自证标记（R1-G1 / D9） | 自动化验证（unit） | `test/first-rename-timing.test.ts` 单测 `formatStatusLine` | 旧字段（title/core/locked/paused/lastRun）仍在；新增 `timing=first@settle,lock@<n>m` 且数值取自配置 |
| A13 | 文档一致性（R1-D4） | 自动化验证（static） | 新增 `test/docs-timing.test.ts`：读 `README.md` 断言含新语义（首次命名在「第一个有内容的 settle」、`firstAfterMin` 为锁定门槛）且**不含**旧句 `First rename after this many minutes of session life` / `first rename after \`firstAfterMin\`` | 断言通过（`bash test/run-all.sh` 全绿）；CHANGELOG 条目属发版流程，不在本 PR 验收范围 |

### 可测性拆分设计（A 类功能点的硬约束）

- `renameDue` / `coreLocksNow` / `trivialCore` / `shouldRenameOnStart` / `formatStatusLine`：**纯函数**，零 fs、零 pi 依赖，禁止内联进 `runAutoRename`（侧效应层不可测）。
- 副作用隔离：LLM 调用只在 `runAutoRename`（`llmOnce` 已隔离）；state 写入集中在 `runAutoRename`——两处既有出口（未变 / 变更分支，均带 `lastRunEpoch`）**加机械路径的第三处显式出口**（不含 `lastRunEpoch`、不过门、标题未变时零写入；R1-D1 修订，既有出口的字段形状无法复用）；事件接线只做「调纯函数 + 传参」。
- integration 测试边界：`test/support/pi-ai-stub.ts` + esbuild `--alias:@earendil-works/pi-ai/compat=test/support/pi-ai-stub.ts`。**已实测**：esbuild 0.28.2 支持 `--alias:`，必须按**精确子路径**别名（只别名包名会报 `Could not resolve …/compat`）；`@earendil-works/pi-coding-agent` 是 type-only import，bundle 时被擦除、无需 stub。时间相关断言用「fake now」注入（纯函数直接吃 `nowSec`，integration 里 fake ctx 的 session 文件时间戳用脚本生成），不用真等 5 分钟。
- HOME 隔离：`CONFIG_PATH` 在模块加载期由 `homedir()` 计算 → 测试先 `process.env.HOME = mkdtemp()` 再 `await import("../index")`。
- `test/run-all.sh` 补 `--alias:` 参数（对不 import index.ts 的测试无副作用）。

## 风险与回滚

- **模型调用次数**（R2-D5 修订）：调用时机提前（首个 settle 而非 5 分钟），且解锁窗口内的到点刷新会重推（未锁即调模型）——活过 5 分钟的长会话比现状最多多 1–2 次调用（t≈0 命名、t≈3min 重推、t≥5min 锁定后回到零成本刷新）。
- **锁前标题措辞可能变一次**：既有「未锁即重推」语义的自然延伸；锁定后不再抖动。
- **配置语义变更**：`firstAfterMin` 从命名门槛变为锁定门槛，README 必须同步；存量配置（`5`）无需迁移，长会话可观察行为与现状等价（D2 论证）。
- **退出延迟**：final run 最多让退出多等 5s，仅发生在「从未命名过 + 有内容」的会话、每会话一次。
- **SIGKILL 残余边界**：被强杀且永不重开的会话仍停在种子名（明示，不假装覆盖）；重开即自愈。
- **机械 core 误判**：沿用 `isTrivialMessage`（既有测试与负样本），且不锁核心、不占冷却 → 实质内容一来即升级。
- **部署路径失真（R1-G1）**：实测若未按「部署前置」先装 worktree 产物或未等 warm host 过期，U1–U4 会跑在 npm 旧副本上——前置的第 3、4、5 步就是为此设的卡点。
- **外部命名源冻结**：若将来 board 侧或其他扩展开始写 session 名，D6 会把该会话冻结（预期语义，见「D6 的边界」）；board 当前不写 session 名（已 grep 证实），不构成现存风险。
- **回滚**：单 commit revert；不新增 state 字段（无迁移）；部署侧回滚 = `pi remove <WT>` + 重装 npm 包。
