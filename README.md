# dsh-stream-rules — time-traveling stream rules for DeepSeek Harness

One standalone package, installable as a plugin for the DeepSeek Harness and
the CLI/web profiles:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-stream-rules` | behavioral guard plugin: project rules stay dormant until a regex matches the live token stream, then the turn is aborted, the rule injected as a system reminder, and the request retried from the same point | yes |

This is a parity port of oh-my-pi's Time-Traveling Stream Rules
(`TtsrManager` + stream guards) onto the harness behavioral-guard contract
(`session/event` stream observation, `agent.cancel({ kind: 'hook' })` +
`agent.followup(...)` for abort-and-retry, `tools/post-execute`
`additionalContexts` for non-interrupting tool rules). It works on stock
DeepSeek Harness releases with **zero upstream changes**.

**Why this exists.** The cost of a rule is paid only at the moment it is
violated — the rule never enters the request until the stream matches it, so
enforcement has zero per-turn context tax and survives compaction (there is
nothing to remember). Rules are plain Markdown files with a YAML frontmatter
block, kept per project under `<cwd>/.dsh/rules/**/*.md`, re-scanned on every
turn start.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

The package is published on the npm registry under the `hy-sde-org`
organization (`@hy-sde-org/dsh-stream-rules`, version `0.1.2-rc.1`). Install
it straight from npm:

```bash
dsh plugin --profile web add @hy-sde-org/dsh-stream-rules
```

Installing the bundle alone never breaks boot and claims no name on the host
plane — the guard only does work when a mounted agent carries its row. Grant
per-agent rows through the provided [agent preset](#giving-agents-stream-rules).

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-stream-rules.git
cd dsh-stream-rules
pnpm install
pnpm -r build
dsh plugin --profile web link ../dsh-stream-rules/packages/stream-rules
```

### Verify

```bash
pnpm -r check && pnpm -r test && pnpm -r build
bash scripts/release-public.sh --check   # clean tree + checks + tests + pack
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-stream-rules
```

## Giving agents stream rules

Mount one row in an agent preset you already use (or copy
[`examples/agent-preset/`](packages/stream-rules/examples/agent-preset/) to
`~/.dsh/.agent-presets/<id>/` and select it). The preset adds the
`stream-rules` row beside persona + agent-instructions:

```yaml
- id: stream-rules
  name: '@hy-sde-org/dsh-stream-rules'
  config:
    contextMode: keep
    interruptMode: always
    repeatMode: once
```

Then drop rule files into each project: `<cwd>/.dsh/rules/no-console.md`

```markdown
---
description: Never leave console logging behind
scope: [text, thinking, tool:edit, tool:write]
condition:
  - console\.(log|debug)\(
interruptMode: always
---
Never leave `console.log` / `console.debug` output in committed code; use the
project's logging facility or remove the call.
```

Rules reload on the next turn start (mtime-gated), so editing a rule takes
effect without a restart.

## Security

Rules are local files you author and install; the guard runs them as regular
expressions against the model's own output inside your own agent process. See
[`SECURITY.md`](SECURITY.md) for the security posture and reporting.

## References

- Notebook: the port plan and omp upstream pointers.
- Internal (for maintainers): the fork prototype at
  `packages/guard/stream-rules/` in
  `github.com/deepseek-ai/deepseek-harness` is the reference implementation
  this standalone package mirrors.
