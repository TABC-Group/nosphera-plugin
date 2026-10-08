"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { decide, findPullRequests, opensPullRequest } = require("./claim-pr");

const PR = "https://github.com/example/project/pull/1";

// Command detection: only commands that open a pull request.
assert.ok(opensPullRequest("gh pr create --fill"));
assert.ok(opensPullRequest("cd apps/web && gh pr create --title 'x'"));
assert.ok(opensPullRequest("GH_TOKEN=abc gh pr create"));
assert.ok(!opensPullRequest("gh pr view 12"));
assert.ok(!opensPullRequest("git push -u origin feature"));
assert.ok(!opensPullRequest("echo gh pr created"));

// URL extraction, from stdout strings and from structured tool responses.
assert.deepEqual(findPullRequests("gh pr create", `Creating pull request for feature into main\n${PR}\n`), [PR]);
assert.deepEqual(findPullRequests("gh pr create", `${PR}/\n${PR}`), [PR], "trailing slash and duplicates collapse");
assert.deepEqual(findPullRequests("git push", "remote: Create a pull request by visiting:\nremote: https://github.com/o/r/pull/new/feature"), [], "a pull/new link is not a pull request");

// The hook only speaks up for a Bash tool call that opened a pull request.
const opened = decide({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: `${PR}\n`, stderr: "" } });
assert.equal(opened.hookSpecificOutput.hookEventName, "PostToolUse");
assert.match(opened.hookSpecificOutput.additionalContext, /claim_work with link="https:\/\/github\.com\/example\/project\/pull\/1"/);
assert.match(opened.hookSpecificOutput.additionalContext, /before the pull request merges/);

assert.equal(decide({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: `${PR}\n` }).hookSpecificOutput.additionalContext.includes(PR), true, "string responses work too");
assert.equal(decide({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "error: not logged in", stderr: "" } }), null, "no URL, nothing to claim");
assert.equal(decide({ tool_name: "Bash", tool_input: { command: "gh pr view 1" }, tool_response: { stdout: PR } }), null, "viewing is not opening");
assert.equal(decide({ tool_name: "Write", tool_input: { file_path: "x" }, tool_response: PR }), null, "other tools are ignored");
assert.equal(decide(null), null);

const two = decide({ tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: `${PR}\nhttps://github.com/o/r/pull/7` } });
assert.match(two.hookSpecificOutput.additionalContext, /once per link/);

// End to end through stdin, the way Claude Code runs it: JSON in, JSON out, exit 0, silent when nothing to do.
const script = path.join(__dirname, "claim-pr.js");
const out = execFileSync(process.execPath, [script], {
  input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: `${PR}\n`, stderr: "", interrupted: false } }),
  encoding: "utf8",
});
assert.ok(JSON.parse(out).hookSpecificOutput.additionalContext.includes(PR));
assert.equal(execFileSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\nb" } }), encoding: "utf8" }), "");
assert.equal(execFileSync(process.execPath, [script], { input: "not json", encoding: "utf8" }), "", "garbage input never breaks the tool call");

console.log("claim-pr.test.js passed");
