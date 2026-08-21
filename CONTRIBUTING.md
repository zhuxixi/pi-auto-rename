# Contributing

Thanks for your interest in contributing to pi-auto-rename! This project
follows pi's issue-driven workflow: open an issue first, discuss the
approach, then implement on a branch.

## Development Setup

Clone the repository into pi's global extensions directory:

```bash
git clone https://github.com/zhuxixi/pi-auto-rename.git ~/.pi/agent/extensions/pi-auto-rename
```

The extension is loaded directly from `index.ts` (pi runs TypeScript
natively), so there is no build step and no dependencies to install.

## Running Tests

Tests are dependency-free: `test/run-all.sh` bundles each
`test/*.test.ts` with esbuild and runs it with node. Run the whole suite
with:

```bash
./test/run-all.sh
```

## Verifying Changes

After editing the extension, run `/reload` inside pi to hot-reload it
(no restart needed). Config changes in `~/.pi/agent/auto-rename.json`
take effect on the next reload; `/autorename` forces an immediate
rename for the current session.

## Commit Conventions

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new naming capability or command
- `fix:` bug fixes
- `docs:` README, CHANGELOG, and other documentation
- `chore:` housekeeping (metadata, ignores, release prep)

Code comments and commit messages are written in English.
