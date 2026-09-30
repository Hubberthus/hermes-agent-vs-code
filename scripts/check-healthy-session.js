"use strict";
// Verifies the normal path still works: a real ACP session initializes,
// speaks JSON-RPC, and reports no exit diagnosis while it is alive.
const path = require("node:path");
const os = require("node:os");
const { AcpClient } = require(path.join(__dirname, "..", "lib", "acp-client.js"));

const COMMAND = process.argv[2];
if (!COMMAND) {
  console.error("usage: node check-healthy-session.js <hermes path>");
  process.exit(2);
}

const client = new AcpClient({
  command: COMMAND,
  args: ["acp"],
  cwd: os.homedir(),
  handlers: {
    onStderr: () => {},
    onExit: (code, diagnosis) => console.log("exit: code=" + code + " diagnosis=" + JSON.stringify(diagnosis))
  }
});

client.start().then(async () => {
  const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("initialize ok: protocolVersion=" + (init && init.protocolVersion));
  console.log("sawProtocol=" + client.sawProtocol + " (expected true)");
  console.log("exitDiagnosis while alive=" + client.exitDiagnosis() + " (expected null)");
  const healthy = Boolean(init) && client.sawProtocol === true && client.exitDiagnosis() === null;
  console.log(healthy ? "ok - healthy session unaffected" : "FAIL - healthy session regressed");
  process.exit(healthy ? 0 : 1);
}).catch(err => {
  console.error("FAIL -", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("FAIL - timeout");
  process.exit(2);
}, 40000);
