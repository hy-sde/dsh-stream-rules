/**
 * Unit tests for the TtsrManager and the rule parsing/glob layer:
 * condition compile + inline flags, scope tokens, path globs, buffer
 * isolation, repeat gating, invalid-rule rejection, and frontmatter parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TtsrManager } from '../src/manager.ts'
import {
  compileGlob,
  compileRuleCondition,
  loadRulesFromDir,
  parseRuleConditionAndScope,
  parseRuleFile,
} from '../src/rules.ts'

/** A no-op logger so tests can assert nothing about logs. */
const silentLogger = {
  warn: () => {},
  debug: () => {},
}

function rule(overrides: Partial<Parameters<TtsrManager['addRule']>[0]> = {}): Parameters<TtsrManager['addRule']>[0] {
  return {
    name: 'rule-a',
    path: '/p/rule-a.md',
    content: 'Remember this rule.',
    condition: ['forbidden'],
    ...overrides,
  }
}

describe('TtsrManager matching', () => {
  it('matches a text condition against the accumulated text buffer', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule())
    expect(manager.checkDelta('hel', { source: 'text', streamKey: 'text' })).toEqual([])
    expect(manager.checkDelta('lo for', { source: 'text', streamKey: 'text' })).toEqual([])
    const matched = manager.checkDelta('bidden now', { source: 'text', streamKey: 'text' })
    expect(matched.map(r => r.name)).toEqual(['rule-a'])
  })

  it('isolates buffers per stream key so a text match never bleeds into tool args', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule({ condition: ['forbidden'] }))
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toHaveLength(1)
    // A separate tool stream whose own buffer does not contain the pattern
    // must NOT match, even though another stream matched moments ago.
    expect(manager.checkDelta('unrelated', { source: 'tool', streamKey: 'toolcall:1' })).toEqual([])
    // Repeated chunks accumulate per stream key: the second half completes the match.
    expect(manager.checkDelta('no', { source: 'tool', streamKey: 'toolcall:2' })).toEqual([])
    expect(manager.checkDelta(' forbidden here', { source: 'tool', streamKey: 'toolcall:2' })).toHaveLength(1)
  })

  it('respects a scope that allows only the edit tool', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule({ scope: ['tool:edit(*)'] }))
    expect(manager.checkDelta('forbidden', { source: 'tool', toolName: 'write', streamKey: 'toolcall:1' })).toEqual([])
    expect(manager.checkDelta('forbidden', { source: 'tool', toolName: 'edit', streamKey: 'toolcall:2' })).toEqual([])
  })

  it('matches a tool path glob only when the candidate file path matches', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule({ scope: ['tool:edit(*.ts)'] }))
    const tsContext = {
      source: 'tool' as const,
      toolName: 'edit',
      streamKey: 'toolcall:1',
      filePaths: ['/repo/src/main.ts', '/repo/README.md'],
    }
    // A `.ts` path under the edit tool is inside the scope -> matches.
    const tsMatch = manager.checkDelta('forbidden', tsContext)
    expect(tsMatch).toHaveLength(1)
    expect(tsMatch[0]!.name).toBe('rule-a')
    // A `.md`-only path is outside the scope -> no match.
    const mdContext = {
      source: 'tool' as const,
      toolName: 'edit',
      streamKey: 'toolcall:2',
      filePaths: ['/repo/README.md'],
    }
    expect(manager.checkDelta('forbidden', mdContext)).toEqual([])
    // A different tool on a matching path is also outside the scope -> no match.
    const writeContext = {
      source: 'tool' as const,
      toolName: 'write',
      streamKey: 'toolcall:3',
      filePaths: ['/repo/src/main.ts'],
    }
    expect(manager.checkDelta('forbidden', writeContext)).toEqual([])
  })

  it('applies the rule globs against candidate file paths', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule({ globs: ['**/*.test.ts'] }))
    const mainContext = {
      source: 'tool' as const,
      toolName: 'edit',
      streamKey: 'toolcall:1',
      filePaths: ['/repo/src/main.ts'],
    }
    expect(manager.checkDelta('forbidden', mainContext)).toEqual([])
    const testContext = {
      source: 'tool' as const,
      toolName: 'edit',
      streamKey: 'toolcall:2',
      filePaths: ['/repo/src/main.test.ts'],
    }
    const match = manager.checkDelta('forbidden', testContext)
    expect(match).toHaveLength(1)
    expect(match[0]!.name).toBe('rule-a')
  })

  it('rejects rules with no usable condition and skips ast-only rules with a warning', () => {
    const manager = new TtsrManager(undefined, {
      warn: (message: string) => { expect(message).toContain('astCondition') },
      debug: () => {},
    })
    expect(manager.addRule(rule({ condition: [], astCondition: ['console.log($A)'] }))).toBe(false)
    expect(manager.hasRules()).toBe(false)
    expect(manager.addRule(rule({ condition: [] }))).toBe(false)
  })

  it('allows a rule to match on the thinking stream only when scoped to thinking', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule({ scope: ['thinking'] }))
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toEqual([])
    const matched = manager.checkDelta('forbidden', { source: 'thinking', streamKey: 'thinking' })
    expect(matched.map(r => r.name)).toEqual(['rule-a'])
  })

  it('buffers content that streams before any rule exists and matches it via recheck (reload race)', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    // Content streams while the rule table is empty (a reload's file I/O window).
    expect(manager.checkDelta('let me mention forbidden stuff', { source: 'text', streamKey: 'text' })).toEqual([])
    // The rule table swap empties the live buffers; the plugin snapshots first.
    const prior = manager.snapshotBuffers()
    manager.clearRules()
    manager.addRule(rule())
    // Without the snapshot, no live buffer remains to match — with it, the
    // streamed text still triggers exactly like a normal in-stream match.
    expect(manager.recheckBuffers()).toEqual([])
    const hits = manager.recheckBuffers(prior)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.rule.name).toBe('rule-a')
    expect(hits[0]!.context).toEqual({ source: 'text', streamKey: 'text' })
  })
})

