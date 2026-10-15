# Issue #11 — 2x 主导判据误杀唯一 mutate 的 top：短路口修复 + 全机零回归

- Issue: https://github.com/zhuxixi/pi-auto-rename/issues/11
- Kind: bug — 判据缺陷修复 + 回归保护（无新功能、无 state 变更）
- Repo: `zhuxixi/pi-auto-rename` · baseline `main` @ `cf23ad7` · worktree `issue-11-evidence-dominance`
- Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-15T00:20:00Z
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-15T00:45:00Z — round 1（R1-G1 部署前置、R1-G2 A5 绑真实实现、R1-D1 文档交付物、R1-D2 措辞边界、R1-D3 平分排序钉死）
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-15T01:05:00Z — round 2（R2-G1 A7 用例可区分性、R2-G2 U1 确定性构造 + A/B 对照、R2-D1 evidenceKey 确认方式、R2-D2 A5 相对量断言 + 论域快照、R2-D3 A8 钉死具体字符串、R2-D4 多 mutate 表述去绝对化）
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-15T01:30:00Z — round 3（R3-D1 A8 发布门解耦、R3-D2 U1 前置条件补 issue-M 子目录依赖、R3-D3 A5 改子集式断言）
- 调研依据：`~/.claude/github-issue-driven/zhuxixi/pi-auto-rename/issue-11/research/01-root-cause-and-quantification.md`

## 问题与根因（结论先行）

`extractWorkEvidence()` 用"top ≥ 2×second"的单一比例判据消解歧义，导致"唯一 mutate 的 top"被 runner-up 的噪声分数误杀：实测样本 `view_eff2b7b9ba` 为 `13 vs 7`（188 是全会话唯一被 `gh issue comment` 的 issue），差 1 分即返回 null，标题退回流程标签并锁死。

全机 390 view 量化确认该判据的净损失：**8 个 view 存在"唯一 mutate 且为 top"却返回 null**，它们的标题多为流程标签（如 `议题驱动研发流程`、`开放问题优先级评估`、`issue validity`）。同时，放宽比例（1.5x）会让 7 个原本正确的判定变 null，收紧 path 语义（仅 write/edit 计 claim）会让 6 个变 null——两者都是净损失，否决。

## 目标 / 非目标

**目标**

1. 当 ranked 中恰有一个 issue 持有 mutate 信号、且它就是 top 时，直接判为 dominant，跳过比例比较。
2. 在全机扫描上达到研究基线：恢复 8 个、回归 0 个（non-null 131 → 139）。该主张必须由**修复后的真实实现**产出（R1-G2）。
3. 落实 issue #7 spec 已声明但未实现的可测性拆分：判定段抽为独立纯函数 `pickDominant`；同时钉死同分排序（R1-D3）。
4. 行为文档同步：README 的 evidence 段落改写（去掉"纯 2x"表述），CHANGELOG 增 Fixed 条目并 bump patch 版本——后者同时是 U1 部署前置的版本锚点（R1-D1）。

**非目标**

1. 不放宽 2x 比例（实测 7 个回归）。
2. 不改 path 信号的读/写语义（实测 6 个回归）。
3. 不引入"claim 深度"扩展来处理多 mutate 场景（triage 会话边界未被证实，留作 follow-up）。
4. 不改权重常量（`W_MUTATE=6/W_BRANCH=3/W_PATH=3/W_VIEW=1`）、信号正则、prompt、质量门、锁策略。
5. 不改 `index.ts` 侧效应层，不新增 state 字段。
6. 不处理存量已锁死标题的会话（需要 `/autorename` 手动触发；本 issue 只消除未来的误杀）。

## 决策表

