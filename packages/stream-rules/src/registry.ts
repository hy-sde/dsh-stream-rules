/**
 * Session→rules accessor for the `rule://` protocol. Stream rules are
 * per-session (one {@link TtsrManager} per agent), but the internal-URL
 * registry is host-plane and must answer for ANY session — including subagents
 * — using only the opaque `ResolveContext.sessionKey` the read/grep tools
 * thread (the session header id). The stream-rules plugin publishes one live
 * getter per session; the handler looks rules up by key.
 * @module @deepseek-ai/dsh-stream-rules/registry
 */

import type { Rule } from './rules.ts'

/**
 * One session key → live rule getter. Keys are session header ids (exactly the
 * key the read/grep tools pass as `ResolveContext.sessionKey`); the getter is
 * evaluated at resolution time so a rules-dir reload is visible immediately.
 */
export class StreamRulesRegistry {
  private readonly accessors = new Map<string, () => Rule[]>()

  /** Publish (or replace) the live rule getter for one session key. */
  publish(sessionKey: string, accessor: () => Rule[]): void {
    this.accessors.set(sessionKey, accessor)
  }

  /** Remove the entry for one session key; returns true when it existed. */
  unpublish(sessionKey: string): boolean {
    return this.accessors.delete(sessionKey)
  }

  /** The session's currently active rules, or `[]` when the session is unknown. */
  rulesFor(sessionKey: string | undefined): Rule[] {
    if (sessionKey === undefined) return []
    return this.accessors.get(sessionKey)?.() ?? []
  }
}
