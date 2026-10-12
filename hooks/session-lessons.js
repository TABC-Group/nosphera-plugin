#!/usr/bin/env node
/**
 * Nosphera SessionStart hook.
 *
 * When a session starts, tell Claude to check its open lessons on Nosphera
 * with the get_lessons tool before it starts on the user's request, and how
 * to record each lesson it writes down.
 *
 * Reads the hook JSON from stdin, writes a JSON hookSpecificOutput with
 * additionalContext for a new, resumed or cleared session, and stays silent
 * otherwise. It never calls Nosphera itself and never fails the session
 * (exit 0 always).
 */

"use strict";

// Session starts that deserve a lessons check. After a compaction the session
// simply continues, and a forked session inherits its parent's context, so
// neither needs the check again.
const SOURCES = new Set(["startup", "resume", "clear"]);

function pluginRoot(env) {
  const root = env && typeof env.CLAUDE_PLUGIN_ROOT === "string" ? env.CLAUDE_PLUGIN_ROOT.trim() : "";
  return root ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function buildContext(root) {
  const script = root ? `node "${root}/scripts/fingerprint.js"` : "node scripts/fingerprint.js (in the nosphera plugin folder)";
  return [
    "Nosphera lessons check (from the Nosphera plugin).",
    "On your first turn in this session, before you start on the user's request, call the Nosphera tool get_lessons once. It lists work this agent claimed on Nosphera that later failed: checks that failed after a merge, a pull request that was reverted, or a Linear issue that was reopened.",
    "- No items (open_count is 0): say nothing about this check and carry on with the request.",
    "- For each item: open its link, find out what went wrong, and add one line to your memory file (the project's CLAUDE.md, unless the user keeps your notes elsewhere) under the heading \"## Lessons from Nosphera\", in exactly this form:",
    "  - nosphera:<item_id>: <what to do differently next time, on one line>",
    `  Then fingerprint the lesson locally with ${script} --file <memory file> --item <item_id> (it prints the sha256 of the text after the prefix, with surrounding spaces removed) and call lesson_added with the item_id and the printed fingerprint. Only the fingerprint goes to Nosphera, never the lesson text. Keep it short: a few minutes per item, one line to the user about what you learned, then get on with the request.`,
    "- If the Nosphera tools are not available, or get_lessons answers with an authentication error, skip the check, do not retry, and mention it only if the user asks about Nosphera.",
  ].join("\n");
}

function decide(payload, env) {
  if (!payload || typeof payload !== "object") return null;
  if ("hook_event_name" in payload && payload.hook_event_name !== "SessionStart") return null;
  if ("source" in payload && !SOURCES.has(payload.source)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildContext(pluginRoot(env || process.env)),
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
    let result = null;
    try {
      result = decide(payload, process.env);
    } catch {
      result = null;
    }
    if (result) process.stdout.write(JSON.stringify(result));
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { decide, buildContext, SOURCES };
