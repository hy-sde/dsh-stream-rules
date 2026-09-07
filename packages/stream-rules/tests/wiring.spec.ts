/**
 * End-to-end wiring tests for the stream-rules guard through a real agent
 * loop against a scripted mock adapter (no network):
 * mid-stream abort → reminder injection → retry from the same point,
 * non-interrupting tool-argument reminders, repeat gating, and discard mode.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { InternalUrlsService } from '@hy-sde-org/dsh-internal-urls'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as StreamRules from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** Standalone twin of the harness's agent-loop testkit: mount the published service plugins in spine order. */
async function mountAgentLoopTestDependencies(ctx: Context): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjections)
}

/** Temp dirs created by `harness`, removed after each test. */
const createdDirs: string[] = []

afterEach(() => {
  for (const entry of createdDirs.splice(0)) rmSync(entry, { recursive: true, force: true })
})

/** Script entry that streams the given prefix chunks, then hangs until aborted. */
function hangAfter(prefix: StreamChunk[]): { hangAfter: StreamChunk[] } {
  return { hangAfter: prefix }
}

/** The text-streaming prefix of `textResponse`, without usage/finish so the stream stays open. */
function streamingText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
}

/**
 * Wait until the agent has produced at least `expected` model requests and is
 * quiescent again. The guard reschedules the retry with a `setTimeout(0)` that
 * can fire right after the abort-converged `idle`, so a single `waitForIdle`
 * may observe the intermediate idle before the retry turn starts — and a
 * naive "wait for the next idle" can miss it entirely when the retry turn
 * completes before the listener attaches. The idle check at attach time plus
 * a bounded poll closes that gap.
 */
async function settle(ctx: Context, agent: Agent, adapter: MockAdapter, expected: number): Promise<void> {
  for (let guard = 0; guard < 80 && adapter.requests.length < expected; guard++) {
    await new Promise<void>((resolve) => {
      if (agent.status === 'idle') {
        resolve()
        return
      }
      const d = ctx.on('agent/status', ({ agent: a, status }) => {
        if (a === agent && status === 'idle') {
          d()
          resolve()
        }
      })
    })
    if (adapter.requests.length < expected) await new Promise(resolve => setTimeout(resolve, 40))
  }
}

/** All plugin-sourced user messages (the reminders this guard injects), flattened to text. */
function plugins(agent: Agent): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map(e => e.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('|'))
}

/** All turn-end events, as `{ kind, reason?.reason }` summaries. */
function turnEnds(agent: Agent): unknown[] {
  return [...agent.session.snapshotEvents()]
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map((e: SessionEvent<'turn/end'>) => e.data.reason)
}

/**
 * Boot the core spine + the guard with inline rules and an empty file-rules
 * dir. With `useInternalUrls` the shared internal-URL registry is mounted
 * before the guard, so the `rule://` scheme registers and can be resolved
 * against the live agent loop.
 */
