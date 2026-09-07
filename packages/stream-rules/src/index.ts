/**
 * Stream-rules guard: time-traveling stream rules for the harness.
 *
 * Rules stay dormant until a regex matches the LIVE token stream — assistant
 * prose, reasoning text, or tool-call argument deltas. On a match the guard
 * aborts the request, injects the rule as a system reminder, and retries the
 * same point, so a project rule takes effect exactly when it is violated and
 * never pays a per-turn context tax. This is a port of `oh-my-pi`'s
 * time-traveling stream rules (`TtsrManager` + `TtsrCoordinator`) onto the
 * harness's guard/family extension points:
 *
 * - the live stream is observed through `session/event` `assistant/chunk`
 *   events (no LLM-stream surgery);
 * - the abort is `agent.cancel({ kind: 'hook', reason })` — the loop's own
 *   cancellation path, so the partial turn lands as an `interrupted`
 *   assistant message exactly like a user stop;
 * - the retry is `agent.followup(...)` with the rule as a plugin-sourced
 *   `user/message` `notice` — the loop's standard wake, which regenerates the
 *   turn from the same context;
 * - non-interrupting matches are folded into the matched tool's result via
 *   `tools/post-execute` `additionalContexts`, mirroring
 *   `dsh-repeat-tool-reminder`.
 *
 * Rule files live in `<cwd>/.dsh/rules/**\/*.md` (or a configured
 * `rulesDir`), re-scanned on every turn start (mtime-gated), and may also be
 * supplied inline via `config.rules`. See the package README for the full
 * format and semantics.
 *
 * @module @hy-sde-org/dsh-stream-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-internal-urls'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AgentCancelCause, Session, SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { RuleProtocolHandler } from './rule-protocol.ts'
import { StreamRulesRegistry } from './registry.ts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  TtsrManager,
  type TtsrLogger,
  type TtsrMatchContext,
} from './manager.ts'
import {
  listRuleFiles,
  MAIN_AGENT_RULE_NAME,
  parseRuleAgents,
  parseRuleConditionAndScope,
  parseRuleFile,
  ruleAppliesToAgent,
  SUB_AGENT_RULE_NAME,
  type Rule,
  type RuleInterruptMode,
} from './rules.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stream-rules'

export { RuleProtocolHandler } from './rule-protocol.ts'
export type { RuleProtocolDeps } from './rule-protocol.ts'
export { StreamRulesRegistry } from './registry.ts'

/** One inline rule supplied through plugin config instead of a rules file. */
export interface InlineRuleConfig {
  /** Display name of the rule, surfaced in listings and diagnostics. */
  name: string
  /** Rule body in the stream-rules language. */
  content: string
  /** Optional condition on which inputs the rule applies to. */
  condition?: string | string[]
  /** Optional scope narrowing doctor/module/category matches. */
  scope?: string | string[]
  /** Optional agent-name globs limiting the rule to matching agents (absent = every agent). */
  agents?: string | string[]
  /** Optional override of the composed interrupt mode for this rule. */
  interruptMode?: RuleInterruptMode
  /** Optional glob list restricting the rule to matching file paths. */
  globs?: string[]
}

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch (default true). */
  enabled?: boolean
  /**
   * Directory of rule `.md` files. Relative paths resolve against each
   * session's cwd; absolute paths are used verbatim. Defaults to
   * `<cwd>/.dsh/rules`. A missing directory means no file rules.
   */
  rulesDir?: string
  /** Inline rules added to every session, taking precedence over same-named file rules. */
  rules?: InlineRuleConfig[]
  /**
   * How an interrupted turn is repaired: `keep` (default) leaves the
   * partially-generated assistant output in the transcript and appends the
   * reminder; `discard` replaces the aborted step's assistant/tool nodes with
   * the reminder via a surface rewrite, so the retry regenerates from a clean
   * context.
   */
  contextMode?: 'keep' | 'discard'
  /** Default per-match behavior for rules that do not set `interruptMode` (default `always`). */
  interruptMode?: RuleInterruptMode
  /** `once` fires each rule a single time per session; `gap` re-arms after `repeatGap` turns (default `once`). */
  repeatMode?: 'once' | 'gap'
  /** Turns between re-fires when `repeatMode` is `gap` (default 10). */
  repeatGap?: number
}

