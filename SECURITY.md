# Security

## What pricetag reads and writes

pricetag reads files on your machine that your coding agent already writes: session transcripts and usage logs. From those files it uses token counts, model names, timestamps, session ids and working directory paths. It does not read, store or transmit prompt text or code.

It writes to:

- `.git/pricetag-last` in the current repo (a timestamp)
- `refs/notes/pricetag` in the current repo (one line per commit, local only, not pushed by default)
- the commit message, only when `mode` is set to `trailer`
- `~/.config/pricetag/` (client names you set, and an optional price table)

It makes no network calls, except `pricetag prices --update`, which fetches one public JSON file from GitHub when you run it.

## Reporting a vulnerability

Email the maintainer at the address on the GitHub profile, or open a private security advisory on this repository. Please do not open a public issue for a security problem. You will get a reply within 72 hours.

## Supported versions

The latest minor release receives fixes.
