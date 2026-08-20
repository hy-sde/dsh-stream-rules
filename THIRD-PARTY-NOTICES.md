# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük
- **Derived modules**:
  - `@hy-sde-org/dsh-dap` — the DAP client and Content-Length framing
    (`coding-agent/src/dap/client.ts`, `.../jsonrpc/message-framing.ts`),
    the debug-session manager (launch/attach, breakpoints, stepping,
    frames/scopes/variables, evaluate, memory, modules, terminate), adapter
    resolution and default configuration (`.../dap/config.ts`,
    `defaults.json`), and the environment probing for debugpy/dlvv/lldb-dap/gdb.
  - `@hy-sde-org/dsh-tool-debug` — the model-facing `debug` tool
    (`coding-agent/src/tools/debug.ts`), its argument schema and dispatch, and
    the rendered session snapshots the model reads.

License text (identical for all listed projects):

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness (port substrate)

The port was authored against the DeepSeek Harness (`deepseek-harness`) —
MIT License, Copyright (c) 2026 DeepSeek — whose plugin/service contracts
(agent presets, `ctx.tools`, `ctx.systemPrompt`, `ctx.subprocess`) are
integrated as peer dependencies, not copied source.

## Runtime dependency surface (not copied)

`@hy-sde-org/dsh-tool-debug` depends at runtime on:

| package | license |
|---|---|
| @deepseek-ai/schemastery | MIT |
| @hy-sde-org/dsh-dap | MIT (this repo) |

and both packages declare peer dependencies on the published DeepSeek
Harness packages (`@deepseek-ai/cordis`, `dsh-tools`, `dsh-system-prompt`,
`dsh-subprocess`, `dsh-subprocess-local`, `dsh-timeout`, `dsh-invariants`),
all served from the npm registry under their published licenses.
