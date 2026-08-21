# Security Policy

## Reporting a Vulnerability

If you find a security issue in pi-auto-rename, please report it
privately instead of opening a public issue:

- **Email:** <zhuzhenxi_555@hotmail.com> — put `pi-auto-rename security`
  in the subject line.

Please include a description of the issue, affected versions, and (if
possible) steps to reproduce. I will acknowledge your report within 7
days and aim to publish a fix within 30 days of confirmation.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Scope

The extension derives session titles by sending redacted excerpts of
the session's earliest user messages to an LLM through pi's model
registry (API keys are managed by pi's keychain and never read from
dotfiles). Security concerns would primarily be: secret-redaction
bypasses (patterns in `lib/auto-rename-core.ts`), prompt-injection
resistance of the title prompt, or state-file parsing edge cases in
`~/.pi/agent/auto-rename.json`. When reporting, please note which of
these areas is involved.
