/**
 * acp-client.js — Minimal ACP (Agent Client Protocol) client over stdio.
 *
 * Talks to `hermes acp` (Hermes' built-in ACP server) using JSON-RPC 2.0,
 * one JSON object per line on stdin/stdout. Delivers structured session
 * updates (thinking chunks, tool call start/progress, message chunks) to
 * the extension instead of parsing CLI box-drawing output.
 *
 * Wire format (from agent-client-protocol 0.9.0, serialized by_alias):
 *   request     → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   response    → {"jsonrpc":"2.0","id":1,"result":{...}}
 *   notification← {"jsonrpc":"2.0","method":"session/update",
 *                  "params":{"sessionId":"...","update":{...}}}
 * All parameter names on the wire are camelCase.
 */
"use strict";

const { spawn } = require("child_process");

const ACP_NOTIFICATION_METHOD = "session/update";

// How many stderr lines to keep for post-mortem reporting. Enough to hold a
// cmd.exe "not recognized" message plus its continuation line, small enough
// that Hermes' normal INFO log chatter rolls out of the buffer.
const STDERR_TAIL_LIMIT = 20;

// Words that positively identify a shell-level launch failure. NOT the primary
// signal: cmd.exe localises this message (observed on this machine in Hungarian,
// "A rendszer nem találja a megadott elérési utat."), so matching English text
// alone is not portable. Used only to sharpen the wording.
const SPAWN_FAILURE_PATTERN =
  /is not recognized as an internal or external command|no such file or directory|cannot find the file|command not found|is not installed|not recognized/i;

class AcpClient {
  /**
   * @param {object} options
   * @param {string} options.command      e.g. "hermes"
   * @param {string[]} options.args       e.g. ["acp"]
   * @param {string} [options.cwd]        workspace root
   * @param {object} options.handlers
   * @param {(update: object, sessionId: string) => void} options.handlers.onSessionUpdate
   * @param {(request: object) => void} [options.handlers.onPermissionRequest]
   *        Called with the full JSON-RPC request {id, method, params} for
   *        server→client `session/request_permission`. The client MUST
   *        respond via respondPermission(id, response); the server is
   *        blocked waiting for it.
   * @param {(code: number | null) => void} [options.handlers.onExit]
   * @param {(err: Error) => void} [options.handlers.onError]
   * @param {(line: string) => void} [options.handlers.onStderr]
   */
  constructor({ command, args, cwd, handlers = {} }) {
    this.command = command;
    this.args = args || ["acp"];
    this.cwd = cwd;
    this.handlers = handlers;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.initialized = false;
    this.started = false;
    this.exited = false;
    this.intentionalStop = false;
    this.stderrTail = [];
    this.stderrEnded = false;
    this.exitReported = false;
    this.exitCode = null;
    this.sawProtocol = false;
    this._startPromise = null;
    this._exitPromise = new Promise(resolve => {
      this._resolveExit = resolve;
    });
  }

