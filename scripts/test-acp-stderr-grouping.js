"use strict";
// The user saw TWO popups for ONE fault:
//   "Hermes ACP transport error: ... mcp.client.stdio: Failed to parse JSONRPC message from server"
//   "Hermes ACP transport error: Traceback"
// A single log record (marker line + traceback body) must produce ONE
// incident, attributed to the logger that emitted it and NOT called a
// transport error, because the ACP transport was healthy throughout.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const shown = [];
const posted = [];
const vscode = {
  window: { showWarningMessage: msg => shown.push(msg) },
  workspace: { getConfiguration: () => ({ get: () => 0 }) }
};

const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
// Extract just the two stderr methods plus a minimal host object, so the test
// exercises the real logic without booting the whole extension.
const grab = name => {
  const start = source.indexOf("  " + name + "(");
  assert.notStrictEqual(start, -1, name + " not found");
  let depth = 0;
  let i = source.indexOf("{", start);
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
};

// Turn a class method into a standalone function over a host `this`.
function body(name, params) {
  const text = grab(name);
  const open = text.indexOf("{");
  return new Function("vscode", ...params, text.slice(open + 1, text.length - 1));
}

const context = {
  vscode,
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  _absorbAcpStderr: body("_absorbAcpStderr", ["client", "line"]),
  _reportAcpStderrIncident: body("_reportAcpStderrIncident", ["client", "incident"]),
  activeTurns: new Map(),
  post: msg => posted.push(msg)
};
context._absorbAcpStderr = context._absorbAcpStderr.bind(context, vscode);
context._reportAcpStderrIncident = context._reportAcpStderrIncident.bind(context, vscode);

// The record exactly as Hermes emitted it: marker line, then traceback body.
const RECORD = [
  "2026-09-30 14:41:46 [ERROR] mcp.client.stdio: Failed to parse JSONRPC message from server",
  "Traceback (most recent call last):",
  '  File "C:\\venv\\Lib\\site-packages\\mcp\\client\\stdio.py", line 223, in _parse_line',
  "    message = types.jsonrpc_message_adapter.validate_json(line, by_name=False)",
  "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)"
];

function run(lines) {
  shown.length = 0;
  posted.length = 0;
  context._acpStderrState = null;
  const client = { suppressCancellationErrorsUntil: 0 };
  for (const line of lines) context._absorbAcpStderr(client, line);
  return new Promise(resolve => setTimeout(resolve, 400));
}

run(RECORD).then(() => {
  assert.strictEqual(shown.length, 1, "expected ONE popup for one log record, got " + shown.length + ": " + JSON.stringify(shown));
  const message = shown[0];
  assert.ok(!/transport error/i.test(message), "must not blame the ACP transport: " + message);
  assert.ok(/mcp\.client\.stdio/.test(message), "should name the logger that failed: " + message);
  assert.ok(/Failed to parse JSONRPC/.test(message), "should keep the headline cause");
  assert.ok(!/Traceback$/.test(message.trim()), "the bare Traceback line should not be its own popup");
  console.log("ok - one MCP log record produced exactly one popup");
  console.log("ok - attributed to mcp.client.stdio, not the ACP transport");

  // A non-error INFO line must stay silent.
  return run(["2026-09-30 14:41:46 [INFO] acp_adapter.server: ACP client connected"]);
}).then(() => {
  assert.strictEqual(shown.length, 0, "INFO chatter must not reach the user: " + JSON.stringify(shown));
  console.log("ok - INFO chatter stays silent");

  // Plugin-load warnings fire on every start and must NOT become popups.
  return run([
    "2026-09-30 [WARNING] hermes_cli.plugins: Failed to load plugin 'deepinfra': dictionary changed size during iteration",
    "2026-09-30 [WARNING] hermes_cli.plugins: Failed to load plugin 'xai': dictionary changed size during iteration"
  ]);
}).then(() => {
  assert.strictEqual(shown.length, 0, "plugin WARNINGs must stay silent: " + JSON.stringify(shown));
  console.log("ok - plugin-load WARNINGs stay silent");
}).catch(err => {
  console.error("FAIL -", err.message);
  process.exit(1);
});
