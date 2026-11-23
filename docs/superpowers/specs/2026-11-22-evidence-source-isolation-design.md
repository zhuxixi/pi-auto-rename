# Issue #13 spec：工作证据按来源归约，消除文档/搜索污染并保留结果观察

Drafted: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-13T08:54:52+08:00
Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-16T08:49:42+08:00 — round 1（R1-D1 title-only 验收、R1-D2 纯函数导出契约、R1-D3 U1 部署自证命令）

- Repo：`zhuxixi/pi-auto-rename`
- Baseline：`main@0389c9d`（v0.4.1）
- 状态：approved（用户于 2026-11-22 确认设计）
- 调研：`research/01-signal-provenance-and-replay.md`
- 计划 worktree（设计批准后才创建）：`issue-13-evidence-source-isolation`

## 1. 问题与根因

`extractWorkEvidence()` 要回答「这个会话正在做哪个 issue」。当前 `scanIssueSignals()` 对 toolCall 的整个 `arguments` 对象做 JSON 序列化后匹配正则，对 toolResult 的 branch/path 又与真实执行同权计分，导致以下文本被误当作工作动作：

1. `rg "gh issue comment 188"` 的搜索模式产生 #188 mutate；
2. write/edit 正文中的测试命令、分支和路径样例产生 mutate/branch/path；
3. bash heredoc 正文中的命令引用产生信号；
4. `find`、历史会话回显等 toolResult 中的 branch/path 与创建/进入工作上下文同为 3 分。

事实校正：v0.4.1 的 toolResult 分支不匹配 mutate/view，只匹配 branch/path 并解析标题。旧 `scan-selfpollution.mjs` 让 toolResult 也产生 mutate/view，因此旧「393 views / 44 changed」不是当前真实实现的精确对照，不能作为本次验收的唯一真值。

## 2. 目标

1. 只有实际命令和实际目标路径能产生执行型 claim；搜索模式、write/edit 正文、heredoc 正文不能产生这些信号。
2. toolResult 继续提供真实工作观察（如接手既有 worktree），但其 branch/path 权重低于执行型信号。
3. 保持 #7 的每 issue、每类信号二元计次；同一类信号在执行和观察中同时出现时取最高分，不累加。
4. 保持 #11 的唯一 mutate 短路、2x 歧义判据和显式 tie-break。
5. 用基线真实实现与修复后真实实现做同批会话对照，而非只运行策略副本。

## 3. 非目标与保证边界

1. 不改 `index.ts`、prompt、质量门、`coreLocked`、`evidenceKey`、`shouldReDerive` 或标题格式。
2. 不调整 `mutate=6 / 执行 branch=3 / 执行 path=3 / view=1`，不放宽 2x 判据。
3. 不完全禁用 toolResult，不引入网络、`gh` 调用或 git 工作区状态查询；标题仍只从已有 transcript 解析。
4. 不实现完整 shell parser，不处理任意 wrapper、command substitution 或动态生成的命令。无法确认是实际 `gh` 命令时，宁可不产生 mutate/view。
5. bash 非 `gh` 段的 branch/path 仍按现有正则从剥离 heredoc 后的命令本体提取；搜索参数里的 branch/path 仍可能形成残余弱噪声。本 issue 保证消除伪 `gh` mutate/view、文档正文和结果同权三类已量化问题，不声称解决所有文本歧义。
6. 不批量改写已结束会话的标题；存量会话只有在扩展再次运行且满足既有重推条件时才自愈。
7. 不在本 spec 内包含发版、push、PR、merge 或部署授权。

## 4. 方案选择与量化依据

在当前 434 个本机 view 上做只读内存原型对照：

| 方案 | changed | recovered | lost | flipped |
|---|---:|---:|---:|---:|
| 清理调用侧 + 禁用 toolResult 信号 | 44 | 8 | 36 | 0 |
| 只清理调用侧 | 17 | 15 | 2 | 0 |
| 清理调用侧 + 结果降权 + 同类取最高分（本方案） | 11 | 10 | 1 | 0 |
| 本方案再要求纯结果必须两类兼有 | 45 | 15 | 30 | 0 |

这些数字用于选择设计，不是实现验收结果。推荐方案的 1 个 lost 是 `view_9ba08f4367` 从与鼠标排查主题明显不相称的 #10640 退为 null；#178 纯结果证据保持，目标 `view_692d8904a2` 从 null 恢复 #11。最终仍以 A7 的真实实现重放为准。

## 5. 决策表

