"use strict";
// Regression test: a bad hermesAgent.command must produce a diagnosable
// message, not a bare "Hermes ACP exited (code 1)".
//
// Two failure shapes depending on how the spawn is configured:
// - shell:false (current): spawn() rejects with ENOENT directly — the
//   missing binary is surfaced by Node itself, no shell involved.
// - shell:true (previous): spawn() succeeds, cmd.exe prints "... is not
//   recognized as an internal or external command" on stderr and exits 1.
//   That path also had an ordering hazard: on Windows `close` fires before
//   stderr is drained, so the diagnosis had to be deferred until both had
//   happened.

const assert = require("node:assert");
const path = require("node:path");
const { AcpClient } = require(path.join(__dirname, "..", "lib", "acp-client.js"));

const MISSING = "C:\\definitely\\not\\here\\hermes.exe";
const TIMEOUT_MS = 20000;

function spawnMissing() {
  return new Promise((resolve, reject) => {
    const client = new AcpClient({ command: MISSING, args: ["acp"], handlers: {} });
    client.handlers.onExit = (code, diagnosis) => resolve({ client, code, diagnosis });
    client.start().catch(err => {
      // With shell:false a missing binary rejects start() with ENOENT directly
      // (no shell to swallow the error) — that IS the diagnosable failure.
      if (err && (err.code === "ENOENT" || err.code === "EACCES")) {
        resolve({ client, code: null, diagnosis: { reason: "Hermes could not be started", detail: String(err.message) } });
        return;
      }
      reject(err);
    });
    setTimeout(() => reject(new Error("no exit reported within " + TIMEOUT_MS + "ms")), TIMEOUT_MS);
  });
}

spawnMissing().then(({ client, code, diagnosis }) => {
  assert.ok(code === null || code !== 0, "expected the missing command to fail");
  assert.ok(diagnosis, "expected an exit diagnosis for a missing command");
  // Wording may be either variant: the shell message is localised, so the
  // reason string is deliberately not asserted word-for-word.
  assert.match(diagnosis.reason, /could not be started|exited during startup/i);
  assert.ok(diagnosis.detail.length > 10, "expected a substantive stderr detail");
  console.log("ok - exit " + code + " diagnosed: " + diagnosis.detail);
  console.log("ok - missing command is diagnosable (ENOENT or shell stderr)");
}).catch(err => {
  console.error("FAIL -", err.message);
  process.exit(1);
});
