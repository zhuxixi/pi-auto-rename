# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
