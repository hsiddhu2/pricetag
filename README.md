# pricetag

**See what your AI coding agents cost, per repo, per branch, per client.**
Reads the logs Claude Code, Codex CLI, Copilot CLI, OpenCode and Cline already write. Local, no account, one command.

```
$ pricetag report --by client --since 30d

  client        tokens  cached     time  sessions  agents              cost
  -----------  -------  ------  -------  --------  -----------  -----------------
  Acme          212.4M     91%  18h 12m        41  claude-code  ~$184.20 API-equiv
  Northwind      96.1M     88%   7h 40m        19  codex+cline   ~$71.05 API-equiv
  (no client)    14.3M     93%   1h 05m         6  claude-code    ~$9.80 API-equiv

  Total  322.8M tokens · 26h 57m · 66 sessions · ~$265.05 API-equiv
  Dollars are what this usage would cost at API list prices. On a flat plan it is not a bill.
```

[![CI](https://github.com/hsiddhu2/pricetag/actions/workflows/ci.yml/badge.svg)](https://github.com/hsiddhu2/pricetag/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pricetag)](https://www.npmjs.com/package/pricetag)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why

Every AI coding agent keeps a precise local record of the tokens it used. None of them tell you which repo, branch or client those tokens went to. Agencies cannot bill it, teams cannot forecast it, and the monthly invoice is one number with nothing behind it.

pricetag reads those local records, joins them to your git repos by working directory and time, and gives you the breakdown. It can also record the usage behind each commit, privately, so a pull request can carry its own token count.

## Install

```bash
npm install -g pricetag
pricetag doctor        # shows which agents it found on this machine
pricetag report        # usage by repo, last 30 days
```

Node 18 or newer. No dependencies. `npx pricetag doctor` works too if you want to look before installing.

## Supported agents

| Agent | Reads | Granularity | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | per message | cache reads and writes recorded separately |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | per API response | compressed `.zst` rollouts need Node 22.15+ |
| Copilot CLI | `~/.copilot/session-state/*/events.jsonl` | per session | usage is written when a session ends. AI credits are shown with `plan copilot` |
| OpenCode | `~/.local/share/opencode/opencode.db` | per message | SQLite. Needs Node 22.5+ or the `sqlite3` CLI. Older JSON storage is read too |
| Cline, Roo Code, Kilo Code | VS Code `globalStorage/<extension>/tasks/*` | per request | also the Cline CLI under `~/.cline/data/sessions` |

Not supported, on purpose: **Cursor**, **Windsurf** and **Kiro** keep billable usage on their servers. The counters in their local databases do not match what you are billed, so pricetag does not read them rather than show a wrong number. If that changes, an adapter is welcome.

## Commands

```
pricetag                     agent work not yet committed, and recent commits
pricetag report              usage across all repos
                               --by repo | client | branch | agent | model | day | session
                               --since 30d | 2w | 3m | 1y | 2026-10-01   --until   --repo   --agent codex
                               --csv    --json
pricetag init                install hooks so each commit records its usage (local git notes)
pricetag log                 commits with their recorded usage
pricetag pr                  Markdown summary for the current branch
pricetag config              mode · plan · client · scope
pricetag doctor              detected agents, log paths, event counts
pricetag prices              price table, and --update to refresh it
pricetag badge [--write]     README badge with the repo's recorded token total
pricetag uninstall
```

Every command accepts `--json`. Exit codes: 0 ok, 1 error, 2 usage.

## Per-commit recording

`pricetag init` installs two git hooks. From then on, every commit in that repo records the agent work done since the previous commit:

```
Agent-Usage: 2.1M tok (1.8M cached) | 38m | claude-code/sonnet-5-5 | ~$1.42 API-equiv
```

By default that line goes to **git notes** (`refs/notes/pricetag`), which stay on your machine and never travel with a push unless you push them. Your commit messages do not change. If you want the line in the commit message itself:

```bash
pricetag config mode trailer
```

`pricetag log` and `pricetag pr` read both. The hooks cannot fail a commit: if Node is missing or anything goes wrong, the commit goes through and nothing is recorded. `PRICETAG=0 git commit` skips one commit (PowerShell: `$env:PRICETAG=0`).

A pull request summary is one command away, and the [GitHub Action](#github-action) can post it on every PR:

> ### Agent usage
> **8.8M tokens** · 2h 36m of agent time · 3/4 commits recorded · claude-code, codex · API-equivalent $16.88
>
> <details><summary>Per commit</summary>…</details>

## Clients

Tag a repo once and it shows up under that name in every report:

```bash
cd ~/work/acme-api
pricetag config client Acme
pricetag report --by client --since 2026-10-01 --csv > october.csv
```

## Plans and what the dollar means

Tokens are the fact. Dollars are context, and the label says which kind:

| `pricetag config plan` | Label | When to use it |
|---|---|---|
| `auto` (default) or `subscription` | `~$1.42 API-equiv` | Claude Pro/Max, ChatGPT Plus/Pro, Cursor-style flat plans. Shows what the work would cost on the API. Your marginal cost was zero. |
| `api` | `$1.42 est.` | API keys, Bedrock, Vertex, BYOK. Close to your bill, at list prices. |
| `copilot` | `5.95 credits` | GitHub Copilot. Its own unit, 1 credit = $0.01. |

Prices come from a bundled table with a date on it (`pricetag prices`). `pricetag prices --update` refreshes it from a public price list. A model with no known price is counted in tokens and shown as `?`, never as $0.

## How attribution works

Each usage record carries a timestamp and the working directory the agent ran in. Work belongs to a repo when that directory is inside it, and to a commit when it happened after the previous commit. A watermark in `.git/pricetag-last` makes sure nothing is counted twice.

Known limits:

- A rebase or cherry-pick resets commit times, so uncommitted agent work from before it is not attributed.
- In trailer mode, `git commit --amend -m "new text"` replaces the message and with it the trailer. Plain `--amend` keeps it. In notes mode the note follows the amended commit, and a rebase carries notes along.
- GitHub's "Squash and merge" drops trailers from the squashed commit. The PR comment is the record in that case.
- In trailer mode the agent name becomes part of the commit message, so a commit-message linter that rejects certain words will see it, including on a later `--amend` or reword. Notes mode keeps the message untouched.
- Copilot CLI writes usage at session end, so a session that spans a commit is attributed to the next one. Sessions that crash before writing it are not counted.
- If you launch the agent from a parent folder, set `pricetag config scope /that/folder`.

## GitHub Action

```yaml
# .github/workflows/pricetag.yml
name: pricetag
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  usage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: hsiddhu2/pricetag@v0
```

The Action reads the usage recorded in the commits. It never sees your transcripts. In notes mode, push the notes so the Action can read them: `git push origin refs/notes/pricetag`. In trailer mode nothing extra is needed. `pricetag init --action` writes this file for you.

## Privacy

pricetag uses token counts, model names, timestamps, session ids and directory paths from your agents' logs. It parses the log files to get those and discards everything else: no prompt text or code is stored, written anywhere, or sent anywhere. The one network call is `pricetag prices --update`, which you run yourself. The README badge is an image URL served by shields.io, so a viewer's browser fetches it. Details in [SECURITY.md](SECURITY.md).

## Contributing

Adapters are one file each with a fixture and a test. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
