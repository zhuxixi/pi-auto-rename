# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-11-23

### Fixed
- issue 证据抽取把「读到的文本」当作工作证据：toolCall 只认实际执行字段（bash 命令剥 heredoc 后按命令段识别段首 `gh`；write/edit 只扫目标路径；subagent 只扫 cwd），搜索模式/引号文本/文档正文不再产生伪 claim；toolResult 的 branch/path 降为观察信号（各 1 分，同类与执行取最高分），目录枚举与历史回显不再抬高 runner-up（issue #13）

## [0.4.1] - 2026-10-16

### Fixed
- issue 证据抽取把「唯一 mutate 且为 top」误判为歧义（典型形态 13 vs 7，差 1 分）：会话对唯一一个 issue 执行过写操作时不再参与 2x 比例比较，标题不再退回流程标签（issue #11）

## [0.4.0] - 2026-10-13

### Fixed
- 短会话/闲置会话永远拿不到标题：首轮重命名不再等 `firstAfterMin`，第一个有内容的 `agent_settled` 即命名；被杀/提前结束的会话由 `session_shutdown` 兜底、重开由 `session_start` 自愈补名（issue #9）
- 手工改名保护覆盖「从未被自动命名」的窗口：暂停判据改为「≠ 我设过的标题 且 ≠ 会话初始名」，board 种子名重放不再误冻结

### Changed
- `firstAfterMin` 语义从「首次命名门槛」改为「核心锁定门槛」：标题即时出现，会话满门槛前保持可修正（锁定时机与旧版一致：满门槛后的首次刷新）
- 纯问候会话使用本地机械标题（zh「问候交流」/ 其他 `Greeting exchange`）：零模型调用、跳过质量门、不占用 `repeatEveryMin` 冷却，实质内容到达后下一轮 settle 立即升级
- `/autorename-status` 增印 `timing=first@settle,lock@<n>m`，兼作新代码已加载的部署自证标记
- README 时机语义与配置表按新行为改写，并新增静态一致性测试防漂移

### Added
- `session_shutdown` 退出兜底：非 reload、从未命名时补跑一次，5s `AbortSignal` 预算，不阻断退出
- `session_start` 重开自愈：重开从未命名的会话立即命名（存量 view 打开即补名）
- 零依赖集成测试基建：esbuild `--alias:` 注入模型 stub + 假 pi/ctx，真实扩展接线可无网络测试

## [0.3.0] - 2026-10-09

### Added
- issue-driven 会话标题证据抽取：从工具调用/返回识别「在做的 issue」（`gh issue view` 的标题/编号成对解析、认领/分支/研究路径信号，每 issue 二元计分 + 2x dominance），作为高权重块进入标题推导（issue #7）
- `evidenceKey` 一次性自愈：证据出现后无视 coreLocked 重推一次，存量流程标签标题（`issue认领处理` 类）自动愈合
- slug 机械兜底：模型失败且只有分支 slug 时展开为词组标题

### Changed
- system prompt：issue 证据在场时 core 必须浓缩反映 issue 主题（不再要求同 issue 会话标题互异）；金测随 spec 显式重写
- 质量门中文扩词：认领/处理/调研/关闭/筛选/评估/跟进/闭环

## [0.2.1] - 2026-09-03

### Fixed

- `/autorename` no longer bails with an empty rejection when the
  quality gate fires: the meta filter is skipped on force and non-goal
  cores are accepted with a warning that names the rule and the
  flagged core; background renames stay strict (issue #5).
- Gate messages now fold C1 control characters (incl. NEL U+0085)
  into spaces, so a model core can never break the single-line
  guarantee (PR #6 CR advisory).

## [0.2.0] - 2026-08-26

### Added

- `lang` config (`"auto"` / `"zh"` / `"en"`): forces the title language
  for newly generated and `/autorename`-forced titles; invalid values
  fall back to `"auto"` (issue #3).

### Fixed

- `/autorename` now truly regenerates the title: it bypasses the core
  lock and re-derives with the latest user messages (recent context)
  plus the previous title as prompt context, so a drifted or
  inaccurate title can be corrected on demand (issue #1).

## [0.1.0] - 2026-08-21

First public release, published to npm as `@zhuxixi/pi-auto-rename`.

### Added

- Core-goal session naming: derives a short noun-phrase title from the
  session's ORIGINAL INTENT (earliest substantive user prompts), so
  later pastes and spec dumps can never crowd the core out.
- Anchor + delayed lock: once a core is established from substantive
  intent it is locked and refreshes reuse it verbatim (no model call);
  junk cores self-heal on the next refresh.
- Quality gates: greeting/ack openers are skipped, procedural labels
  ("Issue list triage") and non-goal cores ("方案确认") are rejected
  and backed off.
- Manual-rename protection: an out-of-band name change pauses the
  session so the extension never fights the user.
- Secret redaction (6 patterns) before anything is sent to the model.
- LLM via pi's model registry (`deepseek/deepseek-v4-flash` by
  default) — API keys stay in pi's keychain.
- Commands: `/autorename` (force), `/autorename-pause`,
  `/autorename-resume`, `/autorename-status`.
- agent-board view name sync (absorbed from agent-board-name-sync).
- Dependency-free unit tests run through esbuild (`./test/run-all.sh`).
- `package.json` pi manifest so the extension installs via
  `pi install npm:@zhuxixi/pi-auto-rename`.
