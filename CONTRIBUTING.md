# Contributing

Thanks for looking. This file covers what you need to get a change merged.

## Ground rules

- No runtime dependencies. The tool runs with Node alone.
- No network calls except `pricetag prices --update`, which the user runs by hand.
- The hooks must never fail a commit. Every hook path is wrapped and exits 0.
- Numbers must be traceable. Tokens come from the agent's own log. Dollars are labelled as estimates.
- Every behaviour change comes with a test.

## Setup

```bash
git clone https://github.com/hsiddhu2/pricetag
cd pricetag
npm test
```

Tests use Node's built-in runner. Integration tests build throwaway git repos and fake transcripts under the OS temp dir. They never touch your real `~/.claude`, `~/.codex` or `~/.copilot`.

## Adding an adapter

An adapter is one file in `lib/adapters/` that exports:

```js
module.exports = {
  name: 'tool-name',                 // shown in reports and trailers
  extensions: ['.jsonl'],            // used by `pricetag doctor` to count files
  roots(),                           // -> [dir, ...] where this tool keeps usage logs
  load({ since, dirs }),             // -> [event, ...]
};
```

An event is:

```js
{ agent: 'tool-name', ts: 1729000000000, model: 'model-id', cwd: '/abs/path', branch: null,
  sessionId: 's', usage: { input, output, cacheWrite, cacheRead } }
```

Rules for `usage`:

- `input` is the uncached input. If the tool reports cached tokens as part of input, subtract them.
- `cacheRead` and `cacheWrite` are separate. If the tool only reports one cached figure, put it in `cacheRead`.
- Skip records with zero tokens and records with no model.
- Deduplicate. Streamed or re-emitted records are common.
- Respect `since`. Skip files whose mtime is older than `since` minus a few minutes.

Add a fixture under `test/fixtures/<tool>/` copied from a real log with any prompt text replaced, and a test that loads it and checks the totals by hand. Link the source you used for the format in the file header comment.

## Pull requests

- One change per PR.
- Describe what and why. The template asks for both.
- CI runs on Linux, macOS and Windows with Node 18, 20, 22 and 24. All of them have to pass.

## Releases

Maintainers bump `version` in `package.json`, update `CHANGELOG.md`, and push a `vX.Y.Z` tag. The release workflow runs the tests, publishes to npm with provenance, and creates the GitHub release.
