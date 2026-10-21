#!/usr/bin/env node
/**
 * Nosphera PostToolUse hook for the Bash tool.
 *
 * When the command that just ran opened a GitHub pull request (gh pr create),
 * find the pull request URL in its output and tell Claude to check repository
 * visibility, then claim a confirmed-public PR before it merges.
 *
 * Reads the hook JSON from stdin, writes a JSON hookSpecificOutput with
 * additionalContext when a PR was opened, and stays silent otherwise. It never
 * calls Nosphera itself and never fails the tool call (exit 0 always).
 */

"use strict";

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*/g;

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (typeof value === "object") {
    const parts = [];
    for (const key of ["stdout", "stderr", "output", "text", "content", "result"]) {
      if (key in value) parts.push(textOf(value[key]));
    }
    return parts.length ? parts.join("\n") : JSON.stringify(value);
  }
  return String(value);
}

function opensPullRequest(command) {
  // gh pr create, possibly behind env assignments, cd && ..., or inside a chain.
  return /(^|[\s;&|(])gh\s+pr\s+create\b/.test(command);
}

function findPullRequests(command, output) {
  const urls = new Set();
  for (const text of [output, command]) {
    for (const match of text.matchAll(PR_URL)) {
      urls.add(match[0].replace(/\/+$/, ""));
    }
  }
  return [...urls];
}

function buildContext(urls) {
  const list = urls.map((url) => `- ${url}`).join("\n");
  const claim = urls.length === 1
    ? `Only if its repository is confirmed PUBLIC, call the Nosphera tool claim_work with link="${urls[0]}" now, before the pull request merges.`
    : "Only for repositories confirmed PUBLIC, call the Nosphera tool claim_work once per link now, before the pull requests merge.";
  return [
    "A pull request was just opened:",
    list,
    "First check each repository's visibility using GitHub metadata (for example gh repo view <owner>/<repo> --json visibility), without fetching private content. Skip private repositories or an unknown visibility without sending their links or names to Nosphera. Never use claim_work to test visibility.",
    claim,
    "For a confirmed-public repository, do this in this turn without asking. If claim_work answers E_PROOF_CLAIM_EXISTS the PR is already claimed; if it answers E_TOOL_NOT_CONNECTED tell the user to connect GitHub in Nosphera Settings; if it answers with an authentication error tell the user to run /mcp and authenticate nosphera.",
  ].join("\n");
}

// Both shell tools carry the command in tool_input.command. On Windows, Claude
// Code routes shell commands through the PowerShell tool when it is enabled.
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function decide(payload) {
  if (!payload || !SHELL_TOOLS.has(payload.tool_name)) return null;
  const command = String((payload.tool_input && payload.tool_input.command) || "");
  if (!opensPullRequest(command)) return null;
  const urls = findPullRequests(command, textOf(payload.tool_response));
  if (urls.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: buildContext(urls),
    },
  };
}

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let payload = null;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const result = decide(payload);
    if (result) process.stdout.write(JSON.stringify(result));
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { decide, findPullRequests, opensPullRequest };