| # | 决策 | 选择 | 备选（弃用原因） |
|---|---|---|---|
| D1 | 判据修改 | **唯一 mutate 短路**：`mutateHolders.length === 1 && mutateHolders[0].n === top.n` → 直接返回 top | 提高 mutate 权重（语义更弱：仍需与噪声比比例，浅 mutate 场景失效） |
| D2 | 比例判据 | 其余情况保持 `top.w < 2 × second.w → null` | `1.5× + 领先≥4`（全机 7 个回归，净损失） |
| D3 | path 语义 | 保持读/写同权 | 仅 write/edit 目标计 claim（全机 6 个回归，净损失） |
| D4 | 多 mutate 场景 | 不改变现有路径：仍走 2x 判定，结果取决于分数（board 现存 3 例多 mutate 且基线为 dominant：view_1b043f0c44→#103、view_3cabf8ed20→#178、view_8540223cd5→#541） | `mutate + branch + path` 三重深度判据（能多恢复约 3 例，但 triage 会话边界未证实、未量化误认风险） |
| D5 | 自愈 | 不新增 | —— `shouldReDerive` 在 `evidenceKey` 空、evidence 非空时已返回 true；修复本判据后该路径自动生效 |
| D6 | 与 issue #7 非目标 6 的关系 | **有意修订**：无证据会话仍返回 null 且行为不变；"唯一 mutate 且为 top"不再算无证据 | 保留原样（本 issue 即为此而开） |
| D7 | 测试策略 | 新增 3 条用例（短路命中 / 多 mutate 保持 null / 唯一 mutate 非 top 保持 null）+ 既有全量回归 | 只加正向用例（边界无保护） |
| D8 | 验收证据 | 除单测外，用研究脚本对修复后实现重跑全机扫描 | 仅单测（无法证明零回归） |

## 组件契约（`lib/auto-rename-core.ts`）

```ts
// 新增导出：判定段独立纯函数（issue #7 spec 的可测性拆分要求）
export interface IssueSignals {                 // 原为模块内部 interface，本次一并导出
  mutate: boolean; view: boolean; branch: boolean; path: boolean;
  slug: string; title: string;
}
export interface RankedIssue {
  n: number;                                    // issue number
  s: IssueSignals;                              // 信号明细
  w: number;                                    // 加权总分
}
// 排序不变式（R1-D3）：同分时 issue 号小者优先，必须显式 tie-break——
// 不得依赖 JS 引擎的稳定排序（否则研究副本 a.n-b.n 与实现插入序在平分时会分歧）
//   ranked.sort((a, b) => b.w - a.w || a.n - b.n)
export function pickDominant(ranked: RankedIssue[]): number | null;

// 签名与返回类型不变；内部改为 scanIssueSignals → rank（含 tie-break）→ pickDominant
export function extractWorkEvidence(branch: any[]): WorkEvidence | null;
```

`pickDominant` 的判定次序（不变式）：

1. 空 ranked → null。
2. top 无任何 claim（mutate/branch/path 全为假）→ null。
3. **新增**：mutate 持有者恰为 1 个且是 top → 返回 `top.n`（唯一写操作即排除歧义，不再比比例）。
4. second 存在且 `top.w < 2 × second.w` → null（歧义）。
5. 否则返回 `top.n`。

边界（有意的行为）：

- 唯一 mutate 者不是 top（例如 top 是无 mutate 的 `branch+path+view=7`，mutate 者 6 分）→ 走第 4 步比例判定，通常 null。理由：会话为 A 建了工作容器却把唯一写操作给了 B，歧义真实存在。
- 两个及以上 mutate 持有者（triage 会话）→ 走第 4 步 2x 判定，结果取决于分数（board 现存 3 例多 mutate 且基线为 dominant 的 view，本 issue 不改变该路径行为）。

## 数据流

```
branch ──scanIssueSignals──> sigMap ──rank(w=mutate6|branch3|path3|view1; tie→n asc)──> ranked
                                                                              │
                                        ┌─────────────────────────────────────┤
                                        │ pickDominant(ranked)                │
                                        │  1) empty → null                    │
                                        │  2) no claim → null                 │
                                        │  3) unique-mutate top → n   【新】   │
                                        │  4) top < 2×second → null           │
                                        │  5) → top.n                         │
                                        └─────────────────────────────────────┘
                                                                              v
                                                              WorkEvidence { n, title, slug, key }
```

