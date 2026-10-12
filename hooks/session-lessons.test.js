"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { decide, buildContext, SOURCES } = require("./session-lessons");

const ROOT = "C:/Users/me/.claude/plugins/cache/nosphera-plugins/nosphera/0.2.0";

// Which session starts get the check.
assert.deepEqual([...SOURCES].sort(), ["clear", "resume", "startup"]);
for (const source of ["startup", "resume", "clear"]) {
  const out = decide({ hook_event_name: "SessionStart", source, session_id: "s1", cwd: "/repo" }, { CLAUDE_PLUGIN_ROOT: ROOT });
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
const hooksConfig = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "hooks.json"), "utf8")).hooks;
assert.deepEqual(hooksConfig.SessionStart[0].matcher.split("|").sort(), [...SOURCES].sort(), "the matcher and SOURCES must list the same session starts");
assert.equal(hooksConfig.PostToolUse[0].matcher, "Bash|PowerShell", "the PR hook must cover both shell tools");
for (const event of Object.values(hooksConfig)) {
  for (const entry of event) {
    for (const hook of entry.hooks) {
      assert.equal(hook.command, "node");
      const target = hook.args[0].replace("${CLAUDE_PLUGIN_ROOT}", path.join(__dirname, ".."));
      assert.ok(require("node:fs").existsSync(target), `hook script missing: ${hook.args[0]}`);
    }
  }
}

// Plugin root handling: backslashes become slashes, a missing root still gives usable text.
assert.ok(buildContext("C:/x/y").includes('node "C:/x/y/scripts/fingerprint.js"'));
assert.ok(decide({ source: "startup" }, { CLAUDE_PLUGIN_ROOT: "C:\\Users\\me\\plugin\\" }).hookSpecificOutput.additionalContext.includes('node "C:/Users/me/plugin/scripts/fingerprint.js"'));
assert.match(buildContext(""), /node scripts\/fingerprint\.js \(in the nosphera plugin folder\)/);

// End to end through stdin, the way Claude Code runs it: JSON in, JSON out, exit 0, silent when nothing to do.
const script = path.join(__dirname, "session-lessons.js");
const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT };
const started = execFileSync(process.execPath, [script], {
  input: JSON.stringify({ session_id: "abc", transcript_path: "/tmp/t.jsonl", cwd: "/repo", permission_mode: "default", hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" }),
  encoding: "utf8",
  env,
});
const parsed = JSON.parse(started);
assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
assert.ok(parsed.hookSpecificOutput.additionalContext.includes(ROOT));
assert.equal(execFileSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact" }), encoding: "utf8", env }), "");
assert.equal(execFileSync(process.execPath, [script], { input: "not json", encoding: "utf8", env }), "", "garbage input never breaks the session");
assert.equal(execFileSync(process.execPath, [script], { input: "", encoding: "utf8", env }), "", "empty input is silent");

console.log("session-lessons.test.js passed");
