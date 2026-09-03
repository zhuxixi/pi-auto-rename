# pi-auto-rename

[![npm version](https://img.shields.io/npm/v/@zhuxixi/pi-auto-rename)](https://www.npmjs.com/package/@zhuxixi/pi-auto-rename)
[![license](https://img.shields.io/github/license/zhuxixi/pi-auto-rename)](./LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-181717?logo=github)](https://pi.dev/packages)

AI session naming for [pi](https://github.com/earendil-works/pi-coding-agent):
derives a short **core-goal title** from the session's original intent and
applies it via `pi.setSessionName()`.

```text
# before: session-2026-08-21-2218
# after:  auto-rename 扩展拆分
```

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Features

- **Core-goal titles, not activity labels**: the title names what the
  session is *accomplishing*, derived only from the ORIGINAL INTENT
  (earliest substantive user prompts). Later pastes, spec dumps, and
  quoted material can never crowd the core out.
- **Anchor + delayed lock**: once a core is derived from substantive
  intent it is locked; periodic refreshes reuse it verbatim with no
  model call. Junk cores self-heal on the next refresh.
- **Quality gates**: greeting/ack openers are skipped, procedural
  labels ("Issue list triage") and non-goal cores ("方案确认") are
  rejected and backed off to the next cycle. A forced `/autorename`
  degrades instead of rejecting: the meta filter is skipped and
  non-goal cores are accepted with a warning, so a quality-gate hit
  never blocks a title.
- **Manual-rename protection**: an out-of-band name change pauses the
  session so the extension never fights the user.
- **Secret redaction**: 6 patterns (private keys, AWS keys, API keys,
  bearer tokens, `KEY=value` assignments) before anything is sent to
  the model.
- **LLM via pi's model registry** (`deepseek/deepseek-v4-flash` by
  default) — API keys stay in pi's keychain, never read from dotfiles.
- **agent-board sync**: mirrors the name into the agent-board view's
  `meta.json` (absorbed from agent-board-name-sync).
- **Zero dependencies beyond pi itself**: pure title logic lives in
  `lib/` and is unit-tested without a test framework.

## Requirements

- **pi ≥ 0.84** recommended. The extension uses `pi.setSessionName()`,
  `pi.appendEntry()`, and the `agent_settled` event; on older builds
  these degrade to best-effort no-ops rather than crashing.

## Installation

### From npm (recommended)

```bash
pi install npm:@zhuxixi/pi-auto-rename
```

Then run `/reload` in pi (no restart needed).

To update later:

```bash
pi update --extensions
```

To remove:

```bash
pi remove npm:@zhuxixi/pi-auto-rename
```

### From source

Clone the repository into a subdirectory of pi's global extensions dir:

```bash
git clone https://github.com/zhuxixi/pi-auto-rename.git ~/.pi/agent/extensions/pi-auto-rename
```

## Configuration

The config file is created automatically on first load at
`~/.pi/agent/auto-rename.json`:

| Key             | Default                     | Meaning                                        |
| --------------- | --------------------------- | ---------------------------------------------- |
| `enabled`       | `true`                      | Master switch                                  |
| `model`         | `"deepseek/deepseek-v4-flash"` | `provider/modelId` in pi's model registry   |
| `firstAfterMin` | `5`                         | First rename after this many minutes of session life |
| `repeatEveryMin`| `3`                         | Re-rename cadence after the first rename       |
| `maxCoreWidth`  | `24`                        | Core-goal cap in display columns (CJK counts 2) |
| `debug`         | `false`                     | Verbose logging to stderr                      |
| `lang`          | `"auto"`                    | Forced title language: `"zh"` / `"en"` / `"auto"` (default — follows the session's original intent). Invalid values fall back to `"auto"`. Applies to newly generated and `/autorename`-forced titles only |

Edit the file and run `/reload` to apply.

## Commands

| Command               | Effect                                              |
| --------------------- | --------------------------------------------------- |
| `/autorename`         | Force a rename now (bypasses cooldown, pause, and core lock; re-derives with latest context) |
| `/autorename-pause`   | Pause auto-rename for this session                  |
| `/autorename-resume`  | Resume auto-rename for this session                 |
| `/autorename-status`  | Show current state (title, core, locked, paused)    |

## How It Works

1. On `agent_settled`, the extension checks whether the session is due
   (first rename after `firstAfterMin`, then every `repeatEveryMin`).
2. It scans the transcript for the first substantive user prompts
   (greetings/acks skipped) — the session's ORIGINAL INTENT.
3. Secrets are redacted, then the excerpt is sent to the configured
   model with a strict title-generation prompt; the configured `lang`
   forces the title language (`"auto"` follows the original intent).
4. The output passes quality gates (not a sentence, not a response,
   not a procedural label), is capped to `maxCoreWidth` display
   columns, and applied via `pi.setSessionName()`. On `/autorename`
   the ambiguous meta filter is skipped and non-goal cores fall back
   to a warning instead of an empty rejection.
5. State (`lastRunEpoch`, `lastSetTitle`, `lastCore`, `coreLocked`,
   `paused`) lives in the session file as `auto-rename-state` custom
   entries, so it survives reloads.

## Development

```bash
./test/run-all.sh   # bundles test/*.test.ts with esbuild and runs them
```

After editing, run `/reload` inside pi to hot-reload the extension.

## Troubleshooting

- **Titles stop updating**: check `/autorename-status` — the session
  may be paused (manual rename detected) or the core may be locked
  (that's by design: periodic refreshes reuse the locked core without
  a model call). `/autorename` forces a re-derive — it bypasses the
  lock and includes the latest user messages, so a drifted title can
  be regenerated.
- **`/autorename` reports "quality gate flagged core …"**: the model
  produced a non-goal label (e.g. "方案确认"), but force mode still
  set a title from it. Use `/name` to set your own, or run
  `/autorename` again; the next background refresh re-derives the
  core anyway.
- **No rename happens at all**: check `enabled` in
  `~/.pi/agent/auto-rename.json`, and that the configured model is
  available in pi's model registry (`pi models`).
- **Debug logging**: set `debug: true` in the config and reload;
  messages are printed to stderr with the `[auto-rename]` prefix.

## License

[MIT](./LICENSE)
