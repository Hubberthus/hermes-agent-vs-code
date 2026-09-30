# Fixes against Hermes Agent for VS Code 0.2.53

Each patch applies cleanly, on its own, to the upstream release commit
`a8b2f8f` ("release: sync Hermes Agent 0.2.53 source").

    git apply patches/00-all-fixes-combined.patch      # everything
    git apply patches/01-hermes-home-and-lifecycle.patch   # or one fix at a time

The shards partition the change exactly: their combined diff equals the
combined patch, with no overlap and no gap. Only these six source files
change; nothing under `patches/` is part of any patch.

## What each patch fixes

**01-hermes-home-and-lifecycle** — `extension.js`

`resolveHermesHome()` replaces a hard-coded `~/.hermes`. The extension
previously looked for the backend in a fixed location, which is wrong on
Windows (where Hermes lives under `%LOCALAPPDATA%`) and on any install that
sets its own home. Also tightens the turn lifecycle so a turn cannot be left
without an owner.

**02-no-shell-and-idle-exit** — `lib/acp-client.js`, `lib/reasoning-config.js`

Spawns the backend with `shell: false` and `windowsHide: true`. Routing the
command through a shell meant arguments were re-parsed by `cmd.exe`, so any
path containing a space or a metacharacter could be mangled, and a console
window flashed on every launch.

**03-host-no-shell-and-idle** — `background/host.js`

Shortens the host's idle lifetime from 30 s to 10 min. At 30 s the background
host exited between prompts, so each message paid a cold-start cost and any
in-flight work could be cut off.

**04-background-client-idle** — `lib/background-client.js`

Keeps the client's idle expectation in step with the host, so the client does
not decide the host has gone away while it is in fact still alive.

**05-steer-continuation-finalize** — `lib/acp-render.js`

Fixes the steer button deadlocking the conversation. Steering replaces the
turn's assistant message with a continuation and marks the original
`continued`. The completion guard then read the *new* message, which no longer
matched, so the turn was never finalized and the continuation stayed `running`
forever. Because `running` is what drives `sessionIsRunning`, the composer
locked up permanently and no further message could be sent.

`finalizeCurrent()` closes whichever message the renderer currently points at,
and forces a terminal state rather than deferring. `completeTurn()` legitimately
returns `needsFinalAnswer: true` and leaves a message `running` when it has no
answer text yet, expecting the caller to prompt again and finalize a second
time; a steer continuation has no such second call, so that contract cannot be
honoured and the turn is closed outright. The ordinary turn path is unchanged.

## Verifying

`steer-repro.js` and `turn-regression.js` drive `lib/acp-render.js` directly
under plain Node, with no VS Code involved.

    node steer-repro.js base-check   # red on upstream: steer stays "running"
    node steer-repro.js fixed        # green after patch 05

The regression harness additionally pins the behaviours these patches must not
break: a normal turn still finalizes to `done` in one call, an answer-less turn
still defers with `needsFinalAnswer: true`, and a failed turn still reports
`failed`.

Note that `npm test` and `npm run lint` cannot run on upstream as published:
`package.json` still references 24 files under `test/`, but the directory was
deleted in `8a5d247` ("Delete test directory"). Syntax-check the sources
directly instead:

    for f in extension.js background/*.js lib/*.js media/*.js; do node --check "$f"; done
