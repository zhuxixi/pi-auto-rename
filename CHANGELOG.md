# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