describe('TtsrManager repeat gating', () => {
  it('fires once with repeatMode once and stays dormant afterwards', () => {
    const manager = new TtsrManager({ repeatMode: 'once' }, silentLogger)
    manager.addRule(rule())
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toHaveLength(1)
    manager.markInjectedByNames(['rule-a'])
    manager.incrementMessageCount()
    manager.resetBuffer()
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toEqual([])
  })

  it('re-arms after the repeat gap with repeatMode gap', () => {
    const manager = new TtsrManager({ repeatMode: 'gap', repeatGap: 3 }, silentLogger)
    manager.addRule(rule())
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toHaveLength(1)
    manager.markInjectedByNames(['rule-a'])
    // Two turns later is still inside the gap.
    manager.incrementMessageCount()
    manager.incrementMessageCount()
    manager.resetBuffer()
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toEqual([])
    // Past the gap fires again.
    manager.incrementMessageCount()
    manager.resetBuffer()
    expect(manager.checkDelta('forbidden', { source: 'text', streamKey: 'text' })).toHaveLength(1)
  })

  it('keeps buffers clear across resetBuffer and message count monotonic', () => {
    const manager = new TtsrManager(undefined, silentLogger)
    manager.addRule(rule())
    manager.checkDelta('for', { source: 'text', streamKey: 'text' })
    manager.resetBuffer()
    expect(manager.checkDelta('bidden', { source: 'text', streamKey: 'text' })).toEqual([])
    manager.incrementMessageCount()
    expect(manager.getMessageCount()).toBe(1)
  })
})

describe('glob compiler', () => {
  it('matches basename, directory, and brace globs', () => {
    const basename = compileGlob('*.ts')
    expect(basename.match('main.ts')).toBe(true)
    expect(basename.match('src/main.ts')).toBe(false)

    const nested = compileGlob('**/*.test.ts')
    expect(nested.match('a.test.ts')).toBe(true)
    expect(nested.match('src/deep/a.test.ts')).toBe(true)
    expect(nested.match('src/deep/a.ts')).toBe(false)

    const braces = compileGlob('src/**/*.{ts,tsx}')
    expect(braces.match('src/a.tsx')).toBe(true)
    expect(braces.match('src/a/b/c.ts')).toBe(true)
    expect(braces.match('src/a.md')).toBe(false)

    const absolute = compileGlob('/repo/**/*.rs')
    expect(absolute.match('/repo/a/b.rs')).toBe(true)
    expect(absolute.match('/repo/a/b.c')).toBe(false)
  })

  it('treats a character class literally-escaped correctly', () => {
    const withClass = compileGlob('src/[ab]/x.js')
    expect(withClass.match('src/a/x.js')).toBe(true)
    expect(withClass.match('src/b/x.js')).toBe(true)
    expect(withClass.match('src/c/x.js')).toBe(false)
  })
})