| # | 决策 | 选择 | 备选（弃用原因） |
|---|---|---|---|
| D1 | toolCall 输入字段 | 按工具白名单读取实际执行字段，禁止默认 `JSON.stringify(arguments)` | 全参数扫描（正文污染）；只保留 bash（丢 git_worktree/subagent cwd 的真实上下文） |
| D2 | bash 命令识别 | 只读原始 `command`；先剥 heredoc，再把未被引号包裹的 shell 分隔符作为命令段边界；只有段首实际命令为 `gh` 才识别 mutate/view | 全命令任意位置匹配（rg 搜索模式会误中）；完整 shell AST（超出本 issue 范围） |
| D3 | write/edit 与其他工具 | write/edit 只读目标 `path`；git_worktree 只读 `path`/`branch`；subagent 只读 `cwd`；read 与其他未知工具不产生执行型 claim | 扫 write/edit 全文（污染）；扫 subagent task 正文（引用会污染） |
| D4 | toolResult 证据 | 只产生 observedBranch/observedPath 与 title；观察 branch/path 各 1 分；title 解析保持现有行为 | 全禁（丢 #178）；保持 3 分（目录枚举与真实执行同权） |
| D5 | 同类信号计分 | 执行分支存在则 branch=3，否则观察分支存在则 branch=1；path 同理；同类不叠加 | 3+1 累加（破坏 #7 二元计次，原型多恢复 8 个歧义较高会话） |
| D6 | dominant 判定 | claim 包括执行 mutate/branch/path 与观察 branch/path；唯一执行 mutate 短路与其余判定顺序不变 | 纯观察必须两类兼有（30 个 lost）；改阈值（#11 已否决） |
| D7 | slug/title | 沿用现有首次捕获与 redaction；观察通道可提供 slug/title，但 title 自身不是 claim | 忽略结果 title（会破坏已有标题提取） |
| D8 | 文档 | README 说明执行/观察来源和 1 分观察权重；`test/docs-timing.test.ts` 加防漂移断言 | 文档仍写笼统的 tool calls/results 同权 |

## 6. 组件契约

### 6.1 工具字段映射（D1/D3）

| 工具 | 执行型输入 | 允许信号 |
|---|---|---|
| `bash` | `arguments.command` 字符串 | mutate/view；branch/path |
| `write` / `edit` | `arguments.path` 字符串 | branch/path |
| `git_worktree` | `arguments.path`、`arguments.branch` | branch/path |
| `subagent` | `arguments.cwd` | branch/path |
| 其他（含 `read`） | 无 | 无执行型信号 |

write/edit 的 `content`、`oldText`、`newText` 一律不得进入信号扫描。subagent 的 `task`、`message` 一律不得进入信号扫描。

### 6.2 bash 命令段识别（D2）

新增导出的纯函数（供 A2 直接做字符串单元测试）：

```ts
export function stripHeredocBodies(command: string): string;
export function splitCommandSegments(command: string): string[];
export function ghIssueAction(segment: string): { kind: "mutate" | "view"; issueNumber: number } | null;
```

契约：

- `stripHeredocBodies` 在原始字符串上去除 `<<EOF` / `<<-EOF` / 引号 delimiter 的正文；不得对 JSON 转义后的字符串做 heredoc 正则。
- `splitCommandSegments` 识别未包裹在单/双引号内的换行、`;`、`|`、`||`、`&&`、后台 `&`；引号内的分隔符不是命令边界。反斜杠转义按 shell 字面规则跳过下一个字符。
- `ghIssueAction` 去掉段首空白、环境变量赋值和可选 `command` wrapper 后，只有首命令为 `gh`、第二个词为 `issue`，且子命令为 `edit|close|reopen|comment|view` 才返回结果；issue 编号取子命令后的独立十进制 token。
- `rg "gh issue comment 188"`、多行引号字符串里的 `gh issue comment 188`、heredoc 正文均返回 null。
- 不支持的动态/wrapper 形态返回 null，不尝试猜测。
- heredoc 剥离后的所有 bash 命令段仍可提取 branch/path；只有 mutate/view 受 `ghIssueAction` 限制。

### 6.3 信号结构与计分（D4/D5/D6）

`IssueSignals` 保持导出，新增可选观察字段以兼容既有构造方：

```ts
export interface IssueSignals {
  mutate: boolean;
  view: boolean;
  branch: boolean;             // 执行型 branch
  path: boolean;               // 执行型 path
  observedBranch?: boolean;    // toolResult branch
  observedPath?: boolean;      // toolResult path
  slug: string;
  title: string;
}
```

rank 的唯一计分公式：

