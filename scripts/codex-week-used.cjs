"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { WEEK_MINUTES, sendChanged, sendDue, weekEndpoint, weeklyReading } = require("./week-used-sender.cjs");

const CHUNK = 64 * 1024;
const MAX_TAIL = 4 * 1024 * 1024;
const THREAD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function trackingBlock(config) {
  const block = config.match(/^# BEGIN Nosphera Insights tracking\r?\n([\s\S]*?)^# END Nosphera Insights tracking\r?$/m)?.[1];
  if (!block || !/^notify = /m.test(block)) return null;
  const token = block.match(/^Authorization = "Bearer (nsu_[a-f0-9]{64})"\r?$/m)?.[1];
  const endpoint = block.match(/^endpoint = "([^"\r\n]+\/otlp)\/v1\/metrics"\r?$/m)?.[1];
  const url = weekEndpoint(endpoint);
  return token && url ? { token, url } : null;
}

function datedFolders(folder, pattern) {
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
}

function sessionFile(codexHome, id) {
  const sessions = path.join(codexHome, "sessions");
  for (const year of datedFolders(sessions, /^\d{4}$/)) {
    const yearDir = path.join(sessions, year);
    for (const month of datedFolders(yearDir, /^\d{2}$/)) {
      const monthDir = path.join(yearDir, month);
      for (const day of datedFolders(monthDir, /^\d{2}$/)) {
        const dayDir = path.join(monthDir, day);
        const found = fs.readdirSync(dayDir, { withFileTypes: true }).find((entry) =>
          entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith("-" + id + ".jsonl"));
        if (found) return path.join(dayDir, found.name);
      }
    }
  }
  return null;
}

function weekFromLine(line, now) {
  if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return null;
  const limits = entry.payload.rate_limits;
  if (!limits || (limits.limit_id != null && limits.limit_id !== "codex")) return null;
  const week = [limits.primary, limits.secondary].find((item) => item?.window_minutes === WEEK_MINUTES);
  return weeklyReading(week?.used_percent, week?.resets_at, now);
}

function latestWeek(file, now) {
  const fd = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(fd).size;
    const end = Math.max(0, position - MAX_TAIL);
    let carry = Buffer.alloc(0);
    while (position > end) {
      const length = Math.min(position - end, CHUNK);
      position -= length;
      const chunk = Buffer.alloc(length);
      if (fs.readSync(fd, chunk, 0, length, position) !== length) return null;
      const data = Buffer.concat([chunk, carry]);
      let lineEnd = data.length;
      for (let start = data.lastIndexOf(10, lineEnd - 1); start >= 0;
        start = start === 0 ? -1 : data.lastIndexOf(10, start - 1)) {
        const reading = weekFromLine(data.toString("utf8", start + 1, lineEnd), now);
        if (reading) return reading;
        lineEnd = start;
      }
      carry = data.subarray(0, lineEnd);
    }
    return end === 0 ? weekFromLine(carry.toString("utf8"), now) : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function sendWeek(configFile, event, now = Date.now()) {
  if (event?.type !== "agent-turn-complete" || !THREAD_ID.test(event["thread-id"] ?? "")) return;
  const tracking = trackingBlock(fs.readFileSync(configFile, "utf8"));
  if (!tracking) return;
  const codexHome = path.dirname(configFile);
  const stateFile = path.join(codexHome, "nosphera-week-used-state.json");
  if (!sendDue(stateFile, now)) return;
  const transcript = sessionFile(codexHome, event["thread-id"]);
  const reading = transcript && latestWeek(transcript, now);
  if (reading) await sendChanged(stateFile, tracking, reading, now);
}

if (require.main === module) {
  // Codex starts notify in the background. Treat every error as a dropped
  // reading, and never print the notification or session content.
  Promise.resolve().then(() => sendWeek(process.argv[2], JSON.parse(process.argv[3]))).catch(() => {});
}

module.exports = { latestWeek, sendWeek, trackingBlock, weekFromLine };
