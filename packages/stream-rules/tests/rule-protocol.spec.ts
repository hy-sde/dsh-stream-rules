/**
 * The `rule://` protocol: handler units against a stub rule set, the
 * Session→rules registry, and an integration proving the stream-rules plugin
 * publishes per-session rules and registers the scheme exactly once into the
 * shared internal-URL registry.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as InternalUrls from '@hy-sde-org/dsh-internal-urls'
import { InternalUrlsService } from '@hy-sde-org/dsh-internal-urls'
import type { ParsedInternalUrl } from '@hy-sde-org/dsh-internal-urls'
import * as StreamRules from '../src/index.ts'
import { RuleProtocolHandler } from '../src/rule-protocol.ts'
import { StreamRulesRegistry } from '../src/registry.ts'
import type { Rule } from '../src/rules.ts'

function parsed(input: string): ParsedInternalUrl {
  return InternalUrls.parseInternalUrl(input)
}

const rules: Rule[] = [
  {
    name: 'no-secrets',
    path: '/ws/.dsh/rules/no-secrets.md',
    content: 'Never log secrets in code.',
    description: 'Secret hygiene',
    condition: ['secret'],
  },
  {
    name: 'commit-style',
    path: '/ws/.dsh/rules/commit-style.md',
    content: 'Use conventional commits.',
  },
]

describe('RuleProtocolHandler', () => {
  const handler = new RuleProtocolHandler({ rulesFor: sessionKey => sessionKey === 'sess-1' ? rules : [] })

  it('resolves rule://<name> to the rule content with sourcePath', async () => {
    const resource = await handler.resolve(parsed('rule://no-secrets'), { cwd: '/ws', sessionKey: 'sess-1' })
    expect(resource.content).toBe('Never log secrets in code.')
    expect(resource.sourcePath).toBe('/ws/.dsh/rules/no-secrets.md')
    expect(resource.contentType).toBe('text/markdown')
    expect(resource.immutable).toBe(true)
  })

  it('rejects a missing name and paths', async () => {
    await expect(handler.resolve(parsed('rule://'), { sessionKey: 'sess-1' })).rejects.toThrow(/requires a rule name/)
  })

  it("rejects unknown rules listing the session's available names", async () => {
    await expect(handler.resolve(parsed('rule://nope'), { sessionKey: 'sess-1' }))
      .rejects.toThrow(/Unknown rule: nope/)
    await expect(handler.resolve(parsed('rule://nope'), { sessionKey: 'sess-1' }))
      .rejects.toThrow(/no-secrets, commit-style/)
  })

  it('explains when the session has no active rules', async () => {
    await expect(handler.resolve(parsed('rule://nope'), { sessionKey: 'other' }))
      .rejects.toThrow(/No rules are active for this session yet/)
  })

  it('completes the session rule names', async () => {
    const completions = await handler.complete('no', { cwd: '/ws', sessionKey: 'sess-1' })
    expect(completions.map(candidate => candidate.value)).toEqual(['no-secrets', 'commit-style'])
    expect(completions[0]?.description).toBe('Secret hygiene')
  })
})

describe('StreamRulesRegistry', () => {
  it('publish/unpublish scopes rules by session key', () => {
    const registry = new StreamRulesRegistry()
    expect(registry.rulesFor('sess-1')).toEqual([])
    registry.publish('sess-1', () => rules)
    expect(registry.rulesFor('sess-1')).toHaveLength(2)
    expect(registry.rulesFor('sess-2')).toEqual([])
    expect(registry.rulesFor(undefined)).toEqual([])
    expect(registry.unpublish('sess-1')).toBe(true)
    expect(registry.unpublish('sess-1')).toBe(false)
    expect(registry.rulesFor('sess-1')).toEqual([])
  })

  it('evaluates the accessor live (a reload is visible immediately)', () => {
    const registry = new StreamRulesRegistry()
    let current: Rule[] = []
    registry.publish('sess-1', () => current)
    expect(registry.rulesFor('sess-1')).toEqual([])
    current = rules
    expect(registry.rulesFor('sess-1')).toHaveLength(2)
  })
})

describe('rule:// through ctx.internalUrls (package integration)', () => {
  it('registers the scheme and resolves an inline rule for an emitted session', async () => {
    const ctx = new Context()
    // Registry service directly: the full internal-urls plugin also needs
    // ctx.fs for its conflict bridge, which this spec does not mount.
    new InternalUrlsService(ctx)
    await ctx.plugin(StreamRules, {
      enabled: true,
      rules: [
        { name: 'test-rule', content: 'never log secrets', condition: 'secret' },
        { name: 'second-rule', content: 'always commit', condition: 'commit' },
      ],
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(ctx.internalUrls.schemes()).toContain('rule')

    // Simulate the agent lifecycle: the plugin publishes rules per session on
    // `agent/created` (header id == ResolveContext.sessionKey).
    ctx.emit('agent/created', {
      agent: { session: { header: { id: 'sess-rule-test', cwd: '/ws' } } },
    } as never)
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    const resource = await ctx.internalUrls.resolve('rule://test-rule', { cwd: '/ws', sessionKey: 'sess-rule-test' })
    expect(resource.content).toBe('never log secrets')
    expect(resource.sourcePath).toBe('config:test-rule')

    const other = await ctx.internalUrls.resolve('rule://second-rule', { cwd: '/ws', sessionKey: 'sess-rule-test' })
    expect(other.content).toBe('always commit')

    await expect(ctx.internalUrls.resolve('rule://unknown', { cwd: '/ws', sessionKey: 'sess-rule-test' }))
      .rejects.toThrow(/Available in this session: test-rule, second-rule/)

    const completions = await ctx.internalUrls.complete('rule', '', { cwd: '/ws', sessionKey: 'sess-rule-test' })
    expect(completions?.map(candidate => candidate.value).sort()).toEqual(['second-rule', 'test-rule'])
  })

  it('an unknown session key sees no rules (no cross-session leakage)', async () => {
    const ctx = new Context()
    new InternalUrlsService(ctx)
    await ctx.plugin(StreamRules, {
      enabled: true,
      rules: [{ name: 'test-rule', content: 'never log secrets', condition: 'secret' }],
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    ctx.emit('agent/created', {
      agent: { session: { header: { id: 'sess-a', cwd: '/ws' } } },
    } as never)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    await expect(ctx.internalUrls.resolve('rule://test-rule', { cwd: '/ws', sessionKey: 'sess-b' }))
      .rejects.toThrow(/No rules are active/)
  })

  it('unregisters the scheme on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    new InternalUrlsService(ctx)
    const fiber = await ctx.plugin(StreamRules, {
      enabled: true,
      rules: [{ name: 'test-rule', content: 'never log secrets', condition: 'secret' }],
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(ctx.internalUrls.schemes()).toContain('rule')
    await fiber.dispose()
    expect(ctx.internalUrls.schemes()).not.toContain('rule')
  })
})
