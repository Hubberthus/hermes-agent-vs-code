"use strict";
// Regression test: a bad hermesAgent.command must produce a diagnosable
// message, not a bare "Hermes ACP exited (code 1)".
//
// On Windows with shell:true, spawn() succeeds even when the command does not
// exist; cmd.exe prints "... is not recognized as an internal or external
// command" on stderr and exits 1. Before the fix the stderr line was dropped
// and the user saw only the exit code.
//
// This also pins the ordering hazard: on Windows `close` fires before stderr
// is drained, so the diagnosis must be deferred until both have happened.

const assert = require("node:assert");
const path = require("node:path");
const { AcpClient } = require(path.join(__dirname, "..", "lib", "acp-client.js"));

const MISSING = "C:\\definitely\\not\\here\\hermes.exe";
const TIMEOUT_MS = 20000;

function spawnMissing() {
  return new Promise((resolve, reject) => {
    const client = new AcpClient({ command: MISSING, args: ["acp"], handlers: {} });
    client.handlers.onExit = (code, diagnosis) => resolve({ client, code, diagnosis });
    client.start().catch(err => reject(err));
    setTimeout(() => reject(new Error("no exit reported within " + TIMEOUT_MS + "ms")), TIMEOUT_MS);
  });
}

spawnMissing().then(({ client, code, diagnosis }) => {
  assert.notStrictEqual(code, 0, "expected the missing command to fail");
  assert.ok(client.stderrTail.length, "expected stderr to be retained for post-mortem reporting");
  assert.ok(diagnosis, "expected an exit diagnosis for a missing command");
  // Wording may be either variant: the shell message is localised, so the
  // reason string is deliberately not asserted word-for-word.
  assert.match(diagnosis.reason, /could not be started|exited during startup/i);
  assert.ok(diagnosis.detail.length > 10, "expected a substantive stderr detail");
  console.log("ok - exit " + code + " diagnosed: " + diagnosis.detail);
  console.log("ok - exit reported only after close AND stderr drain");
}).catch(err => {
  console.error("FAIL -", err.message);
  process.exit(1);
});
