#!/usr/bin/env node
/**
 * Nosphera Insights settings for Claude Code and Codex.
 *
 * Automatic setup waits for browser approval, then saves the settings and
 * the tracking credential without displaying it. The older manual commands
 * remain available for existing installs.
 *
 *   node insights-settings.js setup --app claude_code|codex
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
const { execFileSync, spawn } = require("node:child_process");
const { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
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

const TRACKING_APPS = { claude_code: "Claude Code", codex: "Codex" };
const TRACKING_TIMEOUT = 5 * 60_000;
const OTEL_BEGIN = "# BEGIN Nosphera Insights tracking";
const OTEL_END = "# END Nosphera Insights tracking";
const CONFIG_ERROR = "Could not update your tracking settings. Check that your settings file is writable, then start again.";
const DONE_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; background: Canvas; color: CanvasText; font: 1rem/1.6 system-ui, sans-serif; }
  main { max-width: 34rem; margin: clamp(1.5rem, 8vw, 5rem) auto; padding: 0 1.25rem; }
  h1 { font-size: 1.75rem; line-height: 1.2; }
  ol { padding-inline-start: 1.5rem; }
  li + li { margin-top: .5rem; }
  a { color: LinkText; text-underline-offset: .18em; }
  a:hover, a:active { text-decoration-thickness: .15em; }
  a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
`;
const DONE_STYLE_HASH = createHash("sha256").update(DONE_STYLE).digest("base64");

function trackingDonePage(content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nosphera tracking</title>
  <style>${DONE_STYLE}</style>
  <script>history.replaceState(null, "", "/done")</script>
</head>
<body><main>${content}</main></body>
</html>`;
}

function trackingAddresses() {
  const site = new URL(process.env.NOSPHERA_TRACKING_SITE || "https://nosphera.com");
  const local = site.protocol === "http:" && site.hostname === "127.0.0.1" && site.port;
  const publicSites = {
    "https://nosphera.com": ENV.OTEL_EXPORTER_OTLP_ENDPOINT,
    "https://dev.nosphera.com": "https://dev-mcp.nosphera.com/otlp",
  };
  if (site.username || site.password || site.pathname !== "/" || site.search || site.hash) {
    throw new Error("Use a Nosphera site address for tracking.");
  }
  if (Object.hasOwn(publicSites, site.origin)) return { site, endpoint: publicSites[site.origin] };
  if (local && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/otlp$/.test(process.env.NOSPHERA_TRACKING_OTLP_URL || "")) {
    const endpoint = new URL(process.env.NOSPHERA_TRACKING_OTLP_URL);
    return { site, endpoint: endpoint.href };
  }
  throw new Error("Use a Nosphera site address for tracking.");
}

function codexConfig(existing, endpoint, credential) {
  const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (bom) existing = existing.slice(1);
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  // Mask multiline strings and comments before recognizing headers. An apparent
  // [otel] inside an instruction string is content and must be left alone.
  const masked = existing.replace(/"""(?:\\[\s\S]|[^"\\]|"(?!""))*"""{0,2}|'''[\s\S]*?'''{0,2}|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*/g,
    (value) => value.startsWith('"""') || value.startsWith("'''") || value.startsWith("#")
      ? value.replace(/[^\r\n]/g, value.startsWith("#") ? " " : "~") : value);
  const candidates = new Map([...masked.matchAll(/^[\t ]*(\[\[?)[\t ]*([^\r\n]+?)\]\]?[\t ]*\r?$/gm)]
    .map((header) => [header.index, header]));
  const headers = [];
  let depth = 0;
  for (const line of masked.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (depth === 0 && candidates.has(line.index)) headers.push(candidates.get(line.index));
    // An array value such as ["otel"] can look like a table on its own line.
    for (const token of line[0].match(/"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[\[\]{}]/g) ?? []) {
      if (token === "[" || token === "{") depth += 1;
      if (token === "]" || token === "}") depth -= 1;
    }
  }
  const root = masked.slice(0, headers[0]?.index ?? masked.length);
  if (/^[\t ]*(?:otel|"otel"|'otel')[\t ]*[.=]/m.test(root)) {
    throw new Error("Codex already has inline telemetry settings. Use Other ways in Nosphera to set up tracking.");
  }
  const isOtel = (header) => /^(?:otel|"otel"|'otel')(?:[\t ]*\.|[\t ]*$)/.test(header[2]);
  const ranges = [];
  const marked = [...existing.matchAll(/^# (BEGIN|END) Nosphera Insights tracking\r?$/gm)]
    .filter((marker) => !masked.slice(marker.index, marker.index + marker[0].length).trim());
  if (marked.length) {
    const [begin, end] = marked;
    if (marked.length !== 2 || begin[1] !== "BEGIN" || end[1] !== "END"
      || headers.some((header) => header.index > begin.index && header.index < end.index && !isOtel(header))) {
      throw new Error("Codex already has a tracking block that cannot be updated safely. Use Other ways in Nosphera.");
    }
    ranges.push([begin.index, Math.min(end.index + end[0].length + 1, existing.length)]);
  }
  for (const [index, header] of headers.entries()) {
    if (!isOtel(header) || ranges.some(([start, end]) => header.index > start && header.index < end)) continue;
    const end = headers[index + 1]?.index ?? existing.length;
    // Keep blank lines and comments that precede the next table.
    const lastValue = masked.slice(header.index, end).trimEnd().length + header.index;
    const nextLine = existing.indexOf("\n", lastValue);
    ranges.push([header.index, nextLine === -1 ? existing.length : nextLine + 1]);
  }
  let base = existing;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    base = base.slice(0, start) + base.slice(end);
  }
  const block = [
    OTEL_BEGIN, "[otel]", 'exporter = "none"', 'trace_exporter = "none"', "log_user_prompt = false", "",
    "[otel.metrics_exporter.otlp-http]", "endpoint = " + JSON.stringify(endpoint + "/v1/metrics"),
    'protocol = "binary"', "",
    "[otel.metrics_exporter.otlp-http.headers]", 'Authorization = "Bearer ' + credential + '"',
    OTEL_END, "",
  ].join(newline);
  return bom + base + (base && !base.endsWith("\n") ? newline : "") + block;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function privateWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), ".nosphera-" + randomBytes(12).toString("hex"));
  try {
    fs.writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error(CONFIG_ERROR);
      const system32 = path.join(systemRoot, "System32");
      // Git Bash can put its own whoami.exe ahead of the Windows tool on PATH.
      // Apply the private ACL before writing the credential, even in a shared folder.
      const sid = execFileSync(path.join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true })
        .match(/\bS-1-(?:\d+-)*\d+\b/)?.[0];
      if (!sid) throw new Error(CONFIG_ERROR);
      execFileSync(path.join(system32, "icacls.exe"), [temporary, "/inheritance:r", "/grant:r", "*" + sid + ":F"], { stdio: "ignore", windowsHide: true });
    }
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function automaticSettings(args, app, endpoint) {
  const home = args.home || os.homedir();
  if (app === "codex") {
    const file = args.settings || path.join(args.home ? path.join(home, ".codex") : process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
    const original = readIfPresent(file);
    codexConfig(original?.toString("utf8") || "", endpoint, "");
    return (credential) => {
      const backup = backupSettings(file, original);
      privateWrite(file, codexConfig(original?.toString("utf8") || "", endpoint, credential));
      return backup;
    };
  }
  const file = args.settings || path.join(args.home ? path.join(home, ".claude") : process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
  const loc = locations({ home, settings: file, platform: args.platform === "posix" ? "linux" : args.platform || process.platform });
  const helper = path.join(loc.helperDir, loc.windows ? "tracking-headers.ps1" : "tracking-headers.sh");
  const token = path.join(loc.helperDir, "tracking-token");
  const helperText = loc.windows
    ? HELPER_PS1.replace('"$env:USERPROFILE\\.nosphera\\token"', '(Join-Path $PSScriptRoot "tracking-token")').replace("Get-Content -Raw $path", "Get-Content -Raw -LiteralPath $path")
    : HELPER_SH.replace('"$HOME/.config/nosphera/token"', '"$(dirname -- "$0")/tracking-token"');
  const block = {
    env: { ...ENV, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint + "/v1/logs" },
    otelHeadersHelper: loc.windows
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + slashes(helper) + '"'
      : "'" + helper.replace(/'/g, "'\\''") + "'",
  };
  for (const key of CONTENT_SWITCHES) block.env[key] = "0";
  const original = readIfPresent(file);
  const { existing } = readSettings(file);
  const settings = JSON.stringify(plan(existing, block).merged, null, 2) + "\n";
  return (credential) => {
    const backup = backupSettings(file, original);
    const oldToken = readIfPresent(token);
    privateWrite(helper, helperText);
    if (!loc.windows) fs.chmodSync(helper, 0o700);
    privateWrite(token, credential + "\n");
    try {
      privateWrite(file, settings);
    } catch (error) {
      if (oldToken) privateWrite(token, oldToken);
      else fs.unlinkSync(token);
      throw error;
    }
    return backup;
  };
}

function backupSettings(file, original) {
  const current = readIfPresent(file);
  if (original ? !current?.equals(original) : current) {
    throw new Error("Your settings changed during setup. Start again from your app.");
  }
  if (!original) return null;
  const backup = backupPath(file);
  privateWrite(backup, original);
  return backup;
}

function openTrackingBrowser(url, write) {
  const [program, ...args] = process.platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
    : [process.platform === "darwin" ? "open" : "xdg-open", url];
  let fallbackShown = false;
  const fallback = () => {
    if (fallbackShown) return;
    fallbackShown = true;
    write("Open this address in your browser to finish setup:\n" + url);
  };
  const child = spawn(program, args, { stdio: "ignore", windowsHide: true });
  child.once("error", fallback);
  child.once("exit", (code) => { if (code !== 0) fallback(); });
  child.unref();
}

async function switchOnTracking(args, {
  write = (line) => process.stdout.write(line + "\n"),
  openBrowser = openTrackingBrowser,
  timeout = TRACKING_TIMEOUT,
} = {}) {
  const app = args.app;
  const label = TRACKING_APPS[app];
  if (!Object.hasOwn(TRACKING_APPS, app)) throw new Error("Choose Claude Code or Codex.");
  const { site, endpoint } = trackingAddresses();
  const install = automaticSettings(args, app, endpoint);
  const state = randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let port;
  let expires;
  let timer;
  let completed = false;

  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      resolve(result);
    };
    const server = createServer({ maxHeaderSize: 4096 }, (request, response) => {
      const host = "127.0.0.1:" + port;
      let url;
      try {
        url = new URL(request.url || "/", "http://" + host);
      } catch {
        response.writeHead(404, { Connection: "close" }).end();
        return;
      }
      const supplied = url.searchParams.get("state") || "";
      const sealed = url.searchParams.get("sealed") || "";
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Connection", "close");
      if (completed || Date.now() >= expires || request.method !== "GET" || request.headers.host !== host
        || url.origin !== "http://" + host || url.pathname !== "/finish"
        || !/^[a-zA-Z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(state), Buffer.from(supplied))
        || !/^[a-zA-Z0-9_-]{342}$/.test(sealed)) {
        response.writeHead(404).end();
        return;
      }
      let credential;
      try {
        credential = privateDecrypt({
          key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
          oaepLabel: Buffer.from([state, app, port, expires].join(":")),
        }, Buffer.from(sealed, "base64url")).toString("utf8");
      } catch {
        response.writeHead(404).end();
        return;
      }
      if (!/^(?:nsc_[a-f0-9]{32}|nsu_[a-f0-9]{64})$/.test(credential)) {
        response.writeHead(404).end();
        return;
      }
      completed = true;
      let content;
      let result;
      try {
        const backup = install(credential);
        const restart = "Restart " + label + " to start sending usage numbers.";
        const destination = credential.startsWith("nsu_")
          ? "In My agents, go to Your tools and open your tool’s card."
          : "In My agents, open your agent’s Insights tab.";
        const myAgents = new URL("/my-agents", site);
        const linkedDestination = destination.replace("My agents", `<a href="${myAgents}">My agents</a>`);
        content = `<h1>Tracking settings saved</h1>
<ol>
  <li>${restart}</li>
  <li>Send one prompt.</li>
  <li>${linkedDestination}</li>
</ol>
<p>The first numbers show within about a minute.</p>`;
        const lines = ["Tracking settings saved. " + restart];
        if (backup) lines.push("Previous settings saved to " + backup);
        lines.push(destination);
        result = { code: 0, stdout: lines.join("\n") };
      } catch {
        content = `<h1>${CONFIG_ERROR}</h1>`;
        result = { code: 1, stderr: CONFIG_ERROR };
      }
      response.writeHead(result.code === 0 ? 200 : 500, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'sha256-${DONE_STYLE_HASH}'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(trackingDonePage(content), () => finish(result));
    });
    server.once("error", () => finish({ code: 1, stderr: "Could not start tracking setup on this computer. Try again from your app." }));
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      expires = Date.now() + timeout;
      const url = new URL("/my-agents/tracking", site);
      url.search = new URLSearchParams({
        app, port: String(port), state, key: publicKey.export({ format: "jwk" }).n, expires: String(expires),
      }).toString();
      timer = setTimeout(() => finish({ code: 1, stderr: "The tracking setup link expired. Start again from your app." }), timeout);
      write("Finish switching on tracking in your browser.");
      openBrowser(url.href, write);
    });
  });
}

function parseArgs(argv) {
  const args = { command: null, settings: null, home: null, platform: null, app: null };
  const takeValue = (name, index) => {
    const value = argv[index];
    if (value === undefined || value === "" || value.startsWith("-")) return { error: `${name} needs a value.` };
    return { value };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--settings" || arg === "--home" || arg === "--platform" || arg === "--app") {
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
  "  setup --app claude_code|codex   switch on tracking after browser approval",
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
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const result = args.command === "setup"
    ? switchOnTracking(args).catch((error) => ({
      code: 1,
      stderr: /^(Use a Nosphera site|Choose Claude Code|Codex already has)/.test(error.message) ? error.message : CONFIG_ERROR,
    }))
    : main(argv);
  Promise.resolve(result).then(({ code, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout + "\n");
    if (stderr) process.stderr.write(stderr + "\n");
    process.exitCode = code;
  });
}

module.exports = { ENV, CONTENT_SWITCHES, locations, settingsBlock, plan, readSettings, shown, backupPath, main, codexConfig, switchOnTracking };
