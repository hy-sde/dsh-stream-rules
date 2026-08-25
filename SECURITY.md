# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- The `debug` tool spawns external debugger adapter binaries (debugpy, gdb,
  lldb-dap, dlv, ...) as subprocesses — treat adapter resolution (`PATH`,
  `DSH_DEBUGPY_PYTHON`) as a trust boundary: only point it at debuggers you
  control and pin versions in constrained environments.
- A debugger can read and write the debuggee's process memory and execute
  target-side code through evaluate requests — the debuggee is the trust
  boundary. Launch agents only against code the deployment already trusts to
  run, and scope `debug` to per-session realms so adapters never outlive the
  session.
- The seam opens a reserved localhost TCP port only for adapters that need
  socket mode (e.g. `python -m debugpy.adapter --port N`). No remote
  listener is exposed; the port is bound to loopback and closed on session
  disposal.
- Malicious source content (e.g. a debuggee with hostile `__repr__` or
  `__str__` output) is rendered as captured text; result rendering treats
  it as data, but agents operating on untrusted repositories should run in
  sandboxed environments.
