"use strict";
// Tight loop for: "mcp.client.stdio: Failed to parse JSONRPC message from server".
//
// Spawns each configured MCP server the way Hermes does, sends a real
// `initialize` over stdio, and reports any stdout line that is not a valid
// JSON-RPC frame. The offending server prints the culprit on startup.
//
// Usage: node scripts/check-mcp-servers.js [serverName ...]

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), "AppData", "Local", "hermes");
const CONFIG = path.join(HERMES_HOME, "config.yaml");

// Minimal reader for the flat 2-level `mcp_servers:` block; no yaml dep needed.
function readServers() {
  const lines = fs.readFileSync(CONFIG, "utf8").split("\n");
  const servers = {};
  let inBlock = false;
  let current = null;
  for (const raw of lines) {
    if (/^mcp_servers:\s*$/.test(raw)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^\S/.test(raw) && raw.trim()) { inBlock = false; continue; }
    const name = raw.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if (name) { current = name[1]; servers[current] = { command: "", args: [], env: {}, enabled: true }; continue; }
    if (!current) continue;
    const enabled = raw.match(/^    enabled:\s*(\S+)/);
    if (enabled) { servers[current].enabled = enabled[1] === "true"; continue; }
    const command = raw.match(/^    command:\s*(.+)/);
    if (command) { servers[current].command = command[1].trim().replace(/^["']|["']$/g, ""); continue; }
    const arg = raw.match(/^      - (.+)/);
    if (arg && !/^\s*#/.test(raw)) { servers[current].args.push(arg[1].trim().replace(/^["']|["']$/g, "")); continue; }
    const env = raw.match(/^      ([A-Za-z_][A-Za-z0-9_]*):\s*(.+)/);
    if (env) { servers[current].env[env[1]] = env[2].trim().replace(/^["']|["']$/g, ""); continue; }
  }
  return servers;
}

function probe(name, spec, timeoutMs = 45000) {
  return new Promise(resolve => {
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const bad = [];
    let buf = "";
    let sawFrame = false;
    const finish = verdict => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ name, ...verdict, bad, sawFrame });
    };
    const timer = setTimeout(() => finish({ ok: false, why: "timeout (no initialize reply)" }), timeoutMs);
    child.on("error", err => { clearTimeout(timer); finish({ ok: false, why: "spawn error: " + err.message }); });
    child.stderr.on("data", () => { /* stderr is the server's log, not the protocol */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          sawFrame = true;
          if (msg.id === 1) { clearTimeout(timer); finish({ ok: true }); }
        } catch {
          bad.push(line);
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hermes-acp-check", version: "0" }
      }
    }) + "\n");
  });
}

(async () => {
  const only = process.argv.slice(2);
  const all = readServers();
  const targets = Object.entries(all).filter(([name, spec]) => spec.enabled && spec.command && (!only.length || only.includes(name)));
  if (!targets.length) {
    console.log("no enabled MCP servers matched");
    return;
  }
  let failures = 0;
  for (const [name, spec] of targets) {
    const result = await probe(name, spec);
    if (!result.ok) {
      failures++;
      console.log(`FAIL ${name}: ${result.why}`);
    } else if (result.bad.length) {
      failures++;
      console.log(`FAIL ${name}: ${result.bad.length} non-JSONRPC stdout line(s)`);
      for (const line of result.bad.slice(0, 5)) console.log(`      ${line.slice(0, 160)}`);
    } else {
      console.log(`ok   ${name}: clean JSON-RPC stdout`);
    }
  }
  console.log(failures ? `\n${failures}/${targets.length} server(s) emit invalid JSON-RPC` : `\nall ${targets.length} server(s) clean`);
  process.exit(failures ? 1 : 0);
})();
