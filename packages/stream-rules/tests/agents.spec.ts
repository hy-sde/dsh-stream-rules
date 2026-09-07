/**
 * Unit tests for per-agent rule scoping (`agents:` frontmatter): normalization,
 * `ruleAppliesToAgent` matching, the session agent-name resolver, the
 * registration filter, and frontmatter parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveAgentName, selectRulesForAgent } from '../src/index.ts'
import {
  MAIN_AGENT_RULE_NAME,
  parseRuleAgents,
  parseRuleFile,
  ruleAppliesToAgent,
  SUB_AGENT_RULE_NAME,
  type Rule,
} from '../src/rules.ts'

describe('parseRuleAgents', () => {
  it('lowercases a YAML sequence', () => {
    expect(parseRuleAgents(['X', 'y'])).toEqual(['x', 'y'])
  })

  it('lowercases a single string value', () => {
    expect(parseRuleAgents('main')).toEqual(['main'])
  })

  it('splits a comma-separated string the same way as scope', () => {
    expect(parseRuleAgents('scout, foreman-*')).toEqual(['scout', 'foreman-*'])
  })

  it('keeps a brace group whole and normalizes whitespace inside it', () => {
    expect(parseRuleAgents('{A, B}')).toEqual(['{a,b}'])
  })

  it('normalizes an empty list to undefined', () => {
    expect(parseRuleAgents([])).toBeUndefined()
    expect(parseRuleAgents(undefined)).toBeUndefined()
  })

  it('deduplicates after lowercasing', () => {
    expect(parseRuleAgents(['Scout', 'scout'])).toEqual(['scout'])
  })
})

describe('ruleAppliesToAgent', () => {
  it('matches an exact agent name', () => {
    expect(ruleAppliesToAgent({ agents: ['scout'] }, 'scout')).toBe(true)
    expect(ruleAppliesToAgent({ agents: ['scout'] }, 'main')).toBe(false)
  })

  it('matches a glob pattern against the agent name', () => {
    expect(ruleAppliesToAgent({ agents: ['foreman-*'] }, 'foreman-alpha')).toBe(true)
    // `standard*` matches `standard` and `standard-worker`, but not `standardx-something`? `*` matches any run, so it does.
    expect(ruleAppliesToAgent({ agents: ['standard*'] }, 'standard')).toBe(true)
    expect(ruleAppliesToAgent({ agents: ['standard*'] }, 'standard-worker')).toBe(true)
    expect(ruleAppliesToAgent({ agents: ['standard*'] }, 'minimal')).toBe(false)
  })

  it('is case-insensitive through the normalized parsed patterns and the lowercased name', () => {
    expect(ruleAppliesToAgent({ agents: ['standard'] }, 'Standard')).toBe(true)
    expect(ruleAppliesToAgent({ agents: ['standard*'] }, 'STANDARD-WORKER')).toBe(true)
  })

  it('applies to every agent when agents is absent or empty', () => {
    expect(ruleAppliesToAgent({}, 'any-agent')).toBe(true)
    expect(ruleAppliesToAgent({ agents: [] }, 'any-agent')).toBe(true)
  })

  it('applies to every agent when the agent name is undefined', () => {
    expect(ruleAppliesToAgent({ agents: ['scout'] }, undefined)).toBe(true)
  })
})

describe('resolveAgentName', () => {
  it('resolves a top-level session to main even when it runs a preset', () => {
    expect(resolveAgentName({})).toBe(MAIN_AGENT_RULE_NAME)
    expect(resolveAgentName({ agentPreset: 'standard' })).toBe(MAIN_AGENT_RULE_NAME)
  })

  it('resolves a subagent to its recorded preset id, lowercased', () => {
    expect(resolveAgentName({ origin: 'subagent', agentPreset: 'Code-Edit' })).toBe('code-edit')
    expect(resolveAgentName({ origin: 'subagent', agentPreset: 'standard' })).toBe('standard')
  })

  it('falls back to sub for a subagent with no recorded preset', () => {
    expect(resolveAgentName({ origin: 'subagent' })).toBe(SUB_AGENT_RULE_NAME)
    expect(resolveAgentName({ origin: 'subagent', agentPreset: '  ' })).toBe(SUB_AGENT_RULE_NAME)
  })

  it('treats a positive delegation depth as a subagent', () => {
    expect(resolveAgentName({ delegationDepth: 2, agentPreset: 'minimal' })).toBe('minimal')
    expect(resolveAgentName({ delegationDepth: 1 })).toBe(SUB_AGENT_RULE_NAME)
  })
})

describe('selectRulesForAgent', () => {
  const rules: Rule[] = [
    { name: 'everyone', content: '', path: '/p/1.md' },
    { name: 'main-only', content: '', path: '/p/2.md', agents: ['main'] },
    { name: 'scout-only', content: '', path: '/p/3.md', agents: ['scout'] },
  ]

  it('drops rules whose agents do not admit the agent name', () => {
    expect(selectRulesForAgent(rules, 'scout').map(rule => rule.name)).toEqual(['everyone', 'scout-only'])
    expect(selectRulesForAgent(rules, 'main').map(rule => rule.name)).toEqual(['everyone', 'main-only'])
  })

  it('keeps every rule when the agent name is unresolved', () => {
    expect(selectRulesForAgent(rules, undefined).map(rule => rule.name)).toEqual([
      'everyone',
      'main-only',
      'scout-only',
    ])
  })

  it('keeps every rule when no rule declares agents', () => {
    expect(selectRulesForAgent(rules.slice(0, 1), 'scout')).toHaveLength(1)
  })
})

describe('agents frontmatter parsing', () => {
  const created: string[] = []

  beforeEach(() => { created.push(mkdtempSync(path.join(tmpdir(), 'stream-rules-agents-'))) })

  afterEach(() => {
    for (const entry of created) rmSync(entry, { recursive: true, force: true })
    created.length = 0
  })

  it('parses a frontmatter sequence into lowercased agents', () => {
    const dir = created.at(-1)!
    const file = path.join(dir, 'scoped.md')
    const content = ['---', 'condition: forbidden', 'agents: ["X", "y"]', '---', 'Scoped rule.'].join('\n')
    writeFileSync(file, content)
    const rule = parseRuleFile(file, content, dir)
    expect(rule?.agents).toEqual(['x', 'y'])
  })

  it('parses a scalar agents value into a single-element list', () => {
    const dir = created.at(-1)!
    const file = path.join(dir, 'main-only.md')
    const content = ['---', 'condition: forbidden', 'agents: main', '---', 'Main only.'].join('\n')
    writeFileSync(file, content)
    const rule = parseRuleFile(file, content, dir)
    expect(rule?.agents).toEqual(['main'])
  })

  it('leaves agents undefined when the key is absent', () => {
    const dir = created.at(-1)!
    const file = path.join(dir, 'plain.md')
    const content = ['---', 'condition: forbidden', '---', 'Body.'].join('\n')
    writeFileSync(file, content)
    const rule = parseRuleFile(file, content, dir)
    expect(rule?.agents).toBeUndefined()
  })
})
