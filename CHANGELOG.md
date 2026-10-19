# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the project uses semantic versioning.

## [Unreleased]

## [0.3.0] - 2026-10-19

First public release. Earlier numbers were internal iterations.

- Reads usage from Claude Code, Codex CLI, Copilot CLI, OpenCode and Cline, Roo Code, Kilo Code and the Cline CLI. Each adapter records the cache accounting rule it was verified against.
- Records agent usage per commit from local transcripts.
- Default recording to local git notes. Opt-in commit trailers with `pricetag config mode trailer`.
- `pricetag report` groups usage by repo, client, branch, agent, model or day, with CSV and JSON output.
- `pricetag pr` prints a Markdown summary for the current branch. GitHub Action posts it as a PR comment.
- `pricetag doctor` shows which agents were detected and where.
- Bundled price table dated in the output. `pricetag prices --update` refreshes it.
- Plan setting controls how dollars are labelled: estimates for API billing, API-equivalent for flat plans.