describe('condition compilation', () => {
  it('translates a leading inline flag group into native flags', () => {
    expect(compileRuleCondition('(?i)todo').test('TODO')).toBe(true)
    expect(compileRuleCondition('(?i)todo').test('todo')).toBe(true)
    expect(compileRuleCondition('(?m)^line\\d').test('line1\nline2')).toBe(true)
    expect(compileRuleCondition('(?i)todo').test('TODX')).toBe(false)
  })

  it('keeps plain patterns intact', () => {
    expect(compileRuleCondition('forbidden').test('xforbiddeny')).toBe(true)
  })
})

describe('rule condition/scope parsing', () => {
  it('normalizes condition and scope fields and expands file-glob shorthands', () => {
    const parsed = parseRuleConditionAndScope({
      condition: ['console\\.log', '*.rs', '**/*.test.ts'],
      scope: 'text, tool:edit',
    })
    // Non-glob conditions stay; the two file-glob tokens widened the scope
    // instead of becoming conditions (they do not need a '.*' catch-all here
    // because a real pattern remains).
    expect(parsed.condition).toEqual(['console\\.log'])
    expect(parsed.scope).toEqual([
      'text',
      'tool:edit',
      'tool:edit(*.rs)',
      'tool:write(*.rs)',
      'tool:edit(**/*.test.ts)',
      'tool:write(**/*.test.ts)',
    ])
  })

  it('parses a scope array with parenthesized globs without splitting them', () => {
    const parsed = parseRuleConditionAndScope({
      scope: ['text', 'tool:edit(*.ts)'],
    })
    expect(parsed.scope).toEqual(['text', 'tool:edit(*.ts)'])
  })

  it('adds a .* catch-all condition when every condition token was a file glob', () => {
    const parsed = parseRuleConditionAndScope({
      condition: ['*.rs', '**/*.test.ts'],
    })
    expect(parsed.condition).toEqual(['.*'])
    expect(parsed.scope).toEqual([
      'tool:edit(*.rs)',
      'tool:write(*.rs)',
      'tool:edit(**/*.test.ts)',
      'tool:write(**/*.test.ts)',
    ])
  })
})

describe('rule file parsing + loading', () => {
  const created: string[] = []

  beforeEach(() => { created.push(mkdtempSync(path.join(tmpdir(), 'stream-rules-'))) })

  afterEach(() => {
    for (const entry of created) rmSync(entry, { recursive: true, force: true })
    created.length = 0
  })

  it('derives a name from the file stem and reads frontmatter + body', async () => {
    const dir = created.at(-1)!
    writeFileSync(path.join(dir, 'no-console.md'), [
      '---',
      'description: no console',
      'condition: console\\.log',
      'scope: ["text", "tool:edit(*.ts)"]',
      'interruptMode: prose-only',
      '---',
      'Never log to console.',
    ].join('\n'))
    const rules = await loadRulesFromDir(dir)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      name: 'no-console',
      content: 'Never log to console.',
      condition: ['console\\.log'],
      scope: ['text', 'tool:edit(*.ts)'],
      interruptMode: 'prose-only',
      description: 'no console',
    })
  })

  it('returns an empty list for a missing rules directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stream-rules-missing-'))
    try {
      expect(await loadRulesFromDir(path.join(dir, 'nope'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a document without frontmatter or an empty body', async () => {
    const dir = created.at(-1)!
    const plain = parseRuleFile(path.join(dir, 'plain.md'), 'just prose', dir)
    expect(plain).toBeUndefined()
    const empty = parseRuleFile(path.join(dir, 'empty.md'), '---\ncondition: x\n---\n   ', dir)
    expect(empty).toBeUndefined()
  })
})