`index.ts`、prompt、质量门、state 全部零改动。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 唯一 mutate 短路 | 自动化验证（unit） | `./test/run-all.sh`，新增用例：top `m+b+p+v`(13) vs second `b+p+v`(7) | 返回 top 的 `issueNumber`（等价 `view_eff2b7b9ba` 实测形态） |
| A2 | 多 mutate 歧义保护 | 自动化验证（unit） | 既有用例 `ambiguous claims -> null`（两个 issue 各持 mutate） | 仍返回 null（行为不变） |
| A3 | 唯一 mutate 非 top 边界 | 自动化验证（unit） | 新增用例：top 无 mutate 但 `b+p+v`(7) vs 唯一 mutate 者(6) | 返回 null（不进短路分支） |
| A4 | 既有行为回归 | 自动化验证（unit） | `./test/run-all.sh` 全量 | 既有全部用例通过（view-only→null、二元计次、无 claim→null、title 成对解析等） |
| A5 | 全机零回归（绑真实实现） | 自动化验证（脚本） | 新增 `research/verify-11.mjs`：**不得 import `scan-11.mjs`**（它一 import 就全量扫描并写文件）；复用其逻辑框架，esbuild 源指向**实现 worktree 的 lib**，bundle 到新文件 `research/arc-bundle-fixed.mjs`（不覆写基线真值 `arc-bundle.mjs`）；在同一批 view 上用基线 `arc-bundle.mjs` 重算 base 真值 | **子集式断言（R3-D3）**：(i) 研究基线 `scan-11-rules.json` 的 `perRule.A.recoveredViews` 所列 8 个 view 必须全部 recovered；(ii) 每个 view 上 `realN === decisions.A`（真实现与规则 A 副本逐 view 全等）；(iii) `lost=0`（结构性：短路未命中时逐字节退回 base 的 2x 路径）；(iv) 额外 recovered（若有）必须来自研究扫描之后新增的 view，记入 `scan-11-verified.json` 备注。基线产物一律不覆写 |
| A6 | 类型/构建 | 自动化验证（static） | `npx esbuild lib/auto-rename-core.ts --bundle --format=esm --platform=node --outfile=/tmp/x.mjs` | 零报错（pi 直接跑 TS，无独立类型检查步） |
| A7 | 同分排序不变式 | 自动化验证（unit） | 新增用例：构造**插入序与 issue 号序相反**的平分形态——transcript 先出现 n 大者（`b+p+v`=7），后出现 n 小者（`m+v`=7，唯一 mutate 持有者） | top 取 issue 号小者（即唯一 mutate 持有者）→ 短路返回其 n。该期望在无 tie-break 的实现（稳定排序取先插入的 n 大者）下得 null，故用例能区分两种实现；可加反向断言验证区分度 |
| A8 | README/CHANGELOG 防漂移 | 自动化验证（static） | (i)(ii) 扩展 `test/docs-timing.test.ts`（照其既有惯例：钉死具体 stale 字符串 + 必含正则），随 `./test/run-all.sh` 跑；(iii) 单独发布门命令 | (i) README 不再含 `2x dominance margin`（现状句，README.md:143）；(ii) evidence 段含 `/unique mutate|唯一 mutate/` 短路说明；(iii) **发布门（路径 1 步 2 之后，不随 run-all.sh 首跑）**：`grep -q '^## \[0.4.1\]' CHANGELOG.md` 且该节内含 `### Fixed` 与本 issue 条目。R3-D1：CHANGELOG 按仓内惯例（changelog commit 在 merge 之后）落地；若折进 fix PR，则 (iii) 可并入 run-all.sh |
| U1 | 真实会话标题修正 | 用户实测（部署前置见下节，含 A/B 对照） | 按下方确定性构造 13 vs 7 形态：先在未更新副本上确认基线行为，再按部署前置换新副本复测 | 更新前：标题退为流程标签（证伪面）；更新后：标题反映 issue N 主题；无 evidence 的普通会话标题不变 |

### 部署与验收前置（U1 的可执行路径，R1-G1）

本机 pi **不是**从 git checkout 加载本扩展，U1 必须先把修复送到实际加载副本：

- 加载链：`~/.pi/agent/settings.json:68` 的 packages 列表项 `npm:@zhuxixi/pi-auto-rename` → 实体副本 `~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/`（当前 v0.4.0，与 `main@cf23ad7` 字节一致）。
- 因此 worktree 与主 checkout 的改动都不会被任何 pi 会话加载——直接实测必然跑在旧代码上。

**路径 1（正式）**
1. 合入 main（步 9 的 PR merge）
2. CHANGELOG 增 Fixed 条目 + patch 版本 bump（0.4.0 → 0.4.1）
3. 发布 npm（仓内 release 惯例：changelog commit → bump commit → tag）
4. `pi update --extensions`，然后 `/reload`（或新会话）
5. 部署自证：`grep -c "unique mutate" ~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/lib/auto-rename-core.ts` ≥ 1（或与 worktree 产物 sha256 比对），确认新代码已加载

