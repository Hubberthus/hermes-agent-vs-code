"use strict";
// Stdio filter for MCP servers that print banners to stdout.
//
// Some MCP servers write human-readable startup text to stdout, which is
// reserved for JSON-RPC framing. Hermes' MCP client then logs
//   mcp.client.stdio: Failed to parse JSONRPC message from server
// plus a traceback, and an editor extension watching that stderr shows it to
// the user as a transport error.
//
// This wrapper runs the real server as a child and forwards ONLY well-formed
// JSON-RPC lines to our stdout. Everything else - banners, ASCII art, log
// noise - is relayed to stderr, where it belongs and where nobody parses it.
//
// Usage: node mcp-stdio-filter.js <command> [args...]
//   Used in Hermes config.yaml as:
//     command: node
//     args: [C:/path/to/mcp-stdio-filter.js, uvx, pmb-ai, mcp, serve, --transport, stdio]

const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
if (!argv.length) {
  process.stderr.write("mcp-stdio-filter: no command given\n");
  process.exit(2);
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});

let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const trimmed = line.trim();
    if (!trimmed) continue;
    let framed = false;
    try {
      const msg = JSON.parse(trimmed);
      // A bare JSON value is not necessarily a JSON-RPC frame. Require the
      // envelope so an informational `{"status": "ok"}` is also diverted.
      framed = Boolean(msg) && typeof msg === "object" && ("jsonrpc" in msg || "method" in msg || "id" in msg);
    } catch {
      framed = false;
    }
    if (framed) process.stdout.write(trimmed + "\n");
    else process.stderr.write(trimmed + "\n");
  }
});

child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);

const forward = signal => { try { child.kill(signal); } catch { /* gone */ } };
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
child.on("error", err => {
  process.stderr.write(`mcp-stdio-filter: ${argv[0]} failed to start: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code === null ? 1 : code);
});
