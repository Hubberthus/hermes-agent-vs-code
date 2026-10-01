"use strict";
// The user saw, on every prompt after the ACP process was replaced:
//
//   [ERROR] acp_adapter.server: prompt: session ba2b3377-... not found
//   Hermes could not complete the request.
//
// The extension cached a uiSessionId -> acpSessionId mapping from an ACP
// process that had since exited. ensureMappedAcpSession() returned that dead id
// without re-resuming it, so the new process answered session/prompt with
// "session not found" and the turn was reported as a generic failure.
//
// The fix: a mapping may only be used as-is when the LIVE client instance owns
// it. Otherwise it must go through session/resume (which restores the session
// from the DB), and the id that comes back must be the effective one reported
// in _meta.hermes.sessionProvenance.acpSessionId — resume_session() silently
// creates a NEW session for an unknown id and ResumeSessionResponse carries no
// sessionId field, so trusting the requested id there would reproduce the bug.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");

const start = source.indexOf("  async ensureMappedAcpSession(client, session) {");
assert.notStrictEqual(start, -1, "ensureMappedAcpSession not found");
let depth = 0;
let end = -1;
for (let i = source.indexOf("{", start); i < source.length; i += 1) {
  if (source[i] === "{") depth += 1;
  else if (source[i] === "}") {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
const methodText = source.slice(start, end);
const methodBody = methodText.slice(methodText.indexOf("{") + 1, methodText.length - 1);
// AsyncFunction, so the extracted method body keeps its `await`. Only `client`
// and `session` are injected: shadowing String/Error would break the body.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ensureMappedAcpSession = new AsyncFunction(
  "client", "session",
  methodBody
);

function makeHost({ sessions = new Map(), owners = new Map(), retired = new Set() } = {}) {
  return {
    acpSessions: sessions,
    acpSessionOwners: owners,
    retiredAcpSessions: retired,
    acp: undefined,
    workspaceCwd: () => "F:/metrix/metrixlibs-geom",
    applyAcpSessionState(session, acpSessionId, models, configOptions) {
      this.acpSessions.set(session.id, acpSessionId);
      session.acpSessionId = acpSessionId;
      this.acpSessionOwners.set(session.id, this.acp);
      if (models) session.modelState = models;
    },
    calls: []
  };
}

/** A fake ACP client that only knows the sessions the live process created. */
function makeClient({ known = new Set(), resumeCreatesNew = false, resumeThrows = false } = {}) {
  let counter = 0;
  const client = {
    known,
    calls: [],
    prompts: [],
    async request(method, params) {
      if (method === "session/resume") {
        client.calls.push(["session/resume", params.sessionId]);
        if (resumeThrows) throw new Error("resume failed");
        const id = known.has(params.sessionId) ? params.sessionId : `NEW-${++counter}`;
        if (!known.has(id)) known.add(id);
        return {
          models: { options: [{ id: "m" }] },
          // Only present when the server had to substitute a session; mirrors
          // acp_adapter/server.py resume_session + provenance._meta.
          _meta: { hermes: { sessionProvenance: { acpSessionId: id } } }
        };
      }
      if (method === "session/new") {
        client.calls.push(["session/new", ""]);
        const id = `NEW-${++counter}`;
        known.add(id);
        return { sessionId: id, models: { options: [{ id: "m" }] } };
      }
      if (method === "session/prompt") {
        client.calls.push(["session/prompt", params.sessionId]);
        if (!known.has(params.sessionId)) {
          // This is the real server behaviour: PromptResponse(stopReason="refusal")
          // after logging "prompt: session %s not found".
          return { stopReason: "refusal" };
        }
        client.prompts.push(params.sessionId);
        return { stopReason: "end_turn" };
      }
      throw new Error("unexpected method " + method);
    }
  };
  return client;
}

async function run() {
  const checks = [];
  const ok = (name, condition) => {
    assert.ok(condition, name);
    checks.push(name);
  };

  // --- 1. The reported bug: mapping restored from disk, live process is new ---
  {
    const DEAD = "ba2b3377-bb5f-4bd4-a972-809c0cae3cc5";
    const host = makeHost({
      sessions: new Map([["ui1", DEAD]]),
      owners: new Map() // restored from disk => no live owner
    });
    const session = { id: "ui1", acpSessionId: DEAD };
    // The new process never saw DEAD and has no DB row for it, so resume
    // substitutes a fresh session and reports it via provenance _meta.
    const client = makeClient({ known: new Set(), resumeCreatesNew: true });
    host.acp = client; // the extension's this.acp IS the live client

    const acpSessionId = await ensureMappedAcpSession.call(host, client, session);

    ok("stale mapping is re-resumed, not reused", client.calls[0][0] === "session/resume");
    ok("resume targets the cached id", client.calls[0][1] === DEAD);
    ok("effective id comes from provenance _meta", acpSessionId.startsWith("NEW-"));
    ok("mapping is updated to the live id", host.acpSessions.get("ui1") === acpSessionId);
    ok("ownership is recorded for the live client", host.acpSessionOwners.get("ui1") === client
      || host.acpSessionOwners.get("ui1") === host.acp);

    // The follow-up prompt must now succeed instead of returning "refusal".
    const result = await client.request("session/prompt", { sessionId: acpSessionId, prompt: [] });
    ok("prompt on the live session is not refused", result.stopReason !== "refusal");
  }

  // --- 2. The healthy path: same live process, mapping may be reused as-is ---
  {
    const host = makeHost();
    const client = makeClient({ known: new Set(["acp-1"]) });
    host.acp = client;
    const session = { id: "ui1", acpSessionId: "" };
    const first = await ensureMappedAcpSession.call(host, client, session);
    ok("first turn creates a session", first === "NEW-1");

    const second = await ensureMappedAcpSession.call(host, client, session);
    ok("second turn on the same process reuses the mapping", second === first);
    ok("no extra resume on the hot path",
      !client.calls.some(([method]) => method === "session/resume"));
  }

  // --- 3. Resume throws: fall through to session/new, mapping stays clean ---
  {
    const host = makeHost({ sessions: new Map([["ui1", "stale-1"]]) });
    const client = makeClient({ known: new Set(), resumeThrows: true });
    host.acp = client;
    const session = { id: "ui1", acpSessionId: "stale-1" };

    const acpSessionId = await ensureMappedAcpSession.call(host, client, session);
    ok("failed resume falls back to session/new", acpSessionId.startsWith("NEW-"));
    ok("stale id is dropped from the mapping", host.acpSessions.get("ui1") === acpSessionId);
    ok("stale id is cleared on the session", session.acpSessionId === acpSessionId);
  }

  // --- 4. A retired id (fork/cancellation handoff) is never resumed ---
  {
    const host = makeHost({
      sessions: new Map([["ui1", "retired-1"]]),
      retired: new Set(["retired-1"])
    });
    const client = makeClient({ known: new Set(), resumeCreatesNew: true });
    host.acp = client;
    const session = { id: "ui1", acpSessionId: "retired-1" };

    const acpSessionId = await ensureMappedAcpSession.call(host, client, session);
    ok("retired id is not resumed",
      !client.calls.some(([method]) => method === "session/resume"));
    ok("retired id yields a fresh session", acpSessionId.startsWith("NEW-"));
    ok("retired id is unmapped", host.acpSessions.get("ui1") === acpSessionId);
  }

  // --- 5. Losing the transport invalidates ownership (the restart path) ---
  {
    const source2 = source;
    ok("onDisconnect clears session ownership",
      /onDisconnect: \(\) => \{[\s\S]{0,400}?this\.acpSessionOwners\.clear\(\)/.test(source2));
    ok("onExit clears session ownership",
      /this\.acpSessions\.clear\(\);\s*\n\s*this\.acpSessionOwners\.clear\(\);/.test(source2));
    ok("onHostMigrated clears session ownership",
      /onHostMigrated:[\s\S]{0,200}?this\.acpSessionOwners\.clear\(\)/.test(source2));
  }

  console.log(`test-acp-stale-session: ${checks.length}/${checks.length} checks passed`);
  for (const name of checks) console.log("  ok - " + name);
}

run().catch(error => {
  console.error("test-acp-stale-session FAILED:", error.message);
  process.exit(1);
});