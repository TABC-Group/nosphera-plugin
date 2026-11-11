#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { locations } = require("../scripts/insights-settings");

const WHOAMI = "mcp__plugin_nosphera_nosphera__whoami";

function withFolderStore(cwd, useStore) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  try {
    const { helperDir } = locations();
    const normalized = path.resolve(cwd);
    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    const store = path.join(helperDir, "seen-folders");
    const existing = fs.lstatSync(store, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return false;
    fs.mkdirSync(helperDir, { recursive: true, mode: 0o700 });
    // Opening for reading and writing checks that this store can be used. An
    // empty file is fine: only a successful whoami records a fingerprint.
    const file = fs.openSync(store, "a+", 0o600);
    try {
      const seen = fs.readFileSync(file, "utf8").split("\n");
      return !seen.includes(fingerprint) && useStore(file, fingerprint);
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return false;
  }
}

function needsNotice(cwd) {
  return withFolderStore(cwd, () => true);
}

function successfulIdentity(response) {
  if (!response || response.isError) return false;
  let identity = response.structuredContent ?? response.content ?? response;
  if (Array.isArray(identity)) identity = identity.find((block) => block?.type === "text")?.text;
  if (typeof identity === "string") identity = JSON.parse(identity);
  return typeof identity?.id === "string" && (identity.connection_type === "tool"
    ? typeof identity.name === "string"
    : typeof identity.did === "string");
}

function remember(payload) {
  if (payload?.hook_event_name !== "PostToolUse" || payload.tool_name !== WHOAMI) return;
  if (!successfulIdentity(payload.tool_response)) return;
  withFolderStore(payload.cwd, (file, fingerprint) => {
    fs.appendFileSync(file, fingerprint + "\n");
  });
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      remember(JSON.parse(raw));
    } catch {
      // Identity lookup and session startup should work without this reminder.
    }
  });
}

module.exports = { needsNotice };
