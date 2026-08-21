/**
 * Time-Traveling Stream Rules (TTSR) manager.
 *
 * Rules stay dormant until a condition pattern matches the live token stream;
 * the guard then aborts the request, injects the rule as a reminder, and
 * retries from the same point — course-correction with zero per-turn context
 * tax, surviving compaction because the rule itself never entered the request.
 *
 * This is a direct port of `oh-my-pi`'s `TtsrManager`
 * (`packages/coding-agent/src/export/ttsr.ts`), adapted to the harness:
 *
 * - `Bun.Glob` is replaced by the portable glob compiler in {@link rules.ts};
 * - ast-grep `astCondition` rules are not yet supported (the harness's
 *   ast-grep engine shells out to a binary per run, which is too heavy for a
 *   mid-stream check); rules carrying only AST conditions are rejected at
 *   registration with a warning;
 * - a `logger` is injected by the owning plugin instead of a shared util.
 *
 * The manager is pure state + matching: it owns the per-stream buffers, the
 * repeat gating records, and the rules table, and it never touches the session
 * or the agent. All wiring lives in the plugin.
 *
 * @module @deepseek-ai/dsh-stream-rules/manager
 */

import {
  compileGlob,
  compileRuleCondition,
  type CompiledGlob,
  type Rule,
  type RuleInterruptMode,
} from './rules.ts'

/** Which stream a delta belongs to. */
export type TtsrMatchSource = 'text' | 'thinking' | 'tool'

/** Context about the stream content currently checked against TTSR rules. */
export interface TtsrMatchContext {
  source: TtsrMatchSource
  /** Tool name for tool argument deltas, e.g. "edit" or "write". */
  toolName?: string
  /** Candidate file paths associated with the current stream chunk. */
  filePaths?: string[]
  /** Stable key to isolate buffering (for example a tool call id). */
  streamKey?: string
}

interface ToolScope {
  toolName?: string
  pathGlob?: CompiledGlob
  pathPattern?: string
}

interface TtsrScope {
  allowText: boolean
  allowThinking: boolean
  allowAnyTool: boolean
  toolScopes: ToolScope[]
}

interface TtsrEntry {
  rule: Rule
  conditions: RegExp[]
  scope: TtsrScope
  globalPathGlobs?: CompiledGlob[]
}

/** Tracks when a rule was last injected (for repeat gating). */
interface InjectionRecord {
  /** Turn index when the rule was last injected. */
  lastInjectedAt: number
}

/** Operational TTSR settings. */
export interface TtsrSettings {
  enabled?: boolean
  /** How to treat the partially-generated assistant output of an interrupted turn. */
  contextMode?: 'keep' | 'discard'
  /**
   * Default per-match behavior when a rule does not declare its own
   * `interruptMode`. `always` aborts the stream; `prose-only` aborts only on
   * text/reasoning matches (tool matches attach to the tool result instead);
   * `tool-only` aborts only on tool-call argument matches; `never` never
   * aborts and always delivers advisory context.
   */
  interruptMode?: RuleInterruptMode
  /** `once` fires each rule a single time per session; `gap` re-arms after `repeatGap` turns. */
  repeatMode?: 'once' | 'gap'
  /** Turns between re-fires when `repeatMode` is `gap`. */
  repeatGap?: number
  /** Whether Builtin-like/global rules may trigger at all. Reserved; defaults true. */
  builtinRules?: boolean
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
  enabled: true,
  contextMode: 'keep',
  interruptMode: 'always',
  repeatMode: 'once',
  repeatGap: 10,
  builtinRules: true,
}

const DEFAULT_SCOPE: TtsrScope = {
  allowText: true,
  allowThinking: false,
  allowAnyTool: true,
  toolScopes: [],
}

/** Minimal structural logger the manager tolerates (the plugin passes its Cordis logger). */
export interface TtsrLogger {
  warn(message: string, fields?: Record<string, unknown>): void
  debug(message: string, fields?: Record<string, unknown>): void
}

export class TtsrManager {
  readonly #settings: Required<TtsrSettings>
  readonly #rules = new Map<string, TtsrEntry>()
  readonly #injectionRecords = new Map<string, InjectionRecord>()
  readonly #buffers = new Map<string, string>()
  readonly #bufferContexts = new Map<string, TtsrMatchContext>()
  #messageCount = 0
  #canMatchText = false
  #canMatchThinking = false