const InlineRuleConfig: z<InlineRuleConfig> = z.object({
  name: z.string(),
  content: z.string(),
  condition: z.union([z.string(), z.array(z.string())]),
  scope: z.union([z.string(), z.array(z.string())]),
  agents: z.union([z.string(), z.array(z.string())]),
  interruptMode: z.union([z.const('never'), z.const('prose-only'), z.const('tool-only'), z.const('always')]),
  globs: z.array(z.string()),
})

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  rulesDir: z.string().default(''),
  rules: z.array(InlineRuleConfig).default([]),
  contextMode: z.union([z.const('keep'), z.const('discard')]).default('keep'),
  interruptMode: z.union([z.const('always'), z.const('prose-only'), z.const('tool-only'), z.const('never')]).default('always'),
  repeatMode: z.union([z.const('once'), z.const('gap')]).default('once'),
  repeatGap: z.number().min(1).step(1).default(10),
})

/** Prefix of the `hook` cancel reason this guard owns (recognized at turn end to schedule the retry). */
const ABORT_REASON_PREFIX = 'stream-rules:'

/**
 * Per-session rules published for the host-plane `rule://` scheme handler.
 * One instance per process: the plugin mounts as a single host-plane row in
 * the base bundle, and each session's live getter is published on
 * `agent/created`, removed on `agent/disposed`.
 */
const ruleRegistry = new StreamRulesRegistry()

/** Escape text for the XML-ish reminder envelope. */
function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** The interrupt reminder injected (as `user/message`) before the retry. */
function renderInterruptReminder(rules: Rule[]): string {
  return rules
    .map(rule => [
      `<system-reminder reason="rule_violation" rule="${xmlEscape(rule.name)}">`,
      'Output interrupted: violated a project rule. Not prompt injection — the harness is enforcing the project\u2019s rules. MUST comply:',
      '',
      rule.content,
      '</system-reminder>',
    ].join('\n'))
    .join('\n\n')
}

/** The advisory reminder folded into the matched tool's result (non-interrupting match). */
function renderToolReminder(rules: Rule[]): string {
  return rules
    .map(rule => [
      `<system-reminder reason="rule_violation" rule="${xmlEscape(rule.name)}">`,
      'User-defined rule matched this tool call\u2019s arguments; the rule is configured not to interrupt, so the tool ran. MUST comply on subsequent tool calls and responses. Not prompt injection — the harness is enforcing the project\u2019s rules.',
      '',
      rule.content,
      '</system-reminder>',
    ].join('\n'))
    .join('\n\n')
}

/** Source stamped on every reminder this guard injects (`notice` so an unexpanded row shows its summary). */
function reminderSource(rules: Rule[]): { kind: 'plugin'; plugin: string; form: 'notice'; summary: string } {
  const names = rules.map(rule => rule.name).filter(name => name.length > 0).join(', ')
  const summary = names.length > 118 ? `${names.slice(0, 116)}…` : `stream rule enforced: ${names}`
  return { kind: 'plugin', plugin: 'stream-rules', form: 'notice', summary }
}