```text
branchScore = branch ? 3 : observedBranch ? 1 : 0
pathScore   = path   ? 3 : observedPath   ? 1 : 0
w = (mutate ? 6 : 0) + branchScore + pathScore + (view ? 1 : 0)
```

`pickDominant()` 的判定顺序保持：空 → 无 claim → 唯一执行 mutate 且为 top 短路 → top 不足 second 的 2 倍则 null → top。唯一变化是「无 claim」判据变为：

```text
!(mutate || branch || path || observedBranch || observedPath)
```

观察信号不触发唯一 mutate 短路；toolResult 仍不得设置 mutate/view。

### 6.4 保持不变的接线

`extractWorkEvidence(branch)` 的签名与 `WorkEvidence` 返回结构不变；流程仍为 `scanIssueSignals → rank → pickDominant → WorkEvidence`。`captureIssueTitles()` 可继续从全部 toolResult 文本捕获标题，但捕获标题本身不产生 claim 或分数。

## 7. 数据流

```text
assistant toolCall
  ├─ bash command ──剥 heredoc / 命令段识别──> 执行 mutate/view/branch/path
  ├─ write/edit path ─────────────────────────> 执行 branch/path
  ├─ git_worktree path+branch / subagent cwd ─> 执行 branch/path
  └─ 其他参数/正文 ───────────────────────────> 丢弃

toolResult text
  ├─ branch/path ─────────────────────────────> observedBranch/observedPath（各 1 分）
  └─ title+number ────────────────────────────> 标题捕获（不计分）

信号 map ──同类取最高分──> rank ──既有 pickDominant 顺序──> WorkEvidence | null
```

## 8. 失败与降级

- 无 dominant：返回 null，沿用现有无 evidence 路径。
- 不支持的 bash 语法：不产生该段的 gh mutate/view；其他结构化工具证据仍可用。
- toolResult 只有标题：可补全已有 evidence 的 title，但不能单独认领 issue。
- 模型失败、质量门拒绝、slug fallback 等均沿用现有行为，本 spec 不改。
- 某个观察信号被降噪后导致 null：这是有意的保守降级，不自动用最后查看的 issue 填充。

## 9. 验收矩阵

| ID | 功能点 / 决策 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 工具字段映射（D1/D3） | 自动化验证（unit） | `./test/run-all.sh`；构造 write/edit/subagent/read/bash 混合 transcript | write/edit 正文和 subagent task 中的 `gh issue comment 188`、`issue-188-x10-release`、driven path 不产生信号；write/edit 目标 path、git_worktree path/branch、subagent cwd 正常产生 branch/path；read path 不产生执行 claim |
| A2 | bash 真命令与文档剥离（D2） | 自动化验证（unit） | 同上；覆盖命令段首 gh、环境变量前缀、`command gh`、rg 搜索、多行引号、三种 heredoc 形态 | 真 `gh issue comment/view N` 分别产生 mutate/view；搜索文本、引号内文本和 heredoc 正文均不产生；不支持的 wrapper 返回 null |
| A3 | 观察降权、同类最高分与 title-only 边界（D4/D5/D7） | 自动化验证（unit） | 同上；构造执行 branch + 观察 branch 同 issue、仅观察 branch/path 的竞争项、仅有 toolResult title/number 的 issue，以及 title 补全已有 dominant 的样例 | 同类执行+观察总分只算 3，不得算 4；纯观察 branch/path 各算 1；toolResult 不产生 mutate/view；title-only 返回 null，title 只能补全已有 dominant 的返回标题、不能单独认领 |