**路径 2（快速实测，临时）**
1. 把 worktree 的 `index.ts` 与 `lib/auto-rename-core.ts` 复制到 `~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/` 对应位置
2. `/reload`
3. 实测后走路径 1 发布，或还原副本（还原命令：从 npm registry 重新 `pi install npm:@zhuxixi/pi-auto-rename@0.4.0`）

**U1 复现 13 vs 7 形态的确定性构造（R2-G2）**

先决条件：`~/.claude/github-issue-driven/<owner>/<repo>/` 下存在 `issue-N/` 与 `issue-M/`，**两者都须含至少一个子目录**（如 `research/`）——`RE_DRIVEN_PATH` 要求 `issue-N/<subdir>` 形态，裸目录行不命中；若 M 无子目录，M 只得 v1+b3=4 → 13 ≥ 2×4，A/B 对照的证伪面失效（R3-D2）。

目标 issue N —— 目标 13 分（m6+b3+p3+v1）：
1. `gh issue comment N --body "start"` → mutate
2. `gh issue view N` → view
3. `find ~/.claude/github-issue-driven/<owner>/<repo> -maxdepth 2 -type d` → path（输出含 `.../issue-N/research` 形态；**纯 `ls` 父目录不产生该信号**，它只打印裸目录名）
4. 任一含 `issue-N-<slug>` 字串的命令（`git worktree list`，或 `git worktree add .pi/worktrees/issue-N-<slug> -b issue-N-<slug>`）→ branch

兄弟 issue M —— 目标 7 分（b3+p3+v1）：
1. `gh issue view M` → view
2. 同一条 `find` 命令覆盖 M → path（输出须含 `.../issue-M/<subdir>` 行）
3. `git worktree list`（若 M 有 worktree）或任一含 `issue-M-<slug>` 的命令 → branch

**A/B 对照（U1 的证伪结构）**
1. **更新前**：在未更新的 npm 副本（0.4.0）上按上面构造，等下一次周期 rename（`repeatEveryMin` 默认 3 分钟）或 `/autorename` → 期望标题退为流程标签（13 < 14 → null → 无 evidence 块）
2. **更新后**：按部署前置更新副本（路径 1 或 2）后重复同一构造 → 期望标题反映 issue N 的主题

**确认写入**：`grep -o '"evidenceKey":"[^"]*"' <session file> | tail -1` 应输出 `"evidenceKey":"issue:N"`。注意 `/autorename-status` 不显示该字段（`formatStatusLine` 只输出 title/core/locked/paused/lastRun/timing），本 issue 非目标 5 也禁止为其加字段。

### 可测性拆分设计（A 类功能点的硬约束）

- **判定与归约分离**：`scanIssueSignals` 只做 entry→信号归约（本次零改动）；新增的 `pickDominant(ranked)` 是纯判定函数，不吃原始 transcript。`extractWorkEvidence` 降级为"归约 + 调用判定 + 组装返回值"的接线层。
- **边界用构造数据测**：A1–A3 直接构造 ranked/branch，不依赖外部 session 文件；测试不许读取 `~/.pi/agent/agent-board`。
- **零副作用**：`pickDominant` 不得读写模块级可变状态；`WorkEvidence` 组装（title/slug/key 选取）仍留在 `extractWorkEvidence`，判定函数只返回 issue number。
- **不改既有测试断言**：`ambiguous claims -> null` 等既有用例保持原样通过——它们是本次行为边界的守卫。

## 风险与回滚

**风险**：唯一 mutate 仍可能是"顺路操作"。研究抽查的 8 个恢复案例中 7 个正确、1 个可疑（`view_0214d4da75` 对 #460 仅有一次跨 issue 评论）。收益/风险 = 7:1。

**保证边界（R1-D2）**：质量门拒绝或模型失败时退回原标题（不劣化）——这是机制保证；但"过门但主题略偏"的标题无法被现有闸门识别，属本 issue 接受的残余风险（概率按 7:1 抽查估计），不得表述为"不会更差"的绝对保证。

**回滚**：单 commit revert（一个函数内的判据分支 + 一个新增导出）；`WorkEvidence` 契约、state、prompt 均未变，无迁移。