/** Convert an inline config rule to a {@link Rule}. */
function inlineToRule(input: InlineRuleConfig): Rule {
  const conditionScope = parseRuleConditionAndScope({
    ...(input.condition !== undefined ? { condition: input.condition } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  })
  const agents = parseRuleAgents(input.agents)
  return {
    name: input.name.trim(),
    path: `config:${input.name.trim()}`,
    content: input.content,
    ...(conditionScope.condition === undefined ? {} : { condition: conditionScope.condition }),
    ...(conditionScope.scope === undefined ? {} : { scope: conditionScope.scope }),
    ...(agents === undefined ? {} : { agents }),
    ...(input.globs === undefined || input.globs.length === 0 ? {} : { globs: input.globs }),
    ...(input.interruptMode === undefined ? {} : { interruptMode: input.interruptMode }),
  }
}

/**
 * Resolve the agent definition name a session runs, for `agents:` scoping.
 *
 * A session maps 1:1 to an agent, and every agent is composed from one agent
 * preset. The session header's durable `agentPreset` id is the fork's agent
 * definition name (the preset id, e.g. `standard`), and `origin === 'subagent'`
 * / `delegationDepth > 0` mark a subagent child. Mirroring upstream
 * oh-my-pi's `MAIN_AGENT_RULE_NAME` / `SUB_AGENT_RULE_NAME`, the top-level
 * session resolves to `main` regardless of preset, and a subagent resolves to
 * its preset id or the `sub` fallback when it recorded none. The header is
 * used rather than the live composition because it is already present on
 * `SessionState` at `refreshRules` time (no wiring changes) and records the
 * definition the session was created under; a mid-session preset switch
 * (recompose) still scopes to the header's creation preset since the header
 * is immutable.
 * @param header - the session's durable header (`origin`, `delegationDepth`, `agentPreset`).
 * @returns the lowercased agent name (`main`, the preset id, or `sub`).
 */
export function resolveAgentName(
  header: Pick<SessionHeader, 'origin' | 'delegationDepth' | 'agentPreset'>,
): string {
  const isSubagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  if (!isSubagent) {
    return MAIN_AGENT_RULE_NAME
  }
  const preset = header.agentPreset?.trim().toLowerCase()
  return preset !== undefined && preset.length > 0 ? preset : SUB_AGENT_RULE_NAME
}

/**
 * Filter rules by agent scoping: a rule whose `agents` patterns do not admit
 * `agentName` is dropped before registration, so a scoped rule can never
 * trigger for another agent. An unresolved agent name drops nothing.
 * @param rules - candidate rules.
 * @param agentName - the session's agent definition name, or `undefined` when unknown.
 * @returns the rules that apply to that agent, in input order.
 */
export function selectRulesForAgent(rules: readonly Rule[], agentName: string | undefined): Rule[] {
  return rules.filter(rule => ruleAppliesToAgent(rule, agentName))
}

/** Normalize a candidate file path for glob matching: slashes, absolute, cwd-relative. */
function normalizePathCandidates(rawPath: string, cwd: string): string[] {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) return []
  const normalizedInput = trimmed.replaceAll('\\', '/')
  const candidates = new Set<string>([normalizedInput])
  if (normalizedInput.startsWith('./')) candidates.add(normalizedInput.slice(2))
  const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed)
  candidates.add(absolutePath.replaceAll('\\', '/'))
  const relative = path.relative(cwd, absolutePath).replaceAll('\\', '/')
  if (relative && relative !== '.' && !relative.startsWith('../') && relative !== '..') candidates.add(relative)
  return Array.from(candidates)
}

