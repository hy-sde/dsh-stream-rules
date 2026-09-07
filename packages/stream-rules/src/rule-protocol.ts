/**
 * The `rule://` internal-URL handler: exposes the calling session's active
 * stream rules to the read/grep tools through the shared `ctx.internalUrls`
 * registry. Ported from oh-my-pi (`coding-agent/src/internal-urls/rule-protocol.ts`),
 * MIT; omp resolves against a process-global rule snapshot, while this port
 * resolves against the CALLING SESSION's live rule set (subagent rules
 * included) via {@link StreamRulesRegistry}.
 *
 * URL forms:
 * - `rule://<name>` — one active rule's full content (frontmatter stripped).
 *
 * Readable without an interrupt firing: the guard loads a session's rules at
 * turn start, so an agent that needs the full text of a rule it only saw
 * referenced by name can read it any time. Resolved rules are immutable.
 * @module @deepseek-ai/dsh-stream-rules/rule-protocol
 */

import type {
  InternalResource,
  ParsedInternalUrl,
  ProtocolHandler,
  ResolveContext,
  UrlCompletion,
} from '@hy-sde-org/dsh-internal-urls'
import type { Rule } from './rules.ts'

/** What the handler needs from the stream-rules plugin: the caller's rule set. */
export interface RuleProtocolDeps {
  /** Active rules of the calling session (empty when unknown or unloaded). */
  rulesFor(sessionKey: string | undefined): Rule[]
}

/** Corrective hint rendered under an unknown rule name. */
function unknownRuleError(ruleName: string, rules: readonly Rule[]): Error {
  const names = rules.map(rule => rule.name)
  const hint = names.length > 0
    ? `Available in this session: ${names.join(', ')}`
    : 'No rules are active for this session yet (rules load from <cwd>/.dsh/rules at turn start).'
  return new Error(`Unknown rule: ${ruleName}\n${hint}`)
}

/** The `rule://` protocol handler, bound to one session→rules accessor. */
export class RuleProtocolHandler implements ProtocolHandler {
  readonly scheme = 'rule'
  readonly immutable = true

  constructor(private readonly deps: RuleProtocolDeps) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps unknown-rule errors a rejection, not a synchronous throw
  async resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const ruleName = url.rawHost
    if (ruleName.length === 0) {
      throw new Error('rule:// URL requires a rule name: rule://<name>')
    }
    if (url.pathSegments.length > 0) {
      throw new Error(`Invalid rule:// URL: rule://${ruleName} takes no path.`)
    }
    const rules = this.deps.rulesFor(context?.sessionKey)
    const rule = rules.find(candidate => candidate.name === ruleName)
    if (rule === undefined) throw unknownRuleError(ruleName, rules)
    return {
      url: url.href,
      content: rule.content,
      contentType: 'text/markdown',
      immutable: true,
      size: Buffer.byteLength(rule.content, 'utf-8'),
      sourcePath: rule.path,
      notes: [`Active stream rule "${ruleName}".`, 'The guard enforces this rule reactively while you work.'],
    }
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the completion surface uniform with sibling handlers
  async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
    return this.deps.rulesFor(context?.sessionKey).map(rule => ({
      value: rule.name,
      ...rule.description !== undefined ? { description: rule.description } : {},
    }))
  }
}