  /** Spawn the ACP process (idempotent; returns a promise that resolves once spawned). */
  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, HERMES_ACCEPT_HOOKS: "1" },
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (err) {
        reject(err);
        return;
      }
      this.proc = child;
      this.exited = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => this._onData(chunk));
      child.stdout.on("end", () => this._flush());

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        for (const line of chunk.toString().split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Keep a short tail so a failed spawn can report *why* it failed.
          // On Windows the shell swallows the real error: `spawn` succeeds and
          // the process exits 1 with only "is not recognized as an internal or
          // external command" on stderr, which is otherwise shown to the user
          // as a bare "Hermes ACP exited (code 1)".
          this.stderrTail.push(trimmed);
          if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.shift();
          if (this.handlers.onStderr) this.handlers.onStderr(trimmed);
        }
      });
      // `close` can fire before stderr has drained (measured: consistently on
      // Windows), so the exit diagnosis must wait for the stream to end.
      child.stderr.on("end", () => {
        this.stderrEnded = true;
        this._flushExit();
      });

      child.on("error", err => {
        this.exited = true;
        if (this.handlers.onError) this.handlers.onError(err);
        reject(err);
      });
      child.on("close", code => {
        this.exited = true;
        this.exitCode = code;
        // Defer: the exit diagnosis reads stderr, which (measured on Windows)
        // has not necessarily been drained by the time `close` fires.
        this._flushExit();
      });
      child.on("spawn", () => resolve());
    });
    return this._startPromise;
  }

  exitDiagnosis() {
    // The ACP adapter speaks JSON-RPC on stdout and logs on stderr, so any
    // stderr at all on an exit that produced no usable session means the
    // process never got going: a bad command path, a bad interpreter, a
    // crash before startup. Do not try to parse the shell's wording - it is
    // localised - just hand the last line to the user verbatim.
    if (this.sawProtocol) return null;
    const detail = this.stderrTail[this.stderrTail.length - 1];
    if (!detail) return null;
    const launchFailure = SPAWN_FAILURE_PATTERN.test(detail);
    return {
      reason: launchFailure ? "Hermes could not be started" : "Hermes exited during startup",
      detail
    };
  }

  /**
   * Report the exit once, after BOTH `close` and the stderr drain have fired.
   * Either can come first (measured: on Windows `close` usually precedes the
   * stderr drain), so gate on both rather than assuming an order.
   */
  _flushExit() {
    if (this.exitReported || !this.stderrEnded || this.exitCode === null) return;
    this.exitReported = true;
    const code = this.exitCode;
    // A shell that cannot find the command exits 1 with the real cause on
    // stderr and nothing on stdout. Surface it instead of a bare exit code.
    const diagnosis = this.exitDiagnosis();
    const detail = diagnosis ? `: ${diagnosis.detail}` : "";
    this._rejectAll(new Error(`ACP process exited with code ${code}${detail}`));
    if (this.handlers.onExit) this.handlers.onExit(code, diagnosis);
    this._resolveExit(code);
  }

  /** JSON-RPC request. Returns a promise for the `result` (rejects on error). */
  async request(method, params) {
    await this.start();
    if (this.exited) throw new Error("ACP process is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** JSON-RPC notification (no id, no response). Fire-and-forget. */
  notify(method, params) {
    if (!this.proc || this.exited) return;
    this._write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Respond to a server→client request (e.g. session/request_permission).
   * @param {number} id  the request id from onPermissionRequest
   * @param {object} result  response result object
   */
  respond(id, result) {
    if (!this.proc || this.exited) return;
    this._write({ jsonrpc: "2.0", id, result });
  }

  /** Kill the underlying process. */
  kill(signal = "SIGTERM") {
    if (this.proc && !this.exited) {
      try {
        this.proc.kill(signal);
      } catch { /* already gone */ }
    }
  }

  async killAndWait(timeoutMs = 1000) {
    this.kill("SIGTERM");
    if (this.exited) return true;
    let exited = await Promise.race([
      this._exitPromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]);
    if (exited) return true;
    this.kill("SIGKILL");
    exited = await Promise.race([
      this._exitPromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]);
    if (exited) return true;

    this.exited = true;
    try { this.proc?.stdin?.destroy(); } catch { /* already closed */ }
    try { this.proc?.stdout?.destroy(); } catch { /* already closed */ }
    try { this.proc?.stderr?.destroy(); } catch { /* already closed */ }
    this._rejectAll(new Error("ACP process did not report exit after SIGKILL"));
    return false;
  }

  // ── internals ───────────────────────────────────────────────

  _write(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _onData(chunk) {
    this.buffer += chunk;
    this._flush();
  }

  _flush() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // partial/odd line — skip
      }
      // Any valid JSON-RPC frame means the ACP adapter is alive and talking,
      // so a later exit is a session failure, not a launch failure.
      this.sawProtocol = true;
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests.
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // Server → client notification.
    if (msg.method === ACP_NOTIFICATION_METHOD && this.handlers.onSessionUpdate) {
      const params = msg.params || {};
      this.handlers.onSessionUpdate(params.update || {}, params.sessionId || "");
      return;
    }
    // Server → client REQUEST: the server awaits our response (e.g.
    // session/request_permission for edit/command approval). Delegate the
    // full request so the host can show a confirmation or auto-approve;
    // it must call respond(id, result) to unblock the agent loop.
    if (msg.method === "session/request_permission" && this.handlers.onPermissionRequest) {
      this.handlers.onPermissionRequest(msg);
      return;
    }
    // Other notifications (e.g. session/request_permission) — ignore for now;
    // the server auto-approves edits per its own policy when hooks are on.
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}

module.exports = { AcpClient };
