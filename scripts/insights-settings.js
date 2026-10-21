#!/usr/bin/env node
/**
 * Nosphera Insights settings for Claude Code.
 *
 * Shows the settings that make Claude Code send its usage numbers to Nosphera
 * Insights, compares them with the user's own settings file, and, only when
 * asked to, merges them in. It never removes or rewrites a setting it does not
 * own, never reads what is in the token file, and never sends anything
 * anywhere.
 *
 *   node insights-settings.js show     the settings block for this computer
 *   node insights-settings.js plan     what applying would change, and what is still missing
 *   node insights-settings.js apply    merge the block into the user settings file
 *   node insights-settings.js helper   create the small header helper script (no token inside)
 *   node insights-settings.js token    how to get the agent's token and save it privately
 *
 * Options: --settings <file> (default: the user settings file), --home <dir>,
 * --platform win32|posix (defaults to this computer). Used by the tests.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// From https://nosphera.com/learn/how-to-switch-on-insights. Events only: metrics and
// traces would repeat the same numbers and use up the daily limit.
// Pin the logs overrides and clear old credentials/routing as documented at
// https://code.claude.com/docs/en/monitoring-usage#common-configuration-variables.
// Otherwise a prior logs endpoint could receive the Nosphera helper's token.
const ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://mcp.nosphera.com/otlp",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://mcp.nosphera.com/otlp/v1/logs",
  OTEL_EXPORTER_OTLP_HEADERS: "",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
  BETA_TRACING_ENDPOINT: "",
  OTEL_LOG_ASSISTANT_RESPONSES: "0",
  OTEL_METRICS_INCLUDE_SESSION_ID: "false",
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
  OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
  OTEL_METRICS_INCLUDE_REPOSITORY: "false",
};

// Switches that make Claude Code send content (prompts, tool details, raw API
// bodies). Nosphera drops content on arrival, but the user should know.
const CONTENT_SWITCHES = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
];

// The header helpers from the published Insights setup guide, plus one
// check: when the token file is missing or empty they fail instead of sending
// an empty token, so Claude Code reports "otelHeadersHelper failed" and the
// user finds out.
const HELPER_SH = [
  "#!/bin/sh",
  "# Prints the header Claude Code adds to every OpenTelemetry request.",
  "# Fails on purpose when the token file is missing or empty, so Claude Code reports it.",
  "f=\"$HOME/.config/nosphera/token\"",
  "if [ ! -s \"$f\" ]; then echo \"Nosphera token file missing or empty: $f\" >&2; exit 1; fi",
  "printf '{\"Authorization\":\"Bearer %s\"}\\n' \"$(tr -d ' \\r\\n' < \"$f\")\"",
  "",
].join("\n");

const HELPER_PS1 = [
  "# Prints the header Claude Code adds to every OpenTelemetry request.",
  "# Fails on purpose when the token file is missing or empty, so Claude Code reports it.",
  "$path = \"$env:USERPROFILE\\.nosphera\\token\"",
  "if (-not (Test-Path $path)) { [Console]::Error.WriteLine(\"Nosphera token file missing: $path\"); exit 1 }",
  "$raw = Get-Content -Raw $path",
  "$token = if ($raw) { $raw.Trim() } else { \"\" }",
  "if (-not $token) { [Console]::Error.WriteLine(\"Nosphera token file is empty: $path\"); exit 1 }",
  "'{\"Authorization\":\"Bearer ' + $token + '\"}'",
  "",
].join("\n");

function slashes(value) {
  return value.replace(/\\/g, "/");
}

/** Paths for one computer: where the token, the helper and the settings live. */
function locations({ platform = process.platform, home = os.homedir(), settings = null } = {}) {
  const windows = platform === "win32";
  const dir = windows ? path.join(home, ".nosphera") : path.join(home, ".config", "nosphera");
  const helperFile = path.join(dir, windows ? "otel-headers.ps1" : "otel-headers.sh");
  return {
    windows,
    home,
    settingsFile: settings || path.join(home, ".claude", "settings.json"),
    tokenFile: path.join(dir, "token"),
    helperDir: dir,
    helperFile,
    // What goes into settings.json. Windows runs the helper through PowerShell
    // (the path is quoted so a user folder with a space still works, and
    // -ExecutionPolicy Bypass applies only to this one script run).
    helperSetting: windows
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${slashes(helperFile)}"`
      : helperFile,
    helperContent: windows ? HELPER_PS1 : HELPER_SH,
  };
}

/** The settings block for this computer, as it would appear in settings.json. */
function settingsBlock(loc) {
  return { env: { ...ENV }, otelHeadersHelper: loc.helperSetting };
}

/**
 * Merge the block into existing settings without losing anything. Keys the
 * block does not name are kept as they are; keys it names are added or
 * replaced, and each one is reported.
 */
function plan(existing, block) {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("The settings file does not hold a JSON object, so it can't be merged safely. Nothing was changed.");
  }
  if ("env" in existing && (existing.env === null || typeof existing.env !== "object" || Array.isArray(existing.env))) {
    throw new Error('The "env" setting is not an object, so it can\'t be merged safely. Nothing was changed.');
  }
  const changes = [];
  const warnings = [];
  const env = { ...(existing.env || {}) };
  for (const [key, value] of Object.entries(block.env)) {
    if (!(key in env)) changes.push({ key: `env.${key}`, kind: "add", to: value });
    else if (env[key] !== value) changes.push({ key: `env.${key}`, kind: "change", from: env[key], to: value });
    else changes.push({ key: `env.${key}`, kind: "same", to: value });
    env[key] = value;
  }
  if (!("otelHeadersHelper" in existing)) changes.push({ key: "otelHeadersHelper", kind: "add", to: block.otelHeadersHelper });
  else if (existing.otelHeadersHelper !== block.otelHeadersHelper) changes.push({ key: "otelHeadersHelper", kind: "change", from: existing.otelHeadersHelper, to: block.otelHeadersHelper });
  else changes.push({ key: "otelHeadersHelper", kind: "same", to: block.otelHeadersHelper });

  for (const key of CONTENT_SWITCHES) {
    const value = env[key];
    if (value !== undefined && !["", "0", "false"].includes(String(value).trim().toLowerCase())) {
      warnings.push(`env.${key} is set to ${shown(value)}: Claude Code would send content with its events. Nosphera drops content on arrival, but remove this setting if you don't want it to leave your machine.`);
    }
  }
  for (const key of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) {
    if (existing.env && existing.env[key]) {
      warnings.push(`This setup clears env.${key} so another service's credentials are not sent to Nosphera. The private header helper supplies only the tracking code.`);
    }
  }

  const merged = { ...existing, env, otelHeadersHelper: block.otelHeadersHelper };
  return { merged, changes, warnings, changed: changes.some((change) => change.kind !== "same") };
}

