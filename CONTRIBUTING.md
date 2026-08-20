# Contributing

Thanks for helping with `dsh-tool-debug`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-dap` beyond its
  declared peers (`@deepseek-ai/cordis`, `dsh-invariants`,
  `dsh-subprocess`), and no new `@deepseek-ai` dependencies for
  `@hy-sde-org/dsh-tool-debug` beyond its declared peers. Runtime Node
  builtins are fine (the host runs Node).
- **The DAP seam must stay standalone.** Never re-introduce a hard dependency
  on host-plane seam packages other than the declared peers — the whole point
  is that this plugin works on stock deliveries of DeepSeek Harness.
- **Degrade, don't throw.** Adapter resolution returns structured
  "unavailable" outcomes instead of throwing; keep that contract.
- Preserve the per-file upstream attribution headers
  (`Ported from oh-my-pi ... (MIT)`, see `THIRD-PARTY-NOTICES.md`).

## Workflow

1. Make your change in the appropriate `packages/*`.
2. `pnpm -r check` and `pnpm -r test` (dap: framing + session specs plus the
   skip-when-absent live debugpy round trip; tool-debug: 16 tests).
3. Add/extend a spec next to the behavior you changed. The session specs use
   a scripted fake DAP adapter so behavior can be tested without a real
   debugger; the live spec runs only when `debugpy` is importable.
4. `pnpm -r build`, then `bash scripts/release-public.sh --check`.
5. Open a PR against `main`.

## Releasing

Release authority lives with the maintainers. The flow is guarded by
`scripts/release-public.sh` (clean tree, checks, tests, build, pack, org
membership, absence check, interactive confirm). Publish order is pinned:
`@hy-sde-org/dsh-dap` first, then `@hy-sde-org/dsh-tool-debug`.
