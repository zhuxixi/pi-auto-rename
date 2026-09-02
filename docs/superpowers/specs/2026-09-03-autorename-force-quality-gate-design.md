# Spec: /autorename 质量门按路径拆分 + 拒绝透明化（issue #5）

创建日期：2026-09-02
修订日期：2026-09-03（首轮 SPEC review 修订 + 用户复审通过）
状态：已确认，进 worktree 实现
仓库：zhuxixi/pi-auto-rename（v0.2.0，be4405b）
调研：`~/.claude/github-issue-driven/zhuxixi/pi-auto-rename/issue-5/research/root-cause-verification.md`（结论已评论回 issue #5）

## 问题

1. `/autorename`（force）被质量门拒绝后无回退：`core rejected by quality gate; backed off`，标题原地不动，用户无手段。
2. `coreIsMetaActivity` 误杀「会话目标本身就是 issue/github 工作」的合理标题（`review github issue`、`issue 分析`）。
3. 拒绝 warning 不含被拒 core 与规则名，用户无法自查。

## 根因（已验证）

- force 路径 `locked = false` → 质量门必执行，命中即 return，无降级。
- `coreIsMetaActivity` 是纯词面匹配，无法区分「process label」与「目标是 issue 工作的 goal」——`review github issue`（goal）与 `GitHub Issue Review`（垃圾）词面相同，**词法白名单方案无效**（调研已证）。
- 质量门是 issue #10 为后台自动命名引入的（46 个历史 session 因垃圾 core 被手动改名），后台从严是刻意设计，不能放松。

## 设计决策

### D1. 质量门策略只拆分现有两条软规则（核心）

新增纯函数 `qualityGate(core, force)`，策略表：

| 规则 | 非 force（后台） | force（显式） |
|------|------------------|---------------|
| `coreIsNonGoal` | **拒绝**（现状） | **带警告接受**：标题使用正常的 `capTitle(coreRaw)` 规范化结果 |
| `coreIsMetaActivity` | **拒绝**（现状） | **接受**：歧义门仅用于后台 |

- `reject` = 不设标题；后台保持 issue #10 的从严策略。
- `accept-with-warning` = 标题照常经过 `capTitle` 后落盘，同时把规则名和被标记的 core 显示为 warning。
- `accept` = 正常设置标题。
- 两个规则在 force 下待遇不同，是因为分类器可靠性不同：`coreIsMetaActivity` 是歧义匹配（`review github issue` 可能是真实目标），force 下静默接受、不用 warning 哭狼；`coreIsNonGoal` 是 `^...$` 精确匹配的程序性标签（`方案确认`/`review`/`确认`），几乎不可能是真实目标，所以接受但必须 warning 提醒用户。
- `looksLikeError` **不加入本次新 core 质量门**。现有正则会把 `fix login bug` 判为 error；扩大其适用范围会误杀正常标题。它只保持原有的 anchor 丢弃用途。

### D2. 使用判别联合表达质量门结果

质量门返回值必须让 TypeScript 类型保证：凡是被标记的结果一定带 `rule`，不使用 `rule!` 非空断言。

```ts
export type QualityGateRule = "coreIsNonGoal" | "coreIsMetaActivity";

export type QualityGateDecision =
  | { action: "accept" }
  | { action: "reject"; rule: QualityGateRule }
  | { action: "accept-with-warning"; rule: "coreIsNonGoal" };
```

判定顺序保持现状：先 `coreIsNonGoal`，再 `coreIsMetaActivity`。force 只改变命中后的动作，不修改两个分类器本身。

### D3. 返回契约显式携带 warning

`runAutoRename` 的结果增加可选 `warning` 标志：

```ts
interface AutoRenameResult {
  title?: string;
  reason: string;
  warning?: boolean;
}
```

- 普通成功：有 title，`warning` 省略或为 `false`，UI 使用 `info`。
- force 带警告接受：有 title，`warning: true`，UI 必须使用 `warning`。
- 无 title 的失败：UI 使用 `warning`，保持现状。

通知级别由纯函数统一计算：

```ts
export function notificationLevelFor(
  title: string | undefined,
  warning = false,
): "info" | "warning";
// warning || !title => "warning"，否则 => "info"
```

`/autorename` handler 必须调用该函数；这样既不再只靠“是否有 title”猜测级别，也能用单元测试确定性验证 soft fallback 会显示 warning。`runAutoRename` 与 `runSerialized` 的返回类型标注都必须统一改为 `AutoRenameResult`，避免后者漏掉新增字段。

### D4. 被标记 core 的回显必须单行、安全、有界