/** A value for printing, with anything that looks like a token hidden. */
function shown(value) {
  return JSON.stringify(value)
    .replace(/(Bearer\s+)[^\s"\\]+/gi, "$1[hidden]")
    .replace(/\b(nsc|nsa)_[A-Za-z0-9_-]+/g, "$1_[hidden]");
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { existing: {}, missing: true };
    throw new Error(`Could not read ${file}. Nothing was changed.`);
  }
  try {
    return { existing: JSON.parse(raw.replace(/^\uFEFF/, "")), missing: false };
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it by hand first; nothing was changed.`);
  }
}

/** The first free backup name next to the settings file; an earlier backup is never overwritten. */
function backupPath(file) {
  const base = `${file}.before-nosphera-insights`;
  if (!fs.existsSync(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!fs.existsSync(`${base}.${n}`)) return `${base}.${n}`;
  }
  throw new Error(`Too many backups next to ${file}. Delete some of the .before-nosphera-insights files first; nothing was changed.`);
}

/** Write the whole file at once: a temporary file first, then renamed over the original. */
function writeSettings(file, text) {
  const temporary = `${file}.nosphera-tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    const reason = error && error.code ? error.code : "unknown error";
    throw new Error(`Could not write ${file} (${reason}). Your settings were not changed.`);
  }
}

function describe(changes) {
  return changes.map((change) => {
    // Static headers can hold arbitrary third-party keys, not just nsc_/Bearer.
    const display = (value) => /_HEADERS$/.test(change.key) && value ? '"[hidden]"' : shown(value);
    if (change.kind === "add") return `+ ${change.key} = ${display(change.to)}`;
    if (change.kind === "change") return `~ ${change.key}: ${display(change.from)} -> ${display(change.to)}`;
    return `= ${change.key} (already set)`;
  });
}

function status(loc) {
  const lines = [];
  lines.push(fs.existsSync(loc.tokenFile)
    ? `Token file: ${loc.tokenFile} (present)`
    : `Token file: ${loc.tokenFile} (missing: run "token" for how to save it)`);
  lines.push(fs.existsSync(loc.helperFile)
    ? `Header helper: ${loc.helperFile} (present)`
    : `Header helper: ${loc.helperFile} (missing: run "helper" to create it)`);
  return lines;
}

function commandShow(loc) {
  return { code: 0, stdout: `${JSON.stringify(settingsBlock(loc), null, 2)}` };
}

function commandPlan(loc) {
  const { existing, missing } = readSettings(loc.settingsFile);
  const result = plan(existing, settingsBlock(loc));
  const lines = [`Settings file: ${loc.settingsFile}${missing ? " (does not exist yet; it would be created)" : ""}`];
  lines.push(result.changed ? "Applying would make these changes (+ added, ~ replaced, = unchanged):" : "Nothing to change: the Insights settings are already in place.");
  lines.push(...describe(result.changes));
  if (!missing) lines.push("Every other setting in the file stays exactly as it is.");
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push(...status(loc));
  return { code: 0, stdout: lines.join("\n") };
}

function commandApply(loc) {
  const { existing, missing } = readSettings(loc.settingsFile);
  const result = plan(existing, settingsBlock(loc));
  const lines = [];
  if (!result.changed) {
    lines.push(`Nothing to change: ${loc.settingsFile} already has the Insights settings.`);
  } else {
    let backup = null;
    if (!missing) {
      backup = backupPath(loc.settingsFile);
      fs.copyFileSync(loc.settingsFile, backup);
    }
    writeSettings(loc.settingsFile, `${JSON.stringify(result.merged, null, 2)}\n`);
    lines.push(`Updated ${loc.settingsFile}:`);
    lines.push(...describe(result.changes.filter((change) => change.kind !== "same")));
    lines.push("Every other setting in the file was kept.");
    if (backup) {
      lines.push(`Backup of the previous file: ${backup}`);
      lines.push("The backup holds everything the file held, including any keys you keep there. Delete it once Claude Code starts cleanly.");
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push(...status(loc));
  lines.push("Restart Claude Code afterwards: it reads these settings only at start.");
  return { code: 0, stdout: lines.join("\n") };
}

function commandHelper(loc) {
  if (fs.existsSync(loc.helperFile)) {
    return { code: 0, stdout: `Header helper already exists: ${loc.helperFile} (left as it is)` };
  }
  try {
    fs.mkdirSync(loc.helperDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(loc.helperFile, loc.helperContent, { encoding: "utf8", mode: 0o700 });
  } catch (error) {
    const reason = error && error.code ? error.code : "unknown error";
    throw new Error(`Could not create ${loc.helperFile} (${reason}). Nothing was changed.`);
  }
  if (!loc.windows) {
    try {
      fs.chmodSync(loc.helperDir, 0o700);
      fs.chmodSync(loc.helperFile, 0o700);
    } catch {
      // Permissions are best effort on file systems that don't support them.
    }
  }
  return {
    code: 0,
    stdout: [
      `Created the header helper: ${loc.helperFile}`,
      "It reads the token from your private token file when Claude Code starts, so the token never sits in settings.json. If that file is missing or empty, Claude Code reports that the helper failed instead of sending anything.",
      `Token file it reads: ${loc.tokenFile}${fs.existsSync(loc.tokenFile) ? " (present)" : " (missing: run \"token\" for how to save it)"}`,
    ].join("\n"),
  };
}

function commandToken(loc) {
  const save = loc.windows
    ? [
      "Windows PowerShell (the code is typed hidden, so it stays off the screen and out of your history):",
      "",
      `  New-Item -ItemType Directory -Force "$env:USERPROFILE\\.nosphera" | Out-Null`,
      `  $secure = Read-Host "Nosphera token" -AsSecureString`,
      `  $token = [System.Net.NetworkCredential]::new("", $secure).Password`,
      `  Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\\.nosphera\\token" $token`,
      `  Remove-Variable token, secure`,
    ]
    : [
      "macOS and Linux (the code is typed hidden, so it stays off the screen and out of your shell history):",
      "",
      "  mkdir -p ~/.config/nosphera && chmod 700 ~/.config/nosphera",
      "  printf 'Nosphera token: '; read -rs NOSPHERA_TOKEN; echo",
      "  printf '%s\\n' \"$NOSPHERA_TOKEN\" > ~/.config/nosphera/token; unset NOSPHERA_TOKEN",
      "  chmod 600 ~/.config/nosphera/token",
    ];
  return {
    code: 0,
    stdout: [
      "Insights uses the agent's own tracking code, starting with nsc_... .",
      "Once active, the code can also write to the agent's public record, so keep it in a private file outside any repository. Never paste it into a chat.",
      "",
      "1. Get the code.",
      "   On nosphera.com open My agents, find the agent's Insights panel, and choose Get tracking code.",
      "   This works for agents connected by signing in too. Getting a tracking code leaves the agent's current sign-in and other codes working.",
      "   Use it within 24 hours: it activates on the first tracking upload, with no MCP step. If it expires before then, get a new one.",
      "   An existing connect code already used over MCP also works. A separate tracking code can be revoked without disconnecting MCP.",
      "",
      `2. Save it to the private file ${loc.tokenFile}.`,
      ...save,
      "",
      "3. Finish the Insights settings and restart Claude Code within 24 hours so its first tracking upload activates the code.",
      "",
      "If the code ever leaks: on nosphera.com, under Settings, Connect codes, choose Revoke next to it. That code stops working at once for MCP and Insights; the agent's other codes and MCP sign-in keep working. Revoking an active code also switches off its A2A sign-in key, which must then be registered again.",
      "Full guide: https://nosphera.com/learn/how-to-switch-on-insights",
    ].join("\n"),
  };
}

function parseArgs(argv) {
  const args = { command: null, settings: null, home: null, platform: null };
  const takeValue = (name, index) => {
    const value = argv[index];
    if (value === undefined || value === "" || value.startsWith("-")) return { error: `${name} needs a value.` };
    return { value };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--settings" || arg === "--home" || arg === "--platform") {
      const taken = takeValue(arg, i + 1);
      if (taken.error) return taken;
      args[arg.slice(2)] = taken.value;
      i += 1;
    } else if (!arg.startsWith("-") && !args.command) {
      args.command = arg;
    } else {
      return { error: `Unknown option: ${arg}` };
    }
  }
  if (args.platform && !["win32", "posix"].includes(args.platform)) return { error: "--platform must be win32 or posix." };
  return args;
}

const USAGE = [
  "Usage: node insights-settings.js <show|plan|apply|helper|token> [--settings <file>] [--home <dir>] [--platform win32|posix]",
  "  show     the settings block for this computer",
  "  plan     what applying would change, and what is still missing",
  "  apply    merge the block into the user settings file (only after the user said yes)",
  "  helper   create the header helper script (holds no token)",
  "  token    how to get the agent's token and save it privately",
].join("\n");

function main(argv) {
  const args = parseArgs(argv);
  if (args.error || !args.command) return { code: 2, stderr: `${args.error || "Give a command."}\n${USAGE}` };
  const loc = locations({
    platform: args.platform === "posix" ? "linux" : args.platform || process.platform,
    home: args.home || os.homedir(),
    settings: args.settings,
  });
  const commands = { show: commandShow, plan: commandPlan, apply: commandApply, helper: commandHelper, token: commandToken };
  const command = commands[args.command];
  if (!command) return { code: 2, stderr: `Unknown command: ${args.command}\n${USAGE}` };
  try {
    return command(loc);
  } catch (error) {
    return { code: 1, stderr: error && error.message ? error.message : String(error) };
  }
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exit(result.code);
}

module.exports = { ENV, CONTENT_SWITCHES, locations, settingsBlock, plan, readSettings, shown, backupPath, main };
