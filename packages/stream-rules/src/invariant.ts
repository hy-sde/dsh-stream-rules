/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-stream-rules`.
 * @module @deepseek-ai/dsh-stream-rules/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-stream-rules'

/** Cordis companion plugin name. */
export const name = 'stream-rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant yet: the stream-watch state is private to one plugin
 * instance and exposes no package-owned event or snapshot that an independent
 * companion can observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
