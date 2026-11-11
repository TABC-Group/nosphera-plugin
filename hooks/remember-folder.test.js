"use strict";

const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { locations } = require("../scripts/insights-settings");

const script = path.join(__dirname, "remember-folder.js");
const whoami = "mcp__plugin_nosphera_nosphera__whoami";
const agent = { id: "agent", did: "did:web:test", display_name: "Real Agent" };
const input = (cwd, tool_response = agent, tool_name = whoami) => JSON.stringify({
  cwd, tool_response, tool_name, hook_event_name: "PostToolUse",
});
const fingerprint = (folder) => createHash("sha256").update(folder).digest("hex");
const line = (identity) => `Nosphera: this folder is signed in as ${identity} (the sign-in saved on this computer). Run /nosphera:connect to see or change it.`;
const notice = (output) => {
  const { hookSpecificOutput } = JSON.parse(output);
  assert.equal(hookSpecificOutput.hookEventName, "PostToolUse");
  return hookSpecificOutput.additionalContext.split("\n").at(-1);
};

async function test() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nosphera-remember-folder-"));
  const home = path.join(temporary, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const store = path.join(locations({ home }).helperDir, "seen-folders");
  const options = { encoding: "utf8", env };
  const run = (input) => execFileSync(process.execPath, [script], { ...options, input });
  const first = path.join(temporary, "first folder");

  try {
    for (const answer of [
      { isError: true, structuredContent: agent },
      "E_AUTH",
      [],
      {},
      { id: "agent" },
      { id: "", did: "did:web:test" },
    ]) {
      assert.equal(run(input(first, answer)), "");
    }
    assert.equal(run(input(first, agent, "mcp__other__whoami")), "");
    assert.equal(run("not json"), "");
    assert.ok(!fs.existsSync(store), "an unsuccessful lookup does not create a store");

    const response = [{ type: "text", text: JSON.stringify(agent) }];
    assert.equal(notice(run(input(first, response))), line('the agent "Real Agent"'));
    assert.equal(run(input(first)), "");
    assert.equal(fs.readFileSync(store, "utf8"), fingerprint(first) + "\n");

    const tool = path.join(temporary, "tool folder");
    assert.equal(notice(run(input(tool, { structuredContent: {
      id: "tool", connection_type: "tool", name: "Real Tool",
    } }))), line('the tool "Real Tool"'));

    const unnamed = path.join(temporary, "unnamed");
    assert.equal(notice(run(input(unnamed, { ...agent, display_name: null }))), line("an unnamed agent"));

    const quoted = path.join(temporary, "quoted");
    const display_name = 'Real "Agent"\nName\u0000\u001b\u202e ' + "x".repeat(300);
    const expectedName = "Real 'Agent' Name  " + "x".repeat(100) + "\u2026";
    assert.equal(notice(run(input(quoted, { ...agent, display_name }))), line(`the agent "${expectedName}"`));

    const concurrent = path.join(temporary, "concurrent");
    const runAsync = () => {
      const child = promisify(execFile)(process.execPath, [script], options);
      child.child.stdin.end(input(concurrent));
      return child;
    };
    const outputs = (await Promise.all([runAsync(), runAsync()])).map(({ stdout }) => stdout).filter(Boolean);
    assert.deepEqual(outputs.map(notice), [line('the agent "Real Agent"')]);

    const folders = [first, tool, unnamed, quoted, concurrent];
    assert.equal(fs.readFileSync(store, "utf8"), folders.map(fingerprint).join("\n") + "\n");
    assert.deepEqual(fs.readdirSync(path.dirname(store)), ["seen-folders"]);
    assert.ok(folders.every((folder) => !fs.existsSync(folder)));

    fs.unlinkSync(store);
    fs.mkdirSync(store);
    assert.equal(run(input(first)), "", "an unreadable store suppresses the notice");
    assert.deepEqual(fs.readdirSync(path.dirname(store)), ["seen-folders"]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test().then(() => console.log("remember-folder.test.js passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
