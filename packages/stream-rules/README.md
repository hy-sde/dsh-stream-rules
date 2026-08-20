# @hy-sde-org/dsh-stream-rules — time-traveling stream rules

A standalone behavioral guard plugin for DeepSeek Harness: project rules stay
dormant until a regex matches the **live token stream**, then the guard aborts
the request, injects the rule as a system reminder, and retries from the same
point. This is a port of oh-my-pi's Time-Traveling Stream Rules (`TtsrManager`
+ `TtsrCoordinator`) onto the harness's behavioral-guard contract. It runs on
stock DeepSeek Harness releases — **zero upstream changes**.

Because a rule participates in the prompt **only** when it is actually
violated, enforcement costs zero per-turn context and survives compaction —
the rule never entered the request in the first place.

## Install & mount

```bash
# from npm
dsh plugin --profile web add @hy-sde-org/dsh-stream-rules
# or from a checkout:  dsh plugin --profile web link ../dsh-stream-rules/packages/stream-rules
```

The guard becomes active only when an agent preset carries its row:

```yaml
- id: stream-rules
  name: '@hy-sde-org/dsh-stream-rules'
  config:
    contextMode: keep
    interruptMode: always
    repeatMode: once
```

A ready-to-copy preset lives in [`examples/agent-preset/`](examples/agent-preset/).
Drop rule files into per-project `<cwd>/.dsh/rules/` (or use `rulesDir`).

## How it works

```
token stream (assistant prose / reasoning / tool-call args)
      │
      ▼  session/event `assistant/chunk`
┌─────────────────────┐   condition matches   ┌────────────────────────────┐
│ TtsrManager buffers  ├──────────────────────►│ agent.cancel({kind:'hook'}) │
└─────────────────────┘                        └─────────────┬──────────────┘
                                                              ▼
                        turn ends `aborted` (partial output kept or discarded)
                                                              │
                        ┌─────────────────────────────────────┘
                        ▼
      agent.followup(rule as plugin-sourced `user/message` notice)
                        │
                        ▼
       the turn is regenerated with the rule in context (retry from the same
       point: the original prompt is untouched, nothing else is repeated)
```

- **Observing** the stream needs no LLM-stream surgery: the guard listens on
  `session/event` for `assistant/chunk` events (`text-delta`,
  `reasoning-delta`, `tool-call-delta`) and accumulates per-source buffers.
- **Aborting** uses the loop's own cancellation path
  (`agent.cancel({ kind: 'hook', reason })`, inbox kept), so the partial turn
  lands as an ordinary `interrupted` assistant message — exactly like a user
  stop — and cleanup, replay, and the client UI all behave as usual.
- **Retrying** uses `agent.followup(...)`: the rule becomes a plugin-sourced
  `user/message` `notice` (shown as a collapsible card whose summary names
  the enforced rule), and the driver regenerates the turn from the same
  context.
- **Non-interrupting** rules (see `interruptMode`) never abort: a tool-call
  match is folded into the matched tool's result through
  `tools/post-execute` `additionalContexts` (the same channel the harness's
  own repeat-tool-reminder guard uses), and a prose match becomes an advisory
  notice after the assistant message.

## Rule format

Rule files are Markdown with a YAML frontmatter block. By default the guard
reads every `**/*.md` under `<cwd>/.dsh/rules` (override with `rulesDir`; a
missing directory simply means no file rules). File rules are re-scanned on
every turn start with an mtime-gated cache, so editing a rule takes effect on
the next turn.

```markdown
---
description: Never leave debug logging behind
globs: ["**/*.ts"]
scope: ["text", "tool:edit(*.ts)", "tool:write(*.ts)"]
condition:
  - console\.log
interruptMode: always
---
Never commit or leave behind `console.log` / `console.debug` calls...
```

| Frontmatter key | Meaning |
|---|---|
| `name` | Rule name (defaults to the file stem) |
| `description` | Human-readable summary |
| `globs` | File globs the rule applies to (matched against candidate file paths in tool-call arguments) |
| `condition` | Regex pattern(s) that trigger the rule — `condition: "(?i)todo"` inline flags are translated to native `RegExp` flags |
| `scope` | Streams the rule watches (see below) |
| `interruptMode` | `always` · `prose-only` · `tool-only` · `never` (falls back to `config.interruptMode`) |
| `alwaysApply` | Accepted for compatibility; static per-turn injection is not implemented yet |
| `astCondition` | Parsed for compatibility; AST-pattern matching is not yet supported — a rule with only AST conditions is skipped with a warning |

### Scope tokens

- `text` — assistant prose
- `thinking` — reasoning text
- `tool` | `toolcall` — every tool-call argument stream
- `tool:<name>` — one tool's argument stream (e.g. `tool:edit`)
- `tool:<name>(<glob>)` — one tool's arguments **and** a path glob over the
  file paths in those arguments (e.g. `tool:edit(*.ts)`)
- A bare `condition` that looks like a file glob (e.g. `*.rs`,
  `**/*.test.ts`) is a shorthand that expands to `tool:edit(<glob>)` +
  `tool:write(<glob>)` with a catch-all condition.

### Inline rules

Rules may also be supplied directly in plugin config:

```yaml
- id: stream-rules
  name: '@hy-sde-org/dsh-stream-rules'
  config:
    rules:
      - name: no-debugger
        content: Never leave a `debugger` statement behind.
        condition: 'debugger\b'
        scope: [text, tool:edit]
```

### Repeat gating

`repeatMode: once` (default) fires each rule at most once per session;
`repeatMode: gap` re-arms a rule `repeatGap` turns after it fired (default
10). Injection records survive rule reloads, so editing a file does not
re-arm a rule that already fired.

## Interrupt modes

- `always` — abort the stream on any match in scope
- `prose-only` — abort only on text/reasoning matches; tool-argument matches
  become advisory (folded into the tool result)
- `tool-only` — abort only on tool-argument matches; prose matches become
  advisory notices
- `never` — never abort; every match is advisory

## Repairing the interrupted turn

The `contextMode` config decides what happens to the partially-generated
assistant output of the aborted step:

- `keep` (default) — the `interrupted` assistant message stays in the
  transcript and the reminder is appended; the model continues with its own
  aborted output in view. Requires no history surgery.
- `discard` — the aborted step's assistant/tool surface nodes are replaced by
  the reminder via a surface rewrite, so the retry regenerates from a clean
  context. If the rewrite fails (for example under concurrent history
  changes), the guard falls back to `keep` so a retry always happens.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `rulesDir` | `<cwd>/.dsh/rules` | Rule file directory (absolute or cwd-relative) |
| `rules` | `[]` | Inline rules |
| `contextMode` | `keep` | How to repair the interrupted turn |
| `interruptMode` | `always` | Default interrupt mode for rules that do not declare one |
| `repeatMode` | `once` | Repeat gating |
| `repeatGap` | `10` | Turns between re-fires with `repeatMode: gap` |

## Untracked scope (future work)

- `astCondition` matching: the ast-grep engine shells out to a binary per
  run, which is too heavy for a mid-stream check. A debounced per-tool-call
  AST check could be layered on without changing the abort / retry mechanics.
- Static injection of `alwaysApply` rules (the harness already has an
  always-on `agent-instructions` subsystem — a future port may feed
  `alwaysApply` rules there).
- Cross-session persistence of injected rule names (currently per-session, so
  a rule can re-fire after a restart).
