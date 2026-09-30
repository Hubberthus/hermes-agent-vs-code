# Local fixes — Hermes Agent VS Code extension

Applied against upstream `a8b2f8f` ("release: sync Hermes Agent 0.2.53 source").

Apply the combined patch, or the numbered shards in order:

```sh
git apply patches/00-all-fixes-combined.patch
# or, equivalently:
git apply patches/01-hermes-home-and-lifecycle.patch \
          patches/02-no-shell-and-idle-exit.patch \
          patches/03-host-no-shell-and-idle.patch \
          patches/04-background-client-idle.patch
```

The shards form a **partition**: every changed file appears in exactly one
shard, and the shards together equal the combined patch (verified: 98 added
lines either way). They can be applied independently and in any order.

## Shards

### 01-hermes-home-and-lifecycle — `extension.js`

Two separate problems in one file.

**Hermes home resolution.** `HERMES_HOME` was hardcoded to `~/.hermes`.
Hermes itself uses `%LOCALAPPDATA%\hermes` on Windows and
`~/.local/share/hermes` on Linux. Reading a stub home meant `config.yaml`,
`skills/`, `memories/` and `sessions/` all resolved against the wrong
directory, so anything the extension wrote never reached the Hermes the CLI
actually runs with. Now resolved by `resolveHermesHome()`: an explicit
`HERMES_HOME` wins, otherwise the first platform candidate that actually
contains a `config.yaml`.

**Console window.** The ACP backend was spawned through a shell on Windows,
which opens a visible console window on every start.

### 02-no-shell-and-idle-exit — `lib/acp-client.js`, `lib/reasoning-config.js`

`shell: false` plus `windowsHide: true` on both spawns. The commands are real
executables that Node resolves from `PATH` on its own; routing them through
`cmd.exe` only re-parses the arguments and flashes a console window.

### 03-host-no-shell-and-idle — `background/host.js`

Same `shell: false` / `windowsHide: true` change for the background host.

Also raises the idle-exit threshold from 30 s to 10 min. Upstream's 30 s is
shorter than the ACP backend's own cold start (measured ~13 s: MCP server
handshakes plus ~62 plugin registrations), so any pause longer than half a
minute killed the host and the next prompt paid a full backend restart. The
anti-orphan intent is preserved — an abandoned host still reaps itself, and
`_hasActiveWork()` still blocks exit while a task runs.

### 04-background-client-idle — `lib/background-client.js`

Client-side counterpart to the idle-exit change.

## Notes

- `extension.js` also gains `preserveFocus: true` on the background tab
  relocation path, so moving a misplaced editor tab cannot steal the keyboard
  focus from the chat input. This belongs to shard 01 because it is a change
  to the same file; it is not a separate shard.
- These patches cover the fixes only. They deliberately exclude diagnostic
  instrumentation (raw ACP stderr logging) and any internal notes or plans,
  so the set can be applied to upstream without carrying local context.
