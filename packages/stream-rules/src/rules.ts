/**
 * Stream-rule types, parsing, and loading.
 *
 * Rule files are Markdown documents with a YAML frontmatter block, following
 * the format pioneered by `oh-my-pi`'s rule capability
 * (`packages/coding-agent/src/capability/rule.ts`):
 *
 * ```markdown
 * ---
 * description: Never log secrets
 * globs: ["**\/*.ts"]
 * scope: ["text", "tool:edit(*.ts)", "tool:write(*.ts)"]
 * condition:
 *   - console\.log\(.*(password|secret)
 * interruptMode: always
 * ---
 * Never log passwords or API keys...
 * ```
 *
 * Supported frontmatter keys: `name` (override; defaults to the file stem),
 * `description`, `globs`, `alwaysApply`, `condition` (string or string[]),
 * `scope` (string or string[]), `agents` (string or string[]; agent-name
 * globs limiting which agents the rule applies to), `interruptMode`
 * (`never` | `prose-only` | `tool-only` | `always`). `astCondition` is parsed
 * but not yet supported — a rule whose only conditions are AST patterns is
 * rejected at registration (see {@link manager.ts}).
 *
 * The module owns the portable glob compiler that replaces omp's `Bun.Glob`,
 * plus the `compileRuleCondition` inline-flag translation.
 *
 * @module @deepseek-ai/dsh-stream-rules/rules
 */

