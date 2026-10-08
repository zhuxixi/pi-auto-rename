# spec：issue-driven 会话的标题反映 issue 主题（pi-auto-rename issue #7）

状态：approved（用户于 2026-10-08 确认设计）

## 目标

issue-driven 会话（用户起手 `hello`、意图主体在工具调用里）的标题应反映**所做 issue 的主题**，而不是流程标签（`issue认领处理`）；存量已锁死的垃圾标题应能**自愈一次**。

## 非目标（设计约束）

1. 不引入 `gh` 依赖、不联网——issue 标题只从 transcript 的 toolResult 解析（R1 已证明可用）。
2. 不改 `scanUserMessages`/`earlySelection` 的锚点语义——user 文本锚点保持不变，issue 证据是**独立第二通道**。
3. 不改质量门 force 语义（issue #5：force 下 meta 静默放行、non-goal 警告接受）。
4. 不处理「短命 hello 会话」（0.3–0.9 分钟即死、rename 未触发、标题停在 board fallbackName）——R1 已证明是另一个问题，follow-up 另开。
5. 不改标题形态决策（issue #5/早前决策）：仍不加 repo 前缀、不把 issue 编号写进标题。
6. 无证据会话（extractWorkRefs 返回 null）行为与现状**逐字节一致**。

## 决策表

| # | 决策 | 选择 | 备选（弃用原因） |
|---|---|---|---|
| D1 | 证据输入范围 | assistant toolCall 的 `arguments.command`（bash 字符串）+ toolResult 的 text 块；**不含** user 文本 | 混入 user 文本（污染锚点语义，破坏非目标 2） |
| D2 | 信号分类 | **claim**：`gh issue (edit\|close\|reopen\|comment) N`、分支/worktree slug `issue-N-<slug>`、路径 `github-issue-driven/<owner>/<repo>/issue-N/`；**view**：`gh (issue\|pr) view N`；**title**：同 toolResult 内 `title:\t<..>` 与 `number:\tN` 成对（plain）或 `"number":N … "title":"X"`（--json）；**slug**：claim 分支 slug 的 `<slug>` 段 | 只看 view（triage/list 会话会误中最后看的 issue） |
| D3 | 计分 | **每 issue 每类信号二元计次**（0/1），权重 claim=6、branch/path=3、view=1；dominant 需 total≥6（至少一个 claim）且 top ≥ 2×second，否则返回 null | 按出现次数累计（worktree 路径重复出现 50 次会虚高，R1 实测） |
| D4 | 权重注入 | `buildUserPrompt` 增第五参数 `evidence`；非空时在 ORIGINAL INTENT 前插入 `GITHUB ISSUE UNDER WORK (the session's actual work — its subject matter MUST be reflected in the core, condensed not verbatim): #N <title or slug>` 独立块 | 拼进 ORIGINAL INTENT（锚点语义会被稀释） |
| D5 | system prompt 规则替换 | 金测中两行显式改写：`NOT the issue/PR title verbatim` 行改为「当 GITHUB ISSUE UNDER WORK 块存在时，core 必须浓缩反映该 issue 的主题（可用少量词缀表达阶段差异：调研/实现）；块不存在时沿用原规则」；删除 `Two sessions on the same issue must have DIFFERENT cores` 的强约束，改为「优先主题可辨，阶段词仅在需要区分时附加」 | 保留原两行只加新规则（两条规则直接矛盾，弱模型无所适从） |
| D6 | 锁与自愈 | state 增 `evidenceKey?: string`（如 `issue:460`）；当「当前 evidenceKey 非空且 ≠ state.evidenceKey」时**忽略 coreLocked 重推一次**（prompt 带 Previous title + 指令：旧标题已反映主题则保持措辞不变）；成功后写入新 evidenceKey 并锁定 | 每周期都重推（模型费+标题抖动）；只在 core 是垃圾时重推（`issue认领处理` 类过不了现有门，判据不可靠） |
| D7 | 质量门补词 | `META_ACTION` 中文侧补 `认领\|处理\|调研\|关闭\|筛选\|评估\|跟进\|闭环`（META_SUBJECT 不变，仍要求 core 含 issue/pr/github）；force 行为不变 | 英文侧加 claim/close（本机负样本里无此形态，YAGNI） |
| D8 | slug 机械兜底 | 模型失败 + 有 slug + 无 title 时：core = slug 的 kebab 展开小写词组（`test-config-isolation` → `test config isolation`），走 capTitle | 无兜底（slug 会话 33% 拿不到任何标题改进） |
| D9 | 金测更新 | `GOLDEN_AUTO_SYSTEM_PROMPT` 与 `buildUserPrompt auto strict golden` 按新 prompt **显式重写**；无 evidence 时两金测仍锁「与旧行为一致」的等价断言（D5 改的是 system prompt 恒定行，属全局变更，金测字符串本身更新；`buildUserPrompt` 无 evidence 输出的字节形态除 system 行外不变） | 保留旧金测字符串（与实现直接冲突） |

## 组件契约

### lib/auto-rename-core.ts（纯函数，全部可测）