质量门消息必须同时包含规则名和原始模型 core，但不得把不可信模型输出直接拼进日志。模块内部的 `quoteGateCore` 应：

1. 把连续空白（含换行、tab）折叠为单个空格并 trim；
2. 按 Unicode code point 截断到 60 个字符；
3. 用 `JSON.stringify` 加引号并转义引号、反斜杠和控制字符。

消息形态：

- 后台拒绝：`core rejected by quality gate (coreIsMetaActivity): "Issue list triage"`
- force 带警告接受：`renamed; quality gate flagged core (coreIsNonGoal): "方案确认"; force used normalized core fallback`
- 若最终 title 未变化，前缀必须是 `unchanged`，但仍保留完整 gate 信息并继续显示 warning。

### D5. 考虑后放弃的方案

- **goal 动词白名单**：对报告中的误杀案例无效（调研已证），且无法区分歧义词。
- **配置开关 qualityGateStrict**：force 本身就是手动放行通道，再加配置项是多余表面积（YAGNI）。
- **把 looksLikeError 加入新 core 门**：现有实现把普通的 `bug` 目标判为 error，不属于本 issue 的安全改动；若后续需要，应独立设计更窄的 hard-error 分类器。

## 组件契约与数据流

### lib/auto-rename-core.ts（纯函数，零 pi 依赖）

```ts
export type QualityGateRule = "coreIsNonGoal" | "coreIsMetaActivity";

export type QualityGateDecision =
  | { action: "accept" }
  | { action: "reject"; rule: QualityGateRule }
  | { action: "accept-with-warning"; rule: "coreIsNonGoal" };

export function qualityGate(core: string, force: boolean): QualityGateDecision;

export function formatQualityGateMessage(
  decision: Exclude<QualityGateDecision, { action: "accept" }>,
  core: string,
): string;

export function gateAwareOutcome(
  outcome: "renamed" | "unchanged",
  decision: Exclude<QualityGateDecision, { action: "reject" }>,
  core: string,
): { reason: string; warning: boolean };

export function notificationLevelFor(
  title: string | undefined,
  warning?: boolean,
): "info" | "warning";
```

- `qualityGate` 只负责策略分类。
- `formatQualityGateMessage` 负责安全回显规则名和 core；模块私有的 `quoteGateCore` 完成单行化、60 code-point 截断和 JSON 转义。`reject` 返回 `core rejected by quality gate (<rule>): <quoted-core>`；`accept-with-warning` 返回 `quality gate flagged core (<rule>): <quoted-core>`。
- `gateAwareOutcome` 负责把 `renamed` / `unchanged` 与质量门结果合并。普通 `accept` 返回 `{ reason: outcome, warning: false }`；`accept-with-warning` 返回 `{ reason: "<outcome>; <formatted-message>; force used normalized core fallback", warning: true }`，保证 unchanged 分支也不会丢失信息。
- `notificationLevelFor` 负责 UI 级别映射：`warning || !title` 时返回 `warning`，否则返回 `info`。

### index.ts（glue，改动最小）

`runAutoRename` 的处理顺序固定为：

1. 生成 `coreRaw`；锁定 core 路径不重新执行质量门，保持现状。
2. 对未锁定结果调用 `qualityGate(coreRaw, Boolean(opts.force))`。
3. `reject`：生成安全 reason、写 debug log、返回无 title 的失败结果。
4. `accept` / `accept-with-warning`：统一调用现有 `capTitle`，不另建“未规范化 raw title”路径。
5. 在判断 title 是否变化后，调用 `gateAwareOutcome("renamed" | "unchanged", decision, coreRaw)`。
6. changed 与 unchanged 两个返回分支都使用该函数生成的动态 `reason` 和 `warning`；禁止写死 `reason: "renamed"` / `reason: "unchanged"` 覆盖质量门信息。
7. `runAutoRename` 和 `runSerialized` 均使用 `AutoRenameResult` 返回类型；`/autorename` handler 调用 `notificationLevelFor(r.title, r.warning)` 决定 notification level。

- anchor 丢弃逻辑（`looksLikeError || coreIsNonGoal || coreIsMetaActivity`）不变。
- `coreIsMetaActivity` / `coreIsNonGoal` 函数本身不变。
- `looksLikeError` 的行为和测试不变。

## 非目标

- 不改后台非 force 的从严行为。
- 不改 `coreIsMetaActivity` / `coreIsNonGoal` / `looksLikeError` 正则。
- 不新增 hard-error 质量门。
- 不加配置项。
- 不改 prompt / 模型调用逻辑。

## 验收矩阵