import { promises as fs, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { parse } from 'yaml'

/** Per-rule TTSR interrupt mode override. */
export type RuleInterruptMode = 'never' | 'prose-only' | 'tool-only' | 'always'

/**
 * A project rule that can be enforced reactively: it stays dormant until one of
 * its `condition` patterns matches the live token stream.
 */
export interface Rule {
  /** Rule name (derived from filename, or overridden in frontmatter). */
  name: string
  /** Absolute path to the rule file (or a synthetic marker for inline rules). */
  path: string
  /** Rule content (after frontmatter stripped). */
  content: string
  /** Globs this rule applies to (matched against candidate tool file paths). */
  globs?: string[]
  /** Whether to always include this rule (accepted for compatibility; no static injection yet). */
  alwaysApply?: boolean
  /** Description (for agent-requested rules). */
  description?: string
  /** Regex condition(s) that can trigger an interruption. */
  condition?: string[]
  /** ast-grep pattern condition(s); parsed for compatibility but not yet supported in matching. */
  astCondition?: string[]
  /** Optional stream scope tokens (for example: `text`, `thinking`, `tool:edit(*.ts)`). */
  scope?: string[]
  /**
   * Lowercased agent-name globs this rule applies to (absent = every agent).
   * `main` targets the top-level session; other names target subagents running
   * that agent definition.
   */
  agents?: string[]
  /** Per-rule interrupt mode override (falls back to the global setting). */
  interruptMode?: RuleInterruptMode
}

/** A compiled glob predicate sharing omp's `Bun.Glob` surface. */
export interface CompiledGlob {
  readonly pattern: string
  match(value: string): boolean
}

// ---------------------------------------------------------------------------
// Glob compiler (portable replacement for Bun.Glob)
// ---------------------------------------------------------------------------

/** Escape glob metacharacters that must match literally in a character class. */
function regexpEscaped(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
}

/**
 * Compile a glob pattern into a full-match RegExp.
 *
 * Supported syntax: `*` (any run of non-separator chars), `**` (any run
 * including separators), `?` (one non-separator char), `[...]` character
 * classes, and `{a,b}` alternation. A pattern without separators is anchored
 * as a basename matcher; callers additionally try the full path and the
 * basename of candidate file paths, so globs may name either.
 */
export function compileGlob(pattern: string): CompiledGlob {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` crosses directory boundaries; a bare `**` matches anything.
        index++
        if (pattern[index + 1] === '/') {
          source += '(?:[^/]*/)*'
          index++
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      // Find the closing bracket (respecting a leading `!`/`^` negation).
      let end = index + 1
      if (pattern[end] === '!' || pattern[end] === '^') end++
      if (pattern[end] === ']') end++
      while (end < pattern.length && pattern[end] !== ']') end++
      if (end >= pattern.length) {
        // Unterminated class: treat the `[` literally.
        source += '\\['
        continue
      }
      let inner = pattern.slice(index + 1, end)
      if (inner.startsWith('!')) inner = `^${inner.slice(1)}`
      else if (inner.startsWith('^')) inner = `\\${inner}`
      source += `[${inner}]`
      index = end
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index + 1)
      if (end === -1) {
        source += '\\{'
        continue
      }
      const alternatives = pattern
        .slice(index + 1, end)
        .split(',')
        .map(part => compileFragment(part))
      source += `(?:${alternatives.join('|')})`
      index = end
      continue
    }
    source += regexpEscaped(char)
  }
  return {
    pattern,
    match(value: string): boolean {
      return new RegExp(`^${source}$`).test(value)
    },
  }
}

/** Compile one comma-separated `{...}` alternative using the same token rules. */
function compileFragment(fragment: string): string {
  let source = ''
  for (let index = 0; index < fragment.length; index++) {
    const char = fragment.charAt(index)
    if (char === '*') {
      if (fragment[index + 1] === '*') {
        index++
        source += '.*'
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = fragment.indexOf(']', index + 1)
      if (end === -1) {
        source += '\\['
        continue
      }
      let inner = fragment.slice(index + 1, end)
      if (inner.startsWith('!')) inner = `^${inner.slice(1)}`
      else if (inner.startsWith('^')) inner = `\\${inner}`
      source += `[${inner}]`
      index = end
      continue
    }
    source += regexpEscaped(char)
  }
  return source
}

// ---------------------------------------------------------------------------
// Rule condition + scope parsing (ported from omp's rule capability)
// ---------------------------------------------------------------------------

const CONDITION_GLOB_SCOPE_TOOLS = ['edit', 'write'] as const

/** Leading PCRE-style inline flag group, e.g. `(?i)` or `(?ims)`. */
const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/

/** Inline flags that map cleanly onto native `RegExp` flags. */
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/

/**
 * Compile a rule `condition` into a `RegExp`, translating a leading PCRE-style
 * inline flag group into native `RegExp` flags. JS `RegExp` rejects inline flag
 * prefixes such as `(?i)`, so a rule written `condition: "(?i)todo"` would
 * otherwise throw at compile time and be silently dropped. Unsupported
 * mid-pattern groups pass through verbatim so the native error still surfaces
 * for genuinely invalid patterns.
 */
export function compileRuleCondition(pattern: string): RegExp {
  const match = INLINE_FLAG_PREFIX.exec(pattern)
  if (match && TRANSLATABLE_INLINE_FLAGS.test(match[1] ?? '')) {
    const flags = Array.from(new Set(match[1] ?? '')).join('')
    return new RegExp(pattern.slice(match[0].length), flags)
  }
  return new RegExp(pattern)
}

function normalizeRuleField(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const token = value.trim()
    return token.length > 0 ? [token] : undefined
  }
  if (!Array.isArray(value)) {
    return undefined
  }

  const tokens = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0)
  if (tokens.length === 0) {
    return undefined
  }

  return Array.from(new Set(tokens))
}

function splitScopeTokens(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (const char of value) {
    if (char === '(') {
      parenDepth++
      current += char
      continue
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      current += char
      continue
    }
    if (char === '[') {
      bracketDepth++
      current += char
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      current += char
      continue
    }
    if (char === '{') {
      braceDepth++
      current += char
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      current += char
      continue
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const token = current.trim()
      if (token.length > 0) {
        tokens.push(token)
      }
      current = ''
      continue
    }
    current += char
  }

  const tail = current.trim()
  if (tail.length > 0) {
    tokens.push(tail)
  }

  return tokens
}

function normalizeScopeField(value: unknown): string[] | undefined {
  const normalized = normalizeRuleField(value)
  if (!normalized) {
    return undefined
  }

  const tokens = normalized
    .flatMap(splitScopeTokens)
    .map((token) => {
      // Tolerate malformed frontmatter (e.g. `scope: "text","thinking"`).
      const quote = token[0]
      if (token.length >= 2 && (quote === '"' || quote === "'") && token[token.length - 1] === quote) {
        return token.slice(1, -1).trim()
      }
      return token
    })
    .filter(item => item.length > 0)
  if (tokens.length === 0) {
    return undefined
  }
  return Array.from(new Set(tokens))
}

/** Heuristic for a condition shorthand that looks like a file glob (for example `*.rs`). */
function isLikelyFileGlob(value: string): boolean {
  const token = value.trim()
  if (token.length === 0) {
    return false
  }
  if (/[\\^$+|()]/.test(token)) {
    return false
  }
  if (!/[?*[\]{}]/.test(token)) {
    return false
  }
  if (token.includes('/')) {
    return true
  }
  return /^\*\.[^\s/]+$/.test(token)
}

/**
 * Parse `condition` + `scope` from rule frontmatter.
 *
 * - `condition` accepts string or string[]
 * - `scope` accepts string or string[]
 * - `astCondition` is kept verbatim (parsed, not yet matched)
 * - condition tokens that look like file globs become scope shorthands:
 *   `*.ts` => `tool:edit(*.ts)`, `tool:write(*.ts)` and a catch-all condition `.*`
 */
export function parseRuleConditionAndScope(
  frontmatter: RuleFrontmatter,
): Pick<Rule, 'condition' | 'astCondition' | 'scope'> {
  const rawCondition = frontmatter.condition
  const parsedCondition = normalizeRuleField(rawCondition)
  const astCondition = normalizeRuleField(frontmatter.astCondition)
  const parsedScope = normalizeScopeField(frontmatter.scope)

  const inferredScope: string[] = []
  const condition: string[] = []
  for (const token of parsedCondition ?? []) {
    if (isLikelyFileGlob(token)) {
      for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
        inferredScope.push(`tool:${toolName}(${token})`)
      }
      continue
    }
    condition.push(token)
  }

  if (condition.length === 0 && inferredScope.length > 0) {
    condition.push('.*')
  }

  const scope = [...(parsedScope ?? []), ...inferredScope]
  const result: Pick<Rule, 'condition' | 'astCondition' | 'scope'> = {}
  if (condition.length > 0) result.condition = Array.from(new Set(condition))
  if (astCondition !== undefined) result.astCondition = astCondition
  if (scope.length > 0) result.scope = Array.from(new Set(scope))
  return result
}

// ---------------------------------------------------------------------------
// Agent scoping (ported from omp's rule capability)
// ---------------------------------------------------------------------------

/**
 * Parse the `agents` frontmatter field into lowercased agent-name glob
 * patterns. Reuses the scope tokenizer, so comma-separated spellings split the
 * same way and `{a,b}` groups survive (whitespace around the comma is
 * normalized for the glob compiler).
 * @param value - raw frontmatter value (`string` or `string[]`).
 * @returns deduplicated lowercased patterns, or `undefined` when absent/empty.
 */
export function parseRuleAgents(value: unknown): string[] | undefined {
  const tokens = normalizeScopeField(value)
  if (!tokens) {
    return undefined
  }
  return Array.from(new Set(tokens.map(token => token.replace(/\s*,\s*/g, ',').toLowerCase())))
}

/** Agent name used for the top-level (non-subagent) session when evaluating `agents`. */
export const MAIN_AGENT_RULE_NAME = 'main'

/** Fallback agent name used for a subagent session with no recorded agent definition. */
export const SUB_AGENT_RULE_NAME = 'sub'

/**
 * Whether a rule's `agents` scope admits `agentName`. A rule without `agents`
 * applies to every agent; an unresolved `agentName` (`undefined`) disables
 * scoping entirely, so a session whose agent cannot be determined never drops
 * rules (upstream-compatible).
 * @param rule - the rule (or a rule-shaped value) whose `agents` patterns are checked.
 * @param agentName - the candidate agent definition name, or `undefined` when unknown.
 * @returns true when the rule applies to that agent.
 */
export function ruleAppliesToAgent(rule: Pick<Rule, 'agents'>, agentName: string | undefined): boolean {
  const patterns = rule.agents
  if (!patterns || patterns.length === 0 || agentName === undefined) {
    return true
  }
  const name = agentName.trim().toLowerCase()
  return patterns.some((pattern) => {
    if (pattern === name) {
      return true
    }
    return compileGlob(pattern).match(name)
  })
}

// ---------------------------------------------------------------------------
// Frontmatter + rule file loading
// ---------------------------------------------------------------------------

/** Parsed YAML frontmatter of a rule document. */
export interface RuleFrontmatter {
  name?: string
  description?: string
  globs?: string[]
  alwaysApply?: boolean
  condition?: string | string[]
  astCondition?: string | string[]
  scope?: string | string[]
  /** Agent-name globs this rule applies to; absent = every agent. */
  agents?: string | string[]
  interruptMode?: RuleInterruptMode
}

const VALID_INTERRUPT_MODES = new Set<RuleInterruptMode>(['never', 'prose-only', 'tool-only', 'always'])

/**
 * Split a Markdown document into its frontmatter block and body. Returns
 * `undefined` when the document does not open with a `---` delimiter.
 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | undefined {
  // A leading BOM or blank line before the opener is tolerated.
  const opener = /^(?:\uFEFF?\s*\n)*---\s*\n/.exec(raw)
  if (!opener) return undefined
  const rest = raw.slice(opener[0].length)
  const closerIndex = rest.search(/\n---\s*\n/)
  if (closerIndex === -1) return undefined
  const frontmatter = rest.slice(0, closerIndex)
  const body = rest.slice(closerIndex + 5) // past "\n---\n"
  return { frontmatter, body }
}

/** True when a runtime value is a plausible rule interrupt mode. */
function isRuleInterruptMode(value: unknown): value is RuleInterruptMode {
  return typeof value === 'string' && VALID_INTERRUPT_MODES.has(value as RuleInterruptMode)
}

/**
 * Parse one rule document (name is derived from the file stem unless the
 * frontmatter overrides it).
 * @param filePath - absolute or cwd-relative rule file path (used for `name`, `path`, display).
 * @param raw - the full file text.
 * @param absDir - absolute directory the file lives in, for computing `path`.
 * @returns the parsed rule, or `undefined` when the document has no frontmatter / fails to parse.
 */
export function parseRuleFile(filePath: string, raw: string, absDir: string): Rule | undefined {
  const split = splitFrontmatter(raw)
  // A stream rule must declare its intent: documents without a frontmatter
  // block (no `condition`/`name`) can never trigger and are not picked up.
  if (!split) return undefined
  const parsed = parse(split.frontmatter) as Record<string, unknown> | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  const basedOnFilename = path.basename(filePath, path.extname(filePath))
  const nameCandidate = typeof parsed['name'] === 'string' && parsed['name'].trim().length > 0
    ? parsed['name'].trim()
    : basedOnFilename
  const content = split.body.trim()
  if (nameCandidate.length === 0 || content.length === 0) {
    return undefined
  }

  const interruptMode: RuleInterruptMode | undefined = isRuleInterruptMode(parsed['interruptMode'])
    ? parsed['interruptMode']
    : undefined
  const conditionScope = parseRuleConditionAndScope(parsed)
  const globs = normalizeRuleField(parsed['globs'])
  const agents = parseRuleAgents(parsed['agents'])
  const alwaysApply = typeof parsed['alwaysApply'] === 'boolean' ? parsed['alwaysApply'] : undefined
  const description = typeof parsed['description'] === 'string' && parsed['description'].length > 0
    ? parsed['description']
    : undefined

  return {
    name: nameCandidate,
    path: path.isAbsolute(filePath) ? path.normalize(filePath) : path.join(absDir, filePath),
    content,
    ...(globs === undefined ? {} : { globs }),
    ...(alwaysApply === undefined ? {} : { alwaysApply }),
    ...(description === undefined ? {} : { description }),
    ...(agents === undefined ? {} : { agents }),
    ...(conditionScope.condition === undefined ? {} : { condition: conditionScope.condition }),
    ...(conditionScope.astCondition === undefined ? {} : { astCondition: conditionScope.astCondition }),
    ...(conditionScope.scope === undefined ? {} : { scope: conditionScope.scope }),
    ...(interruptMode === undefined ? {} : { interruptMode }),
  }
}

/** Walk a directory recursively and return the absolute paths of every `.md` file. */
export function listRuleFiles(dir: string): string[] {
  const results: string[] = []
  const walk = (current: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      // A missing or unreadable rules directory is not an error: zero rules.
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

/** Load and parse every rule file under `dir` (missing dir ⇒ empty list). */
export async function loadRulesFromDir(dir: string): Promise<Rule[]> {
  const files = listRuleFiles(dir)
  const rules: Rule[] = []
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const rule = parseRuleFile(file, raw, dir)
      if (rule) rules.push(rule)
    } catch (error) {
      // A corrupt rule file must not take down the session; log it and skip.
      throw new Error(`stream-rules: failed to read rule file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rules
}