```ts
interface WorkEvidence {
  issueNumber: number;      // dominant issue
  title: string;            // "" when not captured
  slug: string;             // "" when absent
  key: string;              // `issue:460` — state 比对用
}
// branch = sessionManager.getBranch() 的原始数组
export function extractWorkEvidence(branch: any[]): WorkEvidence | null;
export function evidencePromptBlock(e: WorkEvidence): string;   // D4 的块文本
export function slugToCore(slug: string): string;               // D8
// D6 重推判据（纯）：state.evidenceKey vs 当前 e.key
export function shouldReDerive(st: {coreLocked?: boolean; evidenceKey?: string}, e: WorkEvidence | null): boolean;
// buildUserPrompt 增参 evidence（默认 null，旧调用点不变）
export function buildUserPrompt(force, lang, early, recent, prevTitle, evidence?: WorkEvidence | null): string;
// META_ACTION 扩词后 coreIsMetaActivity 语义验证（现有导出不动）
```

### index.ts（入口，side-effect 最小化）

- `runAutoRename`：调 `extractWorkEvidence(branch)` 一次；`shouldReDerive(st, evidence)` 为真时把 `locked` 视为 false 并在 prompt 带 `prevTitle`（含"已反映主题则保持"指令）；新 core 成功后 state 写 `evidenceKey`。
- 其余（cooldown、gate、board sync、通知）零改动。

## 数据流（修复后）

```
branch ──scanUserMessages──> earlySelection ──┐
      └─extractWorkEvidence─> WorkEvidence ───┤
                                              v
                        buildUserPrompt(force, lang, early, recent, prevTitle, evidence)
                                              v
                         generateCore（shouldReDerive 真时无视 coreLocked 调模型）
                                              v
                  qualityGate（META_ACTION 扩词；force 语义不变）→ capTitle → setSessionName
```

## 降级

- 抽取无 dominant → 无 evidence 块 → 行为与现状一致（非目标 6）。
- evidence 在但模型失败 → 保留旧标题退避（现状语义）；有 slug 且无 title 时走 D8 机械兜底。
- `--json` 嵌入大结果导致 title 解析 miss → 只有 slug/编号也能走 D4 块（模型看不到标题但有 slug 词组）。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 证据抽取 | 自动化验证（unit） | `test/run-all.sh`（esbuild+node） | plain view 成对 title/number、--json 形态、claim/view/path/slug 四类信号各正/负样例；多 issue 无 dominant（top<2×second 或无 claim）返回 null；纯 view-only 返回 null；二元计次（同一 slug 重复 50 次不涨分） |
| A2 | prompt 构造 | 自动化验证（unit） | 同上 | evidence 非空时块存在且位于 ORIGINAL INTENT 之前、含编号与主题；evidence 为 null 时输出与 D9 金测一致；force/zh/en 分支不回归 |
| A3 | 金测更新 | 自动化验证（unit） | 同上 | 新 GOLDEN 与实现逐字节一致；无 evidence 的 buildUserPrompt 输出除 system 恒定行外与旧输出一致 |
| A4 | 质量门扩词 | 自动化验证（unit） | 同上 | `issue认领处理`/`issue初步调研`/`未认领issue筛选` 后台 reject；`qualityGate(_, true)` force 全放行不变；`修复登录越界`/`fix login bug` 等 clean 样例不受扩词误伤 |
| A5 | 重推判据与自愈 | 自动化验证（unit） | 同上 | `shouldReDerive`：evidenceKey 空→有证据 = true；相同 key = false；无证据 = false；coreLocked=true 且 key 变化 = true |
| A6 | slug 兜底 | 自动化验证（unit） | 同上 | `test-config-isolation` → `test config isolation`（capTitle 后 ≤24 列）；空 slug 返回 "" |
| U1 | 真实 issue-driven 会话 | 用户实测 | 在本机 2–3 个存量垃圾标题会话（含 view_0b5f8f44b5 类似形态）与**本 session 自身**（正在处理 #7，天然 dogfood）上等下一轮周期 rename 或执行 `/autorename`，观察新标题 | 标题反映 issue 主题（如 #460 会话 → 配置隔离类标题），非流程标签；无证据的普通会话标题不变 |
| U2 | board 展示 | 用户实测 | agent-board 列表刷新后查看 name 列 | 新标题 ≤24 显示列无截断断裂；paused 会话不动 |

### 可测性拆分设计（A 类功能点的硬约束）

- `extractWorkEvidence(branch)`：内部拆 `collectSignals(branch)`（只做 entry→信号事件归约，无判定）与 `pickDominant(scores)`（纯判定，可独立用构造数据测边界：无 claim、平分、二元计次）。测试边界：信号归约不判定、判定不吃原始 transcript。
- `evidencePromptBlock(e)`：纯字符串拼装，与 `buildUserPrompt` 的组装分层——后者只决定块的**位置**，块文本单测锁内容。
- `shouldReDerive(st, e)`：纯布尔函数，禁止内联进 runAutoRename（侧效应层不可测）。
- `slugToCore(slug)`：纯函数；capTitle 复用现有实现，不重复写截断逻辑。
- `coreIsMetaActivity` 扩词只改正则常量与注释，函数签名/语义不变——A4 用行为断言锁，不用正则快照锁（避免脆弱）。
- index.ts 侧效应层不新增判定逻辑，只做「调用纯函数 + 传参 + 写 state」。

## 风险与回滚

- 标题抖动风险（D6 重推把已好的标题改写）：prompt 带 Previous title + 保持指令缓解；重推每 evidenceKey 至多一次。
- 扩词误伤（如真实目标就是 `issue 处理` 类的会话）：META_SUBJECT 前置条件保证只影响含 issue/pr/github 的 core；被拒后走 evidence 重推，产出更好标题而非空拒绝。
- 回滚：纯函数新增 + prompt 行替换 + 正则扩词，revert 单个 commit 即可；state 新字段 `evidenceKey` 向后兼容（旧 state 无该字段 = 空）。
