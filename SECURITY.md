# Security

## What pricetag reads and writes

pricetag reads files on your machine that your coding agent already writes: session transcripts and usage logs. From those files it uses token counts, model names, timestamps, session ids and working directory paths. Parsing a log line means the prompt text in it passes through memory and is discarded. Nothing from it is stored, written or transmitted.

It writes to:

- `.git/pricetag-last` in the current repo (a timestamp)
- `refs/notes/pricetag` in the current repo (one line per commit, local only, not pushed by default)
- the commit message, only when `mode` is set to `trailer`
- `pricetag.*` and `notes.rewrite*` keys in the repo's `.git/config` (or `~/.gitconfig` with `--global`)
- `~/.config/pricetag/clients.json` (`%APPDATA%\pricetag` on Windows): client names you set
- `~/.pricetag/prices.json`, only after `pricetag prices --update`

It makes no network calls, except `pricetag prices --update`, which fetches one public JSON file from GitHub when you run it.

## Reporting a vulnerability

Email the maintainer at the address on the GitHub profile, or open a private security advisory on this repository. Please do not open a public issue for a security problem. You will get a reply within 72 hours.

## Supported versions

The latest minor release receives fixes.
