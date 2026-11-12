"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");

const WEEK_MINUTES = 7 * 24 * 60;
const SEND_INTERVAL = 3 * 60_000;
const TIMEOUT = 4_000;

function weeklyReading(usedPercent, resetAt, now) {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
    || !Number.isSafeInteger(resetAt) || resetAt * 1000 <= now
    || resetAt * 1000 > now + WEEK_MINUTES * 60_000) return null;
  return { used_percent: usedPercent, window_minutes: WEEK_MINUTES, resets_at: resetAt };
}

function weekEndpoint(endpoint) {
  return /^(?:https:\/\/(?:dev-)?mcp\.nosphera\.com|http:\/\/127\.0\.0\.1:[1-9]\d{0,4})\/otlp$/.test(endpoint)
    ? endpoint + "/v1/tool-week-used" : null;
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
}

function sendDue(stateFile, now) {
  return now - (readState(stateFile)?.sentAt ?? 0) >= SEND_INTERVAL;
}

function changeKey(stateFile, token, reading, now) {
  const state = readState(stateFile);
  if (now - state?.sentAt < SEND_INTERVAL) return null;
  const key = createHash("sha256").update(token).update(JSON.stringify(reading)).digest("hex");
  return key === state?.key ? null : key;
}

async function sendChanged(stateFile, { token, url }, reading, now) {
  if (!changeKey(stateFile, token, reading, now)) return;
  const lockFile = stateFile + ".lock";
  // Concurrent sessions share a throttle. An interrupted process cannot
  // leave the lock held past the next send interval.
  if (fs.existsSync(lockFile) && now - fs.statSync(lockFile).mtimeMs >= SEND_INTERVAL) fs.unlinkSync(lockFile);
  const lock = fs.openSync(lockFile, "wx", 0o600);
  try {
    const key = changeKey(stateFile, token, reading, now);
    if (!key) return;
    // A failed attempt is dropped. Only a later change can send again.
    fs.writeFileSync(stateFile, JSON.stringify({ key, sentAt: now }), { mode: 0o600 });
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(reading),
    });
    await response.body?.cancel();
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

module.exports = { WEEK_MINUTES, changeKey, sendChanged, sendDue, weekEndpoint, weeklyReading };