自动化测试负责确定性地证明 gate 分支；真实模型输出不可控，因此用户实测只承担端到端烟测，不能替代 A1-A7。

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `qualityGate` 策略表 | 自动化验证（unit） | `./test/run-all.sh` | 后台 non-goal/meta 均 `reject`；force non-goal 为 `accept-with-warning`；force meta 为 `accept`；正常 core 两路均 `accept` |
| A2 | 正常 bug 目标不因本次修复被误杀 | 自动化验证（unit） | `./test/run-all.sh`，新增 `qualityGate("fix login bug", false/true)` | 两路均 `accept`；现有 `looksLikeError("fix login bug") === true` 测试保持不变，证明本次没有扩大该分类器范围 |
| A3 | gate 消息安全回显 | 自动化验证（unit） | `./test/run-all.sh` | reject/accept-with-warning 精确字符串包含规则与 core；换行/引号/ANSI 控制符不会产生多行注入；core 最多保留 60 code points |
| A4 | changed/unchanged 都保留 soft fallback 信息 | 自动化验证（unit） | `./test/run-all.sh` | `gateAwareOutcome` 对两种 outcome 均返回 `warning: true`，reason 含规则、core 和 normalized fallback；普通 accept 返回 `warning: false` |
| A5 | 存量纯函数行为不回归 | 自动化验证（unit） | `./test/run-all.sh` | 现有 `coreIsMetaActivity` / `coreIsNonGoal` / `looksLikeError` / `capTitle` / prompt 测试零修改且全部通过 |
| A6 | `index.ts` glue 编译与导入完整性 | 自动化验证（static） | `npx esbuild index.ts --bundle --format=esm --platform=node --outfile=/tmp/autorename-bundle-check.mjs --log-level=warning --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai` | 返回码 0，无 bundle error；`test/run-all.sh` 不能替代此项，因为它不导入 `index.ts` |
| A7 | UI notification level 映射 | 自动化验证（unit） | `./test/run-all.sh` | `notificationLevelFor(title, true) === "warning"`；无 title 为 warning；普通有 title 为 info |
| U1 | 真实 pi 会话复现 issue 场景 | 用户实测 | 新会话 → 发「给某 GitHub 仓库提交 issue」类意图 → `/autorename` | 命令设置标题，不再出现无标题的通用 `core rejected by quality gate; backed off` |
| U2 | force soft fallback 的真实 UI | 用户实测（条件性） | 当真实模型恰好产出 `coreIsNonGoal` core 时观察通知 | 标题仍设置；通知级别为 warning；通知含规则名和安全回显 core。模型未触发该分支时标记 `pending`，不能宣称通过 |

## 可测性拆分设计

- **`qualityGate(core, force)`**：纯函数，无 I/O、无状态。测试边界覆盖两条分类规则 × 两条运行路径、正常 core、空 core，以及 `fix login bug` 回归保护。
- **`formatQualityGateMessage(decision, core)` + 私有 `quoteGateCore`**：纯字符串函数。测试边界覆盖 reject / accept-with-warning、空白折叠、Unicode 60 code-point 截断、引号和控制字符转义。
- **`gateAwareOutcome(outcome, decision, core)`**：纯函数，统一生成 reason + warning。测试边界覆盖 renamed / unchanged / 普通 accept，防止任一 index.ts 返回分支丢失 warning 信息。
- **`notificationLevelFor(title, warning)`**：纯函数，确定性验证「有 title 的 soft fallback 仍显示 warning」、普通成功显示 info、无 title 显示 warning。
- **index.ts glue**：只负责调用上述纯函数、写状态和设置标题；用 A6 独立 bundle 验证语法与导入，用 U1/U2 验证真实 pi 交互。实现不得把策略、message、outcome 或 notification-level 逻辑重新内联进 index.ts。

## 风险与降级

- force 带警告接受可能落盘弱标题（如「方案确认」）——这是显式用户请求下的刻意取舍；warning 会说明规则，用户仍可用 `/name` 手动改名。弱 core 不会永久锁死：下一次后台刷新时 anchor 丢弃逻辑（`coreIsNonGoal` 命中）会丢弃它并重新调模型推导，自愈能力来自现有逻辑、无需新增代码。
- force 跳过 meta 门可能接受 `Issue list triage` 类弱标题——这是用户显式 force 与后台自动命名的策略差异；后台仍严格拒绝。
- U2 依赖模型实际输出，无法稳定触发；其不可复现状态必须记为 `pending`，自动化 A1/A3/A4/A7 才是该分支的确定性证据。
- 本次不新增 hard-error 门，避免 `looksLikeError` 的 `BUG` 误判扩大到新 core；若未来需要，另开 issue 设计更窄分类器。
