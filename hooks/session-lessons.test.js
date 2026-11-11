"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decide, buildContext, SOURCES } = require("./session-lessons");
const { locations } = require("../scripts/insights-settings");

const ROOT = "C:/Users/me/.claude/plugins/cache/nosphera-plugins/nosphera/0.2.0";

// Which session starts get the check.
assert.deepEqual([...SOURCES].sort(), ["clear", "resume", "startup"]);
for (const source of ["startup", "resume", "clear"]) {
  const out = decide({ hook_event_name: "SessionStart", source, session_id: "s1" }, { CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart", source);
  assert.match(out.hookSpecificOutput.additionalContext, /call the Nosphera tool get_lessons once/, source);
}
assert.equal(decide({ hook_event_name: "SessionStart", source: "compact" }, {}), null, "compaction continues the same session");
assert.equal(decide({ hook_event_name: "SessionStart", source: "fork" }, {}), null, "a fork inherits its parent's context");
assert.equal(decide({ hook_event_name: "PostToolUse", tool_name: "Bash" }, {}), null, "other events are ignored");
assert.equal(decide(null, {}), null);
assert.equal(decide("startup", {}), null);
assert.ok(decide({ source: "startup" }, {}), "a payload without the event name still works");
assert.ok(decide({ hook_event_name: "SessionStart" }, {}), "a payload without a source is treated as a start");

// What the agent is told.
const context = buildContext(ROOT);
const [heading, availability, check] = context.split("\n");
assert.match(heading, /Nosphera lessons check/);
assert.match(availability, /does not offer both get_lessons and lesson_added, stop here without calling Nosphera or mentioning this check/);
assert.match(check, /call the Nosphera tool get_lessons once/);
assert.match(context, /On your first turn in this session, before you start on the user's request/);
assert.match(context, /open_count is 0\): say nothing/);
assert.match(context, /## Lessons from Nosphera/);
assert.match(context, /- nosphera:<item_id>: <what to do differently next time, on one line>/);
assert.ok(context.includes(`node "${ROOT}/scripts/fingerprint.js" --file <memory file> --item <item_id>`), "points at the bundled fingerprint script");
assert.match(context, /call lesson_added with the item_id and the printed fingerprint/);
assert.match(context, /Only the fingerprint goes to Nosphera, never the lesson text/);
assert.match(context, /authentication error, skip the check, do not retry/);
assert.doesNotMatch(context, /get_insights/, "only tools that are live today are named");

// hooks.json must agree with the script: same session sources, and every hook script it names exists.
const hooksConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "hooks.json"), "utf8")).hooks;
assert.deepEqual(hooksConfig.SessionStart[0].matcher.split("|").sort(), [...SOURCES].sort(), "the matcher and SOURCES must list the same session starts");
assert.equal(hooksConfig.PostToolUse[0].matcher, "Bash|PowerShell", "the PR hook must cover both shell tools");
const whoami = "mcp__plugin_nosphera_nosphera__whoami";
assert.equal(hooksConfig.PostToolUse[1].matcher, whoami);
assert.equal(hooksConfig.PostToolUse[1].hooks[0].timeout, 5);
assert.ok(!hooksConfig.PostToolUse[1].hooks[0].async, "the notice must reach the same turn");
for (const event of Object.values(hooksConfig)) {
  for (const entry of event) {
    for (const hook of entry.hooks) {
      assert.equal(hook.command, "node");
      const target = hook.args[0].replace("${CLAUDE_PLUGIN_ROOT}", path.join(__dirname, ".."));
      assert.ok(fs.existsSync(target), `hook script missing: ${hook.args[0]}`);
    }
  }
}

// Plugin root handling: backslashes become slashes, a missing root still gives usable text.
assert.ok(buildContext("C:/x/y").includes('node "C:/x/y/scripts/fingerprint.js"'));
assert.ok(decide({ source: "startup" }, { CLAUDE_PLUGIN_ROOT: "C:\\Users\\me\\plugin\\" }).hookSpecificOutput.additionalContext.includes('node "C:/Users/me/plugin/scripts/fingerprint.js"'));
assert.match(buildContext(""), /node scripts\/fingerprint\.js \(in the nosphera plugin folder\)/);

// End to end through stdin, using a temporary home even for signed-out starts.
const script = path.join(__dirname, "session-lessons.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nosphera-session-start-"));
const home = path.join(temporary, "home");
const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, HOME: home, USERPROFILE: home };
const store = path.join(locations({ home }).helperDir, "seen-folders");
const first = path.join(temporary, "first folder");
const hash = (folder) => createHash("sha256").update(folder).digest("hex");
const run = (file, input) => execFileSync(process.execPath, [file], { input, encoding: "utf8", env });
const start = (cwd, source = "startup") => JSON.parse(run(script, JSON.stringify({
  session_id: "abc", cwd, hook_event_name: "SessionStart", source,
}))).hookSpecificOutput;

try {
  const started = start(first);
  assert.equal(started.hookEventName, "SessionStart");
  assert.ok(started.additionalContext.endsWith(context), "the lessons text is unchanged");
  assert.match(started.additionalContext, /if the Nosphera plugin connection already offers whoami, call it once/);
  assert.match(started.additionalContext, /If it is unavailable or the call fails, skip it silently and do not retry/);
  assert.doesNotMatch(started.additionalContext, /signed in as|unnamed agent|\/nosphera:connect/);
  assert.equal(fs.readFileSync(store, "utf8"), "", "startup leaves no folder fingerprint");

  fs.writeFileSync(store, hash(first) + "\n");
  assert.equal(start(first, "resume").additionalContext, context);
  assert.equal(start(first).additionalContext, context);
  assert.ok(!fs.existsSync(first), "the project folder is not written");

  fs.unlinkSync(store);
  fs.mkdirSync(store);
  assert.equal(start(first).additionalContext, context, "an unreadable store keeps the lessons check");
  assert.equal(run(script, JSON.stringify({ hook_event_name: "SessionStart", source: "compact", cwd: first })), "");
  assert.equal(run(script, "not json"), "", "garbage input never breaks the session");
  assert.equal(run(script, ""), "", "empty input is silent");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("session-lessons.test.js passed");