| A4 | 纯结果真实证据保留（D4/D6） | 自动化验证（unit） | 复刻 `view_41be5cd13c` 最小结构：#178 observedBranch+observedPath，#33 仅 observedBranch，#170/#182 仅 observedPath | 判出 #178（2 分，对三个 1 分竞争项满足 2x），且 slug 可来自结果 |
| A5 | #13 综合复现 + #11 不回归（D2/D4/D5/D6） | 自动化验证（unit） | 一组构造真实 #11 执行证据与 #188 的 rg/write/heredoc/find 污染；另一组保留 #11 的 13-vs-7 与多 mutate 用例 | 综合复现返回 #11；既有唯一 mutate 短路、唯一 mutate 非 top、多 mutate、tie-break 行为不变 |
| A6 | 既有行为回归 | 自动化验证（unit） | `./test/run-all.sh` 全量 | 全部测试文件通过；view-only→null、无 claim→null、title plain/JSON 双向解析、prompt/quality/state 等既有断言不回归 |
| A7 | 全机真实实现对照（D1–D6） | 自动化验证（integration/replay） | 新增仓库外 `research/verify-13.mjs`：从 main 基线与实现 worktree 分别 esbuild 到新 bundle；每个 view 只读一次为内存 branch，同一份输入分别调两个真实 `extractWorkEvidence`；输出 `scan-13-verified.json`，不得 import 会写文件的旧扫描脚本，不覆写旧研究 JSON | (i) `flipped=0`（双方非 null 但 issue 不同）；(ii) `view_41be5cd13c` 双方均 #178、`view_eff2b7b9ba` 双方均 #188；(iii) fixed 对 `view_692d8904a2`=#11、`view_5b344bae75`=#7、`view_9ba08f4367`=null；(iv) 所有 recovered/lost 及 views/skipped 落盘，除上述 #10640 外出现新的 lost 即失败；新增 view 的额外 recovered 必须逐条列出供 CR 审查 |
| A8 | 构建与文档（D8） | 自动化验证（static/build） | `npx esbuild lib/auto-rename-core.ts --bundle --format=esm --platform=node --outfile=<临时目录>/auto-rename-core.mjs`；`./test/run-all.sh` 中新增 README 断言 | 构建零报错；README 明确执行 branch/path=3、观察 branch/path=1、同类取最高分及 write/edit 不扫正文；不得再描述为所有 toolCall 参数同权扫描 |
| U1 | 部署后真实会话 dogfood | 用户实测 | 正式合并/发版并获得部署许可后执行：① 先运行 `grep -c observedBranch ~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/lib/auto-rename-core.ts || true` 记录更新前基线；② `pi update --extensions`，重开 Pi 会话或 `/reload`；③ 再运行同一 grep，必须非零，并确认副本含观察权重实现；④ 在处理 #13 的真实会话执行 `/autorename`，再观察 `/autorename-status` 与 session state | 更新后的实际 npm 副本自证通过；当前证据判为 #13，标题反映「证据来源/文本污染修复」而非 #188/#11 主题；无 evidence 的普通会话标题不变。若部署、自证或实测未执行，状态必须记 pending，不得宣称 U1 通过 |

## 10. 可测性拆分设计（硬约束）

- `stripHeredocBodies`、`splitCommandSegments`、`ghIssueAction` 都是独立且导出的纯函数；A2 直接 import 并测字符串输入，不依赖 Pi session 或 shell 进程。
- 工具字段选择集中在 `scanIssueSignals` 的 toolCall 归约层；不得在每个正则里分散判断工具名。A1 通过构造 entry 测归约边界。
- branch/path 的执行与观察标记分开保存；rank 是唯一权重计算点。A3 不通过调用 `pickDominant` 间接猜权重，而是经 `extractWorkEvidence` 的可区分构造验证总分效果。
- `pickDominant` 继续只吃 ranked 列表，不读原始 transcript；除 observed claim guard 外不新增分支。
- A4/A5 使用最小内存 transcript，不读取本机 board；只有 A7 可以读取真实会话。
- A7 的基线与 fixed 必须来自真实代码 bundle，禁止复制评分函数作为被验对象；同一 view 的两侧共用同一次 JSONL 解析，避免活会话在两次读取间变化。
- `index.ts` 不新增判定逻辑，本 issue 无该文件改动。

## 11. 部署与执行路径

本机 Pi 从 `~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/` 的 npm 副本加载扩展，而不是从 git checkout 加载。因此 worktree 测试和 A7 只证明代码行为，不等于 U1 已部署。

U1 的正式前置是：设计批准 → worktree 实现/CR/PR → 用户批准 push/PR/merge → 按仓内 release 流程发 patch → 用户批准本机更新。临时复制到 npm 副本不属于本 spec 的默认路径，除非用户另行明确授权。

部署自证应检查实际 npm 副本的 `lib/auto-rename-core.ts` 含 `observedBranch` 与观察权重实现；只看仓库 HEAD 或版本字符串不算自证。

## 12. 风险与回滚

- **残余 bash 噪声**：非 gh 段的 branch/path 仍是文本正则；本 spec 明确保留，不能用「彻底消除所有污染」宣传。
- **观察降权改变歧义比例**：可能让部分原本 null 的真实工作恢复，也可能让弱证据判定退 null；A7 对全部差异落盘并禁止非空翻转。
- **命令段解析边界**：不支持的 shell 形态会漏掉 gh 信号，但不会把搜索文本升级成写操作；既有其他证据可继续参与。
- **回滚**：改动集中在 `lib/auto-rename-core.ts`、测试和 README；revert 对应实现 commit 即可，无 state migration、无外部数据写入。
