#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { locations } = require("../scripts/insights-settings");

const WHOAMI = "mcp__plugin_nosphera_nosphera__whoami";

function checkFolderStore(cwd, record) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  try {
    const { helperDir } = locations();
    const normalized = path.resolve(cwd);
    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    const store = path.join(helperDir, "seen-folders");
    const existing = fs.lstatSync(store, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return false;
    fs.mkdirSync(helperDir, { recursive: true, mode: 0o700 });
    // A second session in the same folder must not read and append at the
    // same time. Startup only checks the store and never takes the lock.
    const lock = store + "." + fingerprint;
    if (record) fs.mkdirSync(lock, { mode: 0o700 });
    try {
      const file = fs.openSync(store, "a+", 0o600);
      try {
        const seen = fs.readFileSync(file, "utf8").split("\n");
        if (seen.includes(fingerprint)) return false;
        if (record) fs.appendFileSync(file, fingerprint + "\n");
        return true;
      } finally {
        fs.closeSync(file);
      }
    } finally {
      if (record) fs.rmdirSync(lock);
    }
  } catch {
    return false;
  }
}

function needsNotice(cwd) {
  return checkFolderStore(cwd, false);
}

function readIdentity(response) {
  if (!response || response.isError) return null;
  let identity = response.structuredContent ?? response.content ?? response;
  if (Array.isArray(identity)) identity = identity.find((block) => block?.type === "text")?.text;
  if (typeof identity === "string") {
    try {
      identity = JSON.parse(identity);
    } catch {
      return null;
    }
  }
  if (identity?.isError || typeof identity?.id !== "string" || !identity.id.trim()) return null;
  if (identity.connection_type === "tool") {
    return typeof identity.name === "string" && identity.name.trim() ? identity : null;
  }
  return typeof identity.did === "string" && identity.did.startsWith("did:") ? identity : null;
}

function plainName(name) {
  const cleaned = name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/"/g, "'")
    .trim();
  const characters = Array.from(cleaned);
  return characters.length > 120 ? characters.slice(0, 119).join("") + "\u2026" : cleaned;
}

function remember(payload) {
  if (payload?.hook_event_name !== "PostToolUse" || payload.tool_name !== WHOAMI) return;
  const identity = readIdentity(payload.tool_response);
  if (!identity) return;

  const kind = identity.connection_type === "tool" ? "tool" : "agent";
  const rawName = kind === "tool" ? identity.name : identity.display_name;
  if (rawName != null && typeof rawName !== "string") return;
  const name = plainName(rawName ?? "");
  if (!name && (kind === "tool" || rawName?.trim())) return;
  const connection = name ? `the ${kind} "${name}"` : "an unnamed agent";
  const line = `Nosphera: this folder is signed in as ${connection} (the sign-in saved on this computer). Run /nosphera:connect to see or change it.`;
  if (checkFolderStore(payload.cwd, true)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Begin your final reply with the following Nosphera notice. Copy it exactly once, on its own line, without formatting it. Then answer the user's request.\n" + line,
      },
    };
  }
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const result = remember(JSON.parse(raw));
      if (result) process.stdout.write(JSON.stringify(result));
    } catch {
      // Identity lookup and session startup should work without this reminder.
    }
  });
}

module.exports = { needsNotice };