/** Extract candidate file paths from tool-call arguments (complete or partial). */
function extractFilePathsFromArgs(args: unknown, cwd: string): string[] | undefined {
  const rawPaths: string[] = []
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    for (const key in record) {
      const value = record[key]
      if (typeof value === 'string' && (key === 'path' || key.toLowerCase().endsWith('path'))) {
        rawPaths.push(value)
        continue
      }
      if (Array.isArray(value) && (key === 'paths' || key.toLowerCase().endsWith('paths'))) {
        for (const candidate of value) if (typeof candidate === 'string') rawPaths.push(candidate)
      }
    }
  } else if (typeof args === 'string') {
    // Partial JSON that has not parsed yet: harvest string-valued path fields.
    const field = /["'](?:path|paths|file|files|glob)["']\s*:\s*["']([^"']+)["']/g
    let match: RegExpExecArray | null
    while ((match = field.exec(args)) !== null) rawPaths.push(match[1] ?? '')
    const list = /["'](?:paths|files)["']\s*:\s*\[([^\]]*)\]/g
    while ((match = list.exec(args)) !== null) {
      for (const item of (match[1] ?? '').matchAll(/["']([^"']+)["']/g)) rawPaths.push(item[1] ?? '')
    }
  }
  if (rawPaths.length === 0) return undefined
  const normalized = rawPaths.flatMap(candidate => normalizePathCandidates(candidate, cwd))
  return normalized.length === 0 ? undefined : Array.from(new Set(normalized))
}

/** Per-session guard state: `WeakMap<Session, SessionState>` (a session maps 1:1 to its agent). */
interface SessionState {
  agent: Agent
  session: Session
  manager: TtsrManager
  rulesDir: string | undefined
  /** Parsed file rules keyed by absolute path (cache survives unchanged files). */
  fileRules: Map<string, Rule>
  /** mtimeMs of each cached rule file, for refresh gating. */
  fileMtimes: Map<string, number>
  /** Per-tool-call id → rules matched mid-stream with a non-interrupting mode (delivered on `tools/post-execute`). */
  perTool: Map<string, Rule[]>
  /** Non-interrupting text/reasoning matches awaiting delivery after the assistant message lands. */
  pendingAdvisory: Rule[] | undefined
  /** One interrupt in flight for the current turn; suppresses further interrupts until turn end. */
  pendingAbort: { rules: Rule[] } | undefined
  /** Live tool-call argument accumulation keyed by tool-call id. */
  toolCalls: Map<string, { name: string | undefined; args: string }>
}

/** Narrow a session event to a message-producing surface node. */
function isSurfaceNode(event: SessionEvent): boolean {
  return (event as { surfaceOp?: unknown }).surfaceOp !== undefined
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const enabled = config.enabled ?? true
  const contextMode = config.contextMode ?? 'keep'
  const defaultInterruptMode = config.interruptMode ?? 'always'
  const repeatMode = config.repeatMode ?? 'once'
  const repeatGap = config.repeatGap ?? 10
  const inlineRules = (config.rules ?? []).map(inlineToRule)
  // The `rule://` internal-URL scheme registers into the shared registry
  // exactly once per process: this plugin mounts as one host-plane row, and
  // `ctx.inject` keeps compositions without the registry unaffected. The
  // handler answers for ANY session key — subagents included, whose Agents
  // publish their own state — via the module-level registry above.
  ctx.inject(['internalUrls'], (iuCtx) => {
    iuCtx.effect(() => iuCtx.internalUrls.register(new RuleProtocolHandler({
      rulesFor: sessionKey => ruleRegistry.rulesFor(sessionKey),
    })))
  })

  const sessions = new WeakMap<Session, SessionState>()

  /** Structural logger adapter (Cordis logger is variadic; TtsrLogger is minimal). */
  const loggerAdapter: TtsrLogger = {
    warn: (message, fields) => { ctx.logger.warn(message, fields ?? {}) },
    debug: (message, fields) => { ctx.logger.debug(message, fields ?? {}) },
  }

  /** Resolve a session's rules directory: explicit rulesDir (cwd-relative) else `<cwd>/.dsh/rules`. */
  function resolveRulesDir(state: SessionState): string | undefined {
    const cwd = state.session.header.cwd ?? process.cwd()
    const configured = config.rulesDir
    if (configured && configured.trim().length > 0) {
      return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured)
    }
    return path.join(cwd, '.dsh', 'rules')
  }

  /**
   * (Re)load the session's rule set with an mtime-gated file cache.
   * Injection records survive a reload, so a rule that already fired this
   * session stays fired even after an edit.
   */
  async function refreshRules(state: SessionState): Promise<void> {
    if (!enabled) return
    const manager = state.manager
    const previous = state.fileRules
    const next = new Map<string, Rule>()
    // Agent scoping is resolved once per refresh: rules that do not apply to
    // this session's agent are dropped before registration (never at match
    // time), mirroring upstream's bucketRules precedence.
    const agentName = resolveAgentName(state.session.header)

    // Inline rules are registered before any file I/O, so an inline-only
    // configuration is live from the very first chunk with no async window.
    manager.clearRules()
    for (const rule of selectRulesForAgent(inlineRules, agentName)) {
      manager.addRule(rule)
    }

    const dir = resolveRulesDir(state)
    state.rulesDir = dir
    if (dir) {
      for (const file of listRuleFiles(dir)) {
        try {
          const stat = await fs.promises.stat(file)
          const cached = previous.get(file)
          if (cached && stat.mtimeMs === state.fileMtimes.get(file)) {
            next.set(file, cached)
            continue
          }
          const raw = await fs.promises.readFile(file, 'utf-8')
          const rule = parseRuleFile(file, raw, dir)
          if (rule) {
            state.fileMtimes.set(file, stat.mtimeMs)
            next.set(file, rule)
          }
        } catch (error) {
          ctx.logger.warn('stream-rules: failed to read rule file', {
            file,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    state.fileRules = next

    // Snapshot what already streamed while the file pass was awaiting I/O, so
    // content is not silently dropped when the rule table swaps beneath it.
    const prior = manager.snapshotBuffers()

    // Rebuild the manager's table; injection records are preserved inside the
    // manager (clearRules does not touch them).
    manager.clearRules()
    for (const rule of selectRulesForAgent(inlineRules, agentName)) {
      manager.addRule(rule)
    }
    for (const rule of selectRulesForAgent([...next.values()], agentName)) {
      manager.addRule(rule)
    }

    // Re-check the pre-reload buffers against the now-live rules and route any
    // match exactly like a normal stream match.
    const byContext = new Map<TtsrMatchContext, Rule[]>()
    for (const hit of manager.recheckBuffers(prior)) {
      const rules = byContext.get(hit.context) ?? []
      rules.push(hit.rule)
      byContext.set(hit.context, rules)
    }
    for (const [context, rules] of byContext) {
      handleMatches(state, rules, context)
    }

    ctx.logger.debug('stream-rules: refreshed rule set', {
      ruleCount: manager.getRules().length,
      session: state.session.id,
    })
  }

  /** Build the interrupt reminder message (injection + retry wake). */
  function buildRetryMessage(rules: Rule[]): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: renderInterruptReminder(rules) }],
      source: reminderSource(rules),
    })
  }

  /** Whether a matched rule interrupts the stream per its mode and the match source. */
  function shouldInterrupt(rule: Rule, source: TtsrMatchContext['source']): boolean {
    const mode = rule.interruptMode ?? defaultInterruptMode
    switch (mode) {
      case 'never':
        return false
      case 'prose-only':
        return source === 'text' || source === 'thinking'
      case 'tool-only':
        return source === 'tool'
      case 'always':
        return true
    }
  }

  /** Extract the tool-call id from a `toolcall:<id>` stream key. */
  function toolCallIdFromKey(streamKey: string | undefined): string | undefined {
    if (typeof streamKey !== 'string' || !streamKey.startsWith('toolcall:')) return undefined
    const id = streamKey.slice('toolcall:'.length)
    return id.length > 0 ? id : undefined
  }

  /** Merge two rule lists by name, preserving order and uniqueness. */
  function mergeDistinct(left: Rule[] | undefined, right: Rule[]): Rule[] {
    const seen = new Set((left ?? []).map(rule => rule.name))
    const merged = [...(left ?? [])]
    for (const rule of right) {
      if (!seen.has(rule.name)) {
        seen.add(rule.name)
        merged.push(rule)
      }
    }
    return merged
  }

  /** Feed one stream delta into the manager and route any match. */
  function feedChunk(state: SessionState, event: SessionEvent<'assistant/chunk'>): void {
    const chunk = event.data.chunk
    const cwd = state.session.header.cwd ?? process.cwd()
    switch (chunk.type) {
      case 'text-delta': {
        const context: TtsrMatchContext = { source: 'text', streamKey: 'text' }
        handleMatches(state, state.manager.checkDelta(chunk.text, context), context)
        return
      }
      case 'reasoning-delta': {
        const context: TtsrMatchContext = { source: 'thinking', streamKey: 'thinking' }
        handleMatches(state, state.manager.checkDelta(chunk.text, context), context)
        return
      }
      case 'tool-call-delta': {
        const id = String(chunk.id)
        const tracked = state.toolCalls.get(id) ?? { name: undefined, args: '' }
        if (chunk.name !== undefined) tracked.name = chunk.name
        tracked.args += chunk.argumentsDelta
        state.toolCalls.set(id, tracked)
        const filePaths = extractFilePathsFromArgs(tracked.args, cwd)
        const context: TtsrMatchContext = {
          source: 'tool',
          streamKey: `toolcall:${id}`,
          ...(tracked.name !== undefined ? { toolName: tracked.name } : {}),
          ...(filePaths === undefined ? {} : { filePaths }),
        }
        handleMatches(state, state.manager.checkDelta(chunk.argumentsDelta, context), context)
        return
      }
      default:
        return
    }
  }

  /** Route a batch of matched rules: interrupt or advisory delivery. */
  function handleMatches(state: SessionState, matches: Rule[], context: TtsrMatchContext): void {
    if (matches.length === 0 || state.pendingAbort) return
    const interrupting = matches.filter(rule => shouldInterrupt(rule, context.source))
    if (interrupting.length > 0) {
      const { agent } = state
      state.pendingAbort = { rules: matches }
      state.perTool.clear()
      state.pendingAdvisory = undefined
      const reason = `${ABORT_REASON_PREFIX} ${interrupting.map(rule => rule.name).join(', ')} matched the stream`
      // Defer: `agent.cancel` re-enters the session (inbox clear splices a
      // durable event) and must never run inside an append publication.
      queueMicrotask(() => {
        if (agent.status !== 'running') return
        agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
      })
      return
    }

    // Non-interrupting: fold into the matched tool's result, or queue an
    // advisory notice delivered after the assistant message lands.
    const callId = context.source === 'tool' ? toolCallIdFromKey(context.streamKey) : undefined
    if (callId && context.source === 'tool') {
      const bucket = state.perTool.get(callId) ?? []
      const seen = new Set(bucket.map(rule => rule.name))
      for (const rule of matches) if (!seen.has(rule.name)) bucket.push(rule)
      state.perTool.set(callId, bucket)
      return
    }
    state.pendingAdvisory = mergeDistinct(state.pendingAdvisory, matches)
  }

  /** Schedule the post-abort retry once the aborted turn has fully landed. */
  function scheduleRetry(state: SessionState, rules: Rule[], abortedTurn: number): void {
    const { agent, session, manager } = state
    const reminder = buildRetryMessage(rules)

    // Defer outside the turn/end append publication.
    setTimeout(() => {
      try {
        if (contextMode === 'discard') {
          const range = computeDiscardRange(session, abortedTurn)
          if (range) {
            try {
              session.append(
                'user/message',
                reminder,
                { surfaceOp: { op: 'replace', start: SessionSeq(range.start), end: SessionSeq(range.end) }, sourceEventSeqs: range.shadowed.map(seq => SessionSeq(seq)) },
              )
            } catch (error) {
              // A failed rewrite must not strand the session without a retry:
              // fall back to the keep-mode append path.
              ctx.logger.warn('stream-rules: discard rewrite failed, falling back to keep mode', {
                session: session.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
        manager.markInjected(rules)
        agent.followup(reminder)
      } catch (error) {
        ctx.logger.warn('stream-rules: retry scheduling failed', {
          session: session.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }, 0)
  }

  /**
   * Compute the surface range the aborted step produced — the assistant
   * message plus any tool results of the LAST step — so a `discard` rewrite
   * can replace exactly that and keep the turn's prompt.
   */
  function computeDiscardRange(session: Session, turn: number): { start: number; end: number; shadowed: number[] } | undefined {
    const events = session.snapshotEvents()
    // Locate the last step of this turn.
    let stepStartIndex = -1
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type === 'step/start' && event.data.turn === turn) {
        stepStartIndex = index
        break
      }
    }
    if (stepStartIndex === -1) return undefined

    const shadowed: number[] = []
    for (let index = stepStartIndex + 1; index < events.length; index++) {
      const event = events[index]
      if (event === undefined) break
      if (event.type === 'turn/end') break
      // Surface nodes only, and never the step's claimed user prompt or an
      // injected context: those must survive for the retry.
      if (!isSurfaceNode(event)) continue
      if (event.type === 'user/message') continue
      shadowed.push(event.seq)
    }
    if (shadowed.length === 0) return undefined
    return { start: Math.min(...shadowed), end: Math.max(...shadowed), shadowed }
  }

  // ---- lifecycle: one state per agent/session ----
  ctx.on('agent/created', ({ agent }) => {
    try {
      const manager = new TtsrManager(
        { enabled, contextMode, interruptMode: defaultInterruptMode, repeatMode, repeatGap },
        loggerAdapter,
      )
      const state: SessionState = {
        agent,
        session: agent.session,
        manager,
        rulesDir: undefined,
        fileRules: new Map(),
        fileMtimes: new Map(),
        perTool: new Map(),
        pendingAdvisory: undefined,
        pendingAbort: undefined,
        toolCalls: new Map(),
      }
      sessions.set(agent.session, state)
      ruleRegistry.publish(agent.session.header.id, () => state.manager.getRules())
      void refreshRules(state).catch((error: unknown) => {
        ctx.logger.warn('stream-rules: initial rule load failed', { session: agent.session.id, error: String(error) })
      })
    } catch (error) {
      ctx.logger.warn('stream-rules: agent setup failed', { error: String(error) })
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    ruleRegistry.unpublish(agent.session.header.id)
    sessions.delete(agent.session)
  })

  // ---- the live stream ----
  ctx.on('session/event', (session, event) => {
    const state = sessions.get(session)
    // Note: no `hasRules()` gate here on purpose — chunks must keep buffering
    // while a rule-table reload is in flight so the reload's `recheckBuffers`
    // can still see and match content that streamed during the window.
    if (!state || !enabled) return

    switch (event.type) {
      case 'turn/start': {
        state.manager.resetBuffer()
        void refreshRules(state).catch(() => {})
        return
      }
      case 'assistant/chunk': {
        feedChunk(state, event)
        return
      }
      case 'assistant/message': {
        // Non-interrupting text/reasoning matches become an advisory notice
        // AFTER the completed message, so the model sees it next step.
        if (state.pendingAdvisory && state.pendingAdvisory.length > 0) {
          const advisory = state.pendingAdvisory
          state.pendingAdvisory = undefined
          queueMicrotask(() => {
            try {
              session.append('user/message', createUserMessage({
                content: [{ type: 'text', text: renderInterruptReminder(advisory) }],
                source: reminderSource(advisory),
              }), { surfaceOp: 'append' })
            } catch (error) {
              ctx.logger.warn('stream-rules: advisory append failed', { session: session.id, error: String(error) })
            }
          })
        }
        return
      }
      case 'turn/end': {
        state.manager.incrementMessageCount()
        state.perTool.clear()
        state.pendingAdvisory = undefined
        state.toolCalls.clear()
        const abort = state.pendingAbort
        state.pendingAbort = undefined
        if (!abort) return
        const reason = event.data.reason
        if (reason.kind !== 'aborted') return
        const cause = reason.reason as AgentCancelCause | undefined
        if (cause?.kind !== 'hook' || !cause.reason.startsWith(ABORT_REASON_PREFIX)) return
        scheduleRetry(state, abort.rules, event.data.turn)
        return
      }
      default:
        return
    }
  })

  // ---- non-interrupting tool matches: fold into the matched tool's result ----
  ctx.on('tools/post-execute', async (exec: ToolExecution, _result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    const state = agent ? sessions.get(agent.session) : undefined
    if (!state) return next()
    const callId = String(exec.callId)
    const rules = state.perTool.get(callId)
    if (!rules || rules.length === 0) return next()
    state.perTool.delete(callId)
    state.manager.markInjected(rules)
    const reminder = createUserMessage({
      content: [{ type: 'text', text: renderToolReminder(rules) }],
      source: reminderSource(rules),
    })
    const downstream = await next()
    const additionalContexts = [reminder, ...(downstream.additionalContexts ?? [])]
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts }
    }
    return { ...downstream, additionalContexts }
  })
}