  constructor(settings?: TtsrSettings, private readonly logger?: TtsrLogger) {
    this.#settings = { ...DEFAULT_SETTINGS, ...settings }
  }

  /** Check if a rule can be triggered based on repeat settings. */
  #canTrigger(ruleName: string): boolean {
    const record = this.#injectionRecords.get(ruleName)
    if (!record) {
      return true
    }

    if (this.#settings.repeatMode === 'once') {
      return false
    }

    const gap = this.#messageCount - record.lastInjectedAt
    return gap >= this.#settings.repeatGap
  }

  #compileConditions(rule: Rule): RegExp[] {
    const compiled: RegExp[] = []
    for (const pattern of rule.condition ?? []) {
      try {
        compiled.push(compileRuleCondition(pattern))
      } catch (error) {
        this.logger?.warn('stream-rules: condition has invalid regex pattern, skipping condition', {
          ruleName: rule.name,
          pattern,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return compiled
  }

  #compileGlobalPathGlobs(globs: Rule['globs']): CompiledGlob[] | undefined {
    if (!globs || globs.length === 0) {
      return undefined
    }

    const compiled = globs
      .map(glob => glob.trim())
      .filter(glob => glob.length > 0)
      .map(pattern => compileGlob(pattern))
    return compiled.length > 0 ? compiled : undefined
  }

  #parseToolScopeToken(token: string): ToolScope | undefined {
    const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
      token,
    )
    if (!match) {
      return undefined
    }

    const groups = match.groups
    const hasToolPrefix = groups?.prefix !== undefined
    const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase()
    const pathPattern = groups?.path?.trim()

    if (!pathPattern) {
      return toolName === undefined ? {} : { toolName }
    }

    return {
      ...(toolName === undefined ? {} : { toolName }),
      pathPattern,
      pathGlob: compileGlob(pathPattern),
    }
  }

  #buildScope(rule: Rule): TtsrScope {
    if (!rule.scope || rule.scope.length === 0) {
      return {
        allowText: DEFAULT_SCOPE.allowText,
        allowThinking: DEFAULT_SCOPE.allowThinking,
        allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
        toolScopes: [...DEFAULT_SCOPE.toolScopes],
      }
    }

    const scope: TtsrScope = {
      allowText: false,
      allowThinking: false,
      allowAnyTool: false,
      toolScopes: [],
    }

    for (const rawToken of rule.scope) {
      const token = rawToken.trim()
      const normalizedToken = token.toLowerCase()
      if (token.length === 0) {
        continue
      }

      if (normalizedToken === 'text') {
        scope.allowText = true
        continue
      }

      if (normalizedToken === 'thinking') {
        scope.allowThinking = true
        continue
      }

      if (normalizedToken === 'tool' || normalizedToken === 'toolcall') {
        scope.allowAnyTool = true
        continue
      }

      const toolScope = this.#parseToolScopeToken(token)
      if (!toolScope) {
        this.logger?.warn('stream-rules: scope token is invalid, skipping token', {
          ruleName: rule.name,
          token: rawToken,
        })
        continue
      }

      if (!toolScope.toolName && !toolScope.pathGlob) {
        scope.allowAnyTool = true
        continue
      }

      scope.toolScopes.push(toolScope)
    }

    return scope
  }

  #hasReachableScope(scope: TtsrScope): boolean {
    return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0
  }

  #bufferKey(context: TtsrMatchContext): string {
    if (context.streamKey && context.streamKey.trim().length > 0) {
      return context.streamKey
    }
    if (context.source !== 'tool') {
      return context.source
    }
    const toolName = context.toolName?.trim().toLowerCase()
    return toolName ? `tool:${toolName}` : 'tool'
  }

  #normalizePath(pathValue: string): string {
    return pathValue.replaceAll('\\', '/')
  }

  #matchesGlob(glob: CompiledGlob, filePaths: string[] | undefined): boolean {
    if (!filePaths || filePaths.length === 0) {
      return false
    }
    for (const filePath of filePaths) {
      const normalized = this.#normalizePath(filePath)
      if (glob.match(normalized)) {
        return true
      }
      const slashIndex = normalized.lastIndexOf('/')
      const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1)
      if (basename !== normalized && glob.match(basename)) {
        return true
      }
    }

    return false
  }

  #matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
    if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
      return true
    }

    for (const glob of entry.globalPathGlobs) {
      if (this.#matchesGlob(glob, context.filePaths)) {
        return true
      }
    }

    return false
  }

  #matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
    if (context.source === 'text') {
      return entry.scope.allowText
    }

    if (context.source === 'thinking') {
      return entry.scope.allowThinking
    }

    if (entry.scope.allowAnyTool) {
      return true
    }

    const toolName = context.toolName?.trim().toLowerCase()
    for (const toolScope of entry.scope.toolScopes) {
      if (toolScope.toolName && toolScope.toolName !== toolName) {
        continue
      }
      if (toolScope.pathGlob && !this.#matchesGlob(toolScope.pathGlob, context.filePaths)) {
        continue
      }
      return true
    }

    return false
  }

  #matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
    for (const condition of entry.conditions) {
      condition.lastIndex = 0
      if (condition.test(streamBuffer)) {
        return true
      }
    }
    return false
  }

  /** Add a TTSR rule to be monitored. */
  addRule(rule: Rule): boolean {
    if (!this.#settings.enabled) {
      return false
    }
    if (this.#rules.has(rule.name)) {
      return false
    }

    const conditions = this.#compileConditions(rule)
    if (conditions.length === 0) {
      if ((rule.astCondition?.length ?? 0) > 0) {
        this.logger?.warn(
          'stream-rules: rule carries only astCondition patterns, which are not yet supported — skipping rule',
          { ruleName: rule.name },
        )
      }
      return false
    }

    const scope = this.#buildScope(rule)
    if (!this.#hasReachableScope(scope)) {
      this.logger?.warn('stream-rules: scope excludes all streams, skipping rule', {
        ruleName: rule.name,
        scope: rule.scope,
      })
      return false
    }
    const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs)
    const entry: TtsrEntry = { rule, conditions, scope }
    if (globalPathGlobs !== undefined) {
      entry.globalPathGlobs = globalPathGlobs
    }
    this.#rules.set(rule.name, entry)
    if (scope.allowText) this.#canMatchText = true
    if (scope.allowThinking) this.#canMatchThinking = true

    return true
  }

  /** Remove every rule (used when reloading a rules directory; injection records survive). */
  clearRules(): void {
    this.#rules.clear()
    this.#buffers.clear()
    this.#bufferContexts.clear()
    this.#canMatchText = false
    this.#canMatchThinking = false
  }

  /**
   * Add a stream chunk to its scoped buffer and return matching rules.
   *
   * Buffers are isolated by source/tool key so matches don't bleed across
   * assistant prose, reasoning text, and unrelated tool argument streams.
   * Content is always accumulated — even before any matching rule exists — so
   * text streamed while a rule-table reload is in flight is not silently
   * dropped; `recheckBuffers` matches such content once the rules land.
   */
  checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
    const bufferKey = this.#bufferKey(context)
    const nextBuffer = `${this.#buffers.get(bufferKey) ?? ''}${delta}`
    this.#buffers.set(bufferKey, nextBuffer)
    this.#bufferContexts.set(bufferKey, context)
    if (context.source === 'text' && !this.#canMatchText) {
      return []
    }
    if (context.source === 'thinking' && !this.#canMatchThinking) {
      return []
    }
    return this.#matchBuffer(nextBuffer, context)
  }

  #matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
    if (!this.#settings.enabled) {
      return []
    }
    const matches: Rule[] = []
    for (const [name, entry] of this.#rules) {
      if (!this.#canTrigger(name)) {
        continue
      }
      if (!this.#matchesScope(entry, context)) {
        continue
      }
      if (!this.#matchesGlobalPaths(entry, context)) {
        continue
      }
      if (!this.#matchesCondition(entry, buffer)) {
        continue
      }

      matches.push(entry.rule)
      this.logger?.debug('stream-rules: condition matched', {
        ruleName: name,
        conditions: entry.rule.condition,
        source: context.source,
        toolName: context.toolName,
        filePaths: context.filePaths,
      })
    }

    return matches
  }

  /** Mark rules as injected (won't trigger again until conditions allow). */
  markInjected(rulesToMark: Rule[]): void {
    this.markInjectedByNames(rulesToMark.map(rule => rule.name))
  }

  /** Mark rule names as injected (won't trigger again until conditions allow). */
  markInjectedByNames(ruleNames: string[]): void {
    for (const rawName of ruleNames) {
      const ruleName = rawName.trim()
      if (ruleName.length === 0) {
        continue
      }
      const record = this.#injectionRecords.get(ruleName)
      if (!record) {
        this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount })
      } else {
        record.lastInjectedAt = this.#messageCount
      }
      this.logger?.debug('stream-rules: rule marked as injected', {
        ruleName,
        messageCount: this.#messageCount,
        repeatMode: this.#settings.repeatMode,
      })
    }
  }

  /** Get names of all injected rules (for persistence). */
  getInjectedRuleNames(): string[] {
    return Array.from(this.#injectionRecords.keys())
  }

  /** Restore injected state from a list of rule names. */
  restoreInjected(ruleNames: string[]): void {
    for (const name of ruleNames) {
      this.#injectionRecords.set(name, { lastInjectedAt: 0 })
    }
    if (ruleNames.length > 0) {
      this.logger?.debug('stream-rules: injected state restored', { ruleNames })
    }
  }

  /** Reset stream buffers (called on new turn). */
  resetBuffer(): void {
    this.#buffers.clear()
    this.#bufferContexts.clear()
  }

  /**
   * Snapshot the current buffers and their source contexts. The plugin takes
   * this before `clearRules()` rebuilds the rule table, then passes it to
   * `recheckBuffers` so content that streamed while the reload was in flight
   * is still matched once the new rules are live.
   */
  snapshotBuffers(): Array<{ buffer: string; context: TtsrMatchContext }> {
    const snapshot: Array<{ buffer: string; context: TtsrMatchContext }> = []
    for (const [bufferKey, buffer] of this.#buffers) {
      snapshot.push({
        buffer,
        context: this.#bufferContexts.get(bufferKey) ?? this.#fallbackContext(bufferKey),
      })
    }
    return snapshot
  }

  /** Derive a best-effort context for a buffer key recorded before tracking existed. */
  #fallbackContext(bufferKey: string): TtsrMatchContext {
    if (bufferKey === 'text') return { source: 'text', streamKey: 'text' }
    if (bufferKey === 'thinking') return { source: 'thinking', streamKey: 'thinking' }
    if (bufferKey.startsWith('tool:')) {
      return { source: 'tool', streamKey: bufferKey, toolName: bufferKey.slice('tool:'.length) }
    }
    return { source: 'tool', streamKey: bufferKey }
  }

  /**
   * Re-match a set of buffers against the current rule table without appending
   * any new content. Used right after a rule-table rebuild so streamed text
   * that arrived while the reload was in flight still triggers. When `prior`
   * is given it is checked instead of the live buffers (which `clearRules`
   * emptied). Each hit repeats the exact context the content was fed under.
   */
  recheckBuffers(prior?: Array<{ buffer: string; context: TtsrMatchContext }>): Array<{ rule: Rule; context: TtsrMatchContext }> {
    if (!this.#settings.enabled || this.#rules.size === 0) {
      return []
    }
    const sources: Array<{ buffer: string; context: TtsrMatchContext }> = prior ?? []
    if (!prior) {
      for (const [bufferKey, buffer] of this.#buffers) {
        sources.push({
          buffer,
          context: this.#bufferContexts.get(bufferKey) ?? this.#fallbackContext(bufferKey),
        })
      }
    }
    const hits: Array<{ rule: Rule; context: TtsrMatchContext }> = []
    for (const { buffer, context } of sources) {
      for (const rule of this.#matchBuffer(buffer, context)) {
        hits.push({ rule, context })
      }
    }
    return hits
  }

  /** Check if any TTSR rules are registered. */
  hasRules(): boolean {
    if (!this.#settings.enabled) {
      return false
    }
    return this.#rules.size > 0
  }

  /** All rules currently registered for TTSR monitoring, in registration order. */
  getRules(): Rule[] {
    return Array.from(this.#rules.values(), entry => entry.rule)
  }

  /** Increment message counter (call after each turn). */
  incrementMessageCount(): void {
    this.#messageCount++
  }

  /** Get current message count. */
  getMessageCount(): number {
    return this.#messageCount
  }

  /** Get settings. */
  getSettings(): Required<TtsrSettings> {
    return { ...this.#settings }
  }
}
