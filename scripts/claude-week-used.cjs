"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { changeKey, sendChanged, weekEndpoint, weeklyReading } = require("./week-used-sender.cjs");

function originalShell() {
  if (process.platform !== "win32") {
    const shell = process.env.SHELL;
    return [shell && /\/(?:sh|bash|zsh|dash|ksh)$/.test(shell) ? shell : "/bin/sh", "-c"];
  }
  const where = path.join(process.env.SystemRoot || "C:/Windows", "System32", "where.exe");
  let git = [];
  try { git = execFileSync(where, ["git.exe"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/); } catch {}
  const bash = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    ...git.map((file) => path.resolve(path.dirname(file), "../bin/bash.exe")),
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
      .filter(Boolean).map((folder) => path.join(folder, "Git", "bin", "bash.exe")),
  ].find((file) => file && fs.existsSync(file));
  return bash ? [bash, "-c"] : ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
}

function claudeReading(input, now) {
  let week;
  try { week = JSON.parse(input).rate_limits?.seven_day; } catch { return null; }
  return weeklyReading(week?.used_percentage, week?.resets_at, now);
}

function statusText(reading) {
  const reset = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(reading.resets_at * 1000)).replace(",", "");
  return `Week ${Math.round(reading.used_percent)}% · resets ${reset}`;
}

function configured(descriptor) {
  const settings = JSON.parse(fs.readFileSync(descriptor.settingsFile, "utf8").replace(/^\uFEFF/, ""));
  if (settings.statusLine?.command !== descriptor.command) return null;
  const url = weekEndpoint(settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT);
  const token = fs.readFileSync(path.join(__dirname, "tracking-token"), "utf8").trim();
  return url && /^nsu_[a-f0-9]{64}$/.test(token) ? { url, token } : null;
}

function runOriginal(descriptor, input) {
  const [shell, ...args] = descriptor.shell;
  const child = spawn(shell, [...args, descriptor.original.command], {
    stdio: ["pipe", "inherit", "inherit"], windowsHide: true,
  });
  child.once("error", () => { process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
  child.stdin.on("error", () => {}); // Some status lines ignore stdin.
  child.stdin.end(input);
}

function sendInBackground(descriptor, reading, now) {
  const connection = configured(descriptor);
  const state = path.join(__dirname, "claude-week-used-state.json");
  if (!connection || !changeKey(state, connection.token, reading, now)) return;
  const child = spawn(process.execPath, [__filename, "send"], {
    detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(reading));
  child.unref();
}

async function main() {
  const descriptor = JSON.parse(fs.readFileSync(path.join(__dirname, "claude-week-used-settings.json"), "utf8"));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  const now = Date.now();
  if (process.argv[2] === "send") {
    const value = JSON.parse(input);
    const reading = weeklyReading(value.used_percent, value.resets_at, now);
    const connection = configured(descriptor);
    if (reading && connection) {
      await sendChanged(path.join(__dirname, "claude-week-used-state.json"), connection, reading, now);
    }
    return;
  }

  // Pass the exact input to the original command, with its own stdout and
  // stderr connected directly to Claude Code.
  if (descriptor.original) runOriginal(descriptor, input);
  const reading = claudeReading(input, now);
  if (!reading) return;
  if (!descriptor.original) process.stdout.write(statusText(reading) + "\n");
  sendInBackground(descriptor, reading, now);
}

if (require.main === module) main().catch(() => {});

module.exports = { claudeReading, originalShell, statusText };