async function harness(config: Config = {}, useInternalUrls = false): Promise<{ ctx: Context; rulesDir: string }> {
  const ctx = new Context()
  const rulesDir = mkdtempSync(path.join(tmpdir(), 'stream-rules-wiring-'))
  createdDirs.push(rulesDir)
  await mountAgentLoopTestDependencies(ctx)
  if (useInternalUrls) new InternalUrlsService(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(StreamRules, Object.assign({ rulesDir }, config))
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return { ctx, rulesDir }
}

const forbiddenRule: Config['rules'] = [{
  name: 'no-forbidden-words',
  content: 'Never use the word "forbidden" in any output.',
  condition: ['forbidden'],
  scope: ['text'],
}]

const secretRule: Config['rules'] = [{
  name: 'no-secret-in-args',
  content: 'Never pass a secret value to a tool call.',
  condition: ['SECRET'],
  scope: ['tool'],
  interruptMode: 'never',
}]

describe('stream-rules guard: interrupt + retry', () => {
  it('aborts mid-stream, injects the rule as a reminder, and regenerates from the same point', async () => {
    const { ctx } = await harness({ rules: forbiddenRule })
    const adapter = new MockAdapter([
      hangAfter(streamingText('let me mention forbidden stuff')),
      textResponse('clean answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    // The first stream was aborted mid-way by the guard.
    const ends = turnEnds(agent)
    expect(ends.filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)

    // One interrupted assistant message (the partial) exists in the log.
    const interrupted = [...agent.session.snapshotEvents()]
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message' && e.data.interrupted === true)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]!.data.message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')).toContain('forbidden')

    // Exactly one plugin reminder was injected and reached the retry request.
    const injected = plugins(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('Never use the word')

    // Two model calls: the aborted one and the retry from the same context.
    expect(adapter.requests).toHaveLength(2)
    const retryMessages = adapter.requests[1]!.messages
    const retryText = retryMessages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
    expect(retryText).toContain('Never use the word')
    expect(retryText).toContain('Write a note')

    // The turn regenerated to completion on the retry.
    const assistants = [...agent.session.snapshotEvents()]
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message' && e.data.interrupted !== true)
    expect(assistants.at(-1)!.data.message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')).toBe('clean answer')

  })

  it('does not re-abort after the rule already fired once in the session (repeatMode once)', async () => {
    const { ctx } = await harness({ rules: forbiddenRule })
    const adapter = new MockAdapter([
      hangAfter(streamingText('forbidden again')),
      textResponse('still forbidden words here'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write sentences' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    // Only the first turn aborted: the retry streamed a second violation and
    // completed normally, because the rule had already fired this session.
    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)
    expect(plugins(agent)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
    const assistants = [...agent.session.snapshotEvents()]
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message' && e.data.interrupted !== true)
    expect(assistants.at(-1)!.data.message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')).toBe('still forbidden words here')
  })

  it('#pendingAbort suppresses double aborts from multi-condition matches', async () => {
    const { ctx } = await harness({
      rules: [
        { name: 'r1', content: 'rule one', condition: ['forbidden'], scope: ['text'] },
        { name: 'r2', content: 'rule two', condition: ['forbidden'], scope: ['text'] },
      ],
    })
    const adapter = new MockAdapter([
      hangAfter(streamingText('a forbidden word')),
      textResponse('ok'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    const injected = plugins(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('rule one')
    expect(injected[0]).toContain('rule two')
    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)
  })
})

describe('stream-rules guard: non-interrupting tool rules', () => {
  it('folds a never-interrupting tool match into the tool result instead of aborting', async () => {
    const { ctx } = await harness({ rules: secretRule })
    const adapter = new MockAdapter([
      toolCallResponse('c0', 'probe', { q: 'SECRET' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'call the probe' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    // No stream was aborted — the rule delivered advisory context.
    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(0)

    // The reminder reached the model's next request as a plugin-source message.
    const injected = plugins(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('Never pass a secret value')
    const lastRequest = adapter.requests.at(-1)!
    const text = lastRequest.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
    expect(text).toContain('Never pass a secret value')

    // And the probe still executed normally (result flowed back).
    const results = [...agent.session.snapshotEvents()].filter(e => e.type === 'tool/result')
    expect(results).toHaveLength(1)
  })
})

describe('stream-rules guard: discard mode', () => {
  it('replaces the aborted step with the reminder so the retry starts from a clean context', async () => {
    const { ctx } = await harness({ rules: forbiddenRule, contextMode: 'discard' })
    const adapter = new MockAdapter([
      hangAfter(streamingText('forbidden proposal')),
      textResponse('clean answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    // The retry request carries the original prompt + the reminder, and NONE
    // of the aborted partial output (it was shadowed off the surface).
    expect(adapter.requests).toHaveLength(2)
    const retry = adapter.requests[1]!
    const text = retry.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
    expect(text).toContain('Write a note')
    expect(text).toContain('Never use the word')
    expect(text).not.toContain('forbidden proposal')
    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)
  })
})

describe('stream-rules guard: agent scoping', () => {
  it('does not register an inline rule scoped to another agent', async () => {
    const { ctx } = await harness({
      rules: [{ ...forbiddenRule[0]!, agents: ['code'] }],
    })
    const adapter = new MockAdapter([textResponse('forbidden words are fine in this session')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 1)

    // The top-level session resolves to `main`, so the `code`-scoped rule was
    // never registered: the matching stream completed without any interruption.
    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(0)
    expect(plugins(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('registers an inline rule scoped to the top-level agent (main)', async () => {
    const { ctx } = await harness({
      rules: [{ ...forbiddenRule[0]!, agents: ['main'] }],
    })
    const adapter = new MockAdapter([
      hangAfter(streamingText('forbidden sentence')),
      textResponse('clean answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)
    const injected = plugins(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('Never use the word')
  })

  it('registers a file rule scoped to the top-level agent (main)', async () => {
    const { ctx, rulesDir } = await harness()
    writeFileSync(path.join(rulesDir, 'main-only.md'), [
      '---',
      'condition: forbidden',
      'scope: ["text"]',
      'agents: main',
      '---',
      'File rule scoped to main.',
    ].join('\n'))
    const adapter = new MockAdapter([
      hangAfter(streamingText('forbidden words')),
      textResponse('clean answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 2)

    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(1)
    const injected = plugins(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('File rule scoped to main')
  })

  it('does not register a file rule scoped to another agent', async () => {
    const { ctx, rulesDir } = await harness()
    writeFileSync(path.join(rulesDir, 'code-only.md'), [
      '---',
      'condition: forbidden',
      'scope: ["text"]',
      'agents: [code]',
      '---',
      'File rule scoped to code.',
    ].join('\n'))
    const adapter = new MockAdapter([textResponse('forbidden words pass through here')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write a note' }], source: { kind: 'user' } }))
    await settle(ctx, agent, adapter, 1)

    expect(turnEnds(agent).filter(r => (r as { kind: string }).kind === 'aborted')).toHaveLength(0)
    expect(plugins(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('stream-rules guard: rule:// registry over the agent loop', () => {
  it('resolves only the caller session\'s active rules, filtered by agent scoping', async () => {
    const { ctx, rulesDir } = await harness({
      rules: [
        { ...forbiddenRule[0]!, agents: ['main'] },
        { name: 'code-only-rule', content: 'Only for code agents.', condition: ['x'], scope: ['text'], agents: ['code'] },
      ],
    }, true)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // Let the agent/created publish + inline rule registration settle.
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const sessionKey = agent.session.header.id

    // The main-scoped rule is live through the shared registry...
    const resource = await ctx.internalUrls.resolve('rule://no-forbidden-words', { cwd: rulesDir, sessionKey })
    expect(resource.content).toBe('Never use the word "forbidden" in any output.')
    expect(resource.sourcePath).toBe('config:no-forbidden-words')
    expect(resource.immutable).toBe(true)

    // ...while the code-scoped rule was filtered out for this session.
    await expect(ctx.internalUrls.resolve('rule://code-only-rule', { cwd: rulesDir, sessionKey }))
      .rejects.toThrow(/Available in this session: no-forbidden-words/)

    // Completions advertise exactly the active rules.
    const completions = await ctx.internalUrls.complete('rule', '', { cwd: rulesDir, sessionKey })
    expect(completions?.map(candidate => candidate.value)).toEqual(['no-forbidden-words'])
  })
})
