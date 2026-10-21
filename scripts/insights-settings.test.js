"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { ENV, locations, settingsBlock, plan, shown, backupPath, main } = require("./insights-settings");

const script = path.join(__dirname, "insights-settings.js");
const dir = fs.mkdtempSync(path.join(tmpdir(), "nosphera-insights-"));
const home = path.join(dir, "home");
const settings = path.join(home, ".claude", "settings.json");
const read = () => JSON.parse(fs.readFileSync(settings, "utf8"));
const run = (...args) => main([...args, "--settings", settings, "--home", home]);

try {
  // The block follows Nosphera's published Insights setup guide: events only, no content, Nosphera endpoint.
  assert.deepEqual(ENV, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://mcp.nosphera.com/otlp",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_METRICS_INCLUDE_SESSION_ID: "false",
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
    OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
    OTEL_METRICS_INCLUDE_REPOSITORY: "false",
  });
  assert.ok(!("OTEL_EXPORTER_OTLP_HEADERS" in ENV), "the token never goes into settings.json");

  // Paths differ by platform; the helper setting on Windows runs through PowerShell with a quoted path.
  const win = locations({ platform: "win32", home: "C:\\Users\\me" });
  assert.equal(win.helperSetting, 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/me/.nosphera/otel-headers.ps1"');
  assert.equal(
    locations({ platform: "win32", home: "C:\\Users\\First Last" }).helperSetting,
    'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/First Last/.nosphera/otel-headers.ps1"',
    "a user folder with a space stays one argument",
  );
  assert.equal(win.tokenFile, path.join("C:\\Users\\me", ".nosphera", "token"));
  assert.match(win.helperContent, /\$env:USERPROFILE\\\.nosphera\\token/);
  assert.match(win.helperContent, /Test-Path \$path[\s\S]*exit 1/, "the PowerShell helper fails when the token file is missing");
  assert.match(win.helperContent, /if \(-not \$token\)[\s\S]*exit 1/, "and when it is empty");
  const posix = locations({ platform: "linux", home: "/home/me" });
  assert.equal(posix.helperSetting, path.join("/home/me", ".config", "nosphera", "otel-headers.sh"));
  assert.match(posix.helperContent, /^#!\/bin\/sh/);
  assert.match(posix.helperContent, /\$HOME\/\.config\/nosphera\/token/);
  assert.match(posix.helperContent, /\[ ! -s "\$f" \][\s\S]*exit 1/, "the sh helper fails when the token file is missing or empty");
  for (const loc of [win, posix]) assert.doesNotMatch(loc.helperContent, /nsc_/, "the helper holds no token");

  // Merging: nothing the user already has is lost or rewritten.
  const block = settingsBlock(posix);
  const existing = {
    enabledPlugins: { "nosphera@nosphera-plugins": true },
    permissions: { allow: ["Bash(git status)"] },
    env: { FOO: "bar", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp" },
    model: "opus",
  };
  const result = plan(existing, block);
  assert.ok(result.changed);
  assert.deepEqual(result.merged.enabledPlugins, existing.enabledPlugins);
  assert.deepEqual(result.merged.permissions, existing.permissions);
  assert.equal(result.merged.model, "opus");
  assert.equal(result.merged.env.FOO, "bar", "unrelated env keys stay");
  assert.equal(result.merged.env.OTEL_METRICS_EXPORTER, "none");
  assert.equal(result.merged.otelHeadersHelper, block.otelHeadersHelper);
  assert.deepEqual(Object.keys(result.merged), ["enabledPlugins", "permissions", "env", "model", "otelHeadersHelper"], "existing keys keep their order");
  const byKey = Object.fromEntries(result.changes.map((change) => [change.key, change]));
  assert.equal(byKey["env.OTEL_METRICS_EXPORTER"].kind, "change");
  assert.equal(byKey["env.OTEL_METRICS_EXPORTER"].from, "otlp");
  assert.equal(byKey["env.OTEL_LOGS_EXPORTER"].kind, "same");
  assert.equal(byKey["env.CLAUDE_CODE_ENABLE_TELEMETRY"].kind, "add");
  assert.equal(byKey.otelHeadersHelper.kind, "add");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(existing.env, { FOO: "bar", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp" }, "the input is not mutated");

  // Applying twice changes nothing the second time.
  const again = plan(result.merged, block);
  assert.equal(again.changed, false);
  assert.ok(again.changes.every((change) => change.kind === "same"));

  // Content switches and a stray headers setting are reported, never silently kept quiet.
  const noisy = plan({ env: { OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "0", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" } }, block);
  assert.equal(noisy.warnings.length, 2);
  assert.match(noisy.warnings[0], /OTEL_LOG_USER_PROMPTS/);
  assert.match(noisy.warnings[1], /OTEL_EXPORTER_OTLP_HEADERS/);
  assert.equal(noisy.merged.env.OTEL_EXPORTER_OTLP_HEADERS, "Authorization=Bearer x", "left as it is");

  // Values that are printed never show a token.
  assert.equal(shown('echo {"Authorization":"Bearer nsc_abc123"}'), '"echo {\\"Authorization\\":\\"Bearer [hidden]\\"}"');
  assert.equal(shown("nsa_live_key"), '"nsa_[hidden]"');
  assert.equal(shown("none"), '"none"');

  // Settings that can't be merged safely are refused.
  assert.throws(() => plan([], block), /JSON object/);
  assert.throws(() => plan({ env: "PATH=x" }, block), /"env" setting is not an object/);

  // The commands, against a temporary home.
  assert.match(run("show").stdout, /"OTEL_EXPORTER_OTLP_ENDPOINT": "https:\/\/mcp\.nosphera\.com\/otlp"/);
  assert.match(run("show").stdout, /"otelHeadersHelper": /);

  let out = run("plan");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /does not exist yet; it would be created/);
  assert.match(out.stdout, /\+ env\.CLAUDE_CODE_ENABLE_TELEMETRY = "1"/);
  assert.match(out.stdout, /Token file: .*\(missing/);
  assert.match(out.stdout, /Header helper: .*\(missing/);
  assert.ok(!fs.existsSync(settings), "plan never writes");

  out = run("apply");
  assert.equal(out.code, 0);
  assert.deepEqual(read(), settingsBlock(locations({ home })), "a missing file is created with just the block");
  assert.ok(!fs.existsSync(`${settings}.before-nosphera-insights`), "no backup when there was no file");
  assert.ok(!fs.existsSync(`${settings}.nosphera-tmp`), "no temporary file left behind");
  assert.match(out.stdout, /Restart Claude Code afterwards/);

  out = run("apply");
  assert.match(out.stdout, /Nothing to change/);

  // An existing file with other settings keeps them, and a backup is made first.
  fs.writeFileSync(settings, `${JSON.stringify({ enabledPlugins: { x: true }, env: { FOO: "bar", OTEL_LOGS_EXPORTER: "none" }, otelHeadersHelper: 'echo {"Authorization":"Bearer nsc_oldtoken"}' }, null, 2)}\n`);
  out = run("plan");
  assert.match(out.stdout, /~ env\.OTEL_LOGS_EXPORTER: "none" -> "otlp"/);
  assert.match(out.stdout, /~ otelHeadersHelper: .*Bearer \[hidden\]/);
  assert.doesNotMatch(out.stdout, /nsc_oldtoken/, "an old inline token is never printed");
  assert.match(out.stdout, /Every other setting in the file stays exactly as it is/);
  assert.equal(read().env.OTEL_LOGS_EXPORTER, "none", "plan still never writes");
  out = run("apply");
  assert.equal(out.code, 0);
  assert.doesNotMatch(out.stdout, /nsc_oldtoken/);
  assert.match(out.stdout, /The backup holds everything the file held/);
  const applied = read();
  assert.deepEqual(applied.enabledPlugins, { x: true });
  assert.equal(applied.env.FOO, "bar");
  assert.equal(applied.env.OTEL_LOGS_EXPORTER, "otlp");
  const firstBackup = `${settings}.before-nosphera-insights`;
  assert.equal(JSON.parse(fs.readFileSync(firstBackup, "utf8")).env.OTEL_LOGS_EXPORTER, "none", "the backup is the file as it was");
  assert.match(fs.readFileSync(settings, "utf8"), /\n$/, "ends with a newline");

  // A later apply never overwrites the first backup.
  const firstBackupText = fs.readFileSync(firstBackup, "utf8");
  const edited = read();
  edited.env.OTEL_LOGS_EXPORTER = "console";
  fs.writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`);
  assert.equal(backupPath(settings), `${settings}.before-nosphera-insights.2`);
  out = run("apply");
  assert.match(out.stdout, /before-nosphera-insights\.2/);
  assert.equal(fs.readFileSync(firstBackup, "utf8"), firstBackupText, "the first backup is untouched");
  assert.equal(JSON.parse(fs.readFileSync(`${settings}.before-nosphera-insights.2`, "utf8")).env.OTEL_LOGS_EXPORTER, "console");

  // A broken settings file is never overwritten, and the message is a plain sentence.
  fs.writeFileSync(settings, "{ not json");
  out = run("apply");
  assert.equal(out.code, 1);
  assert.match(out.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(settings, "utf8"), "{ not json");
  fs.writeFileSync(settings, "\uFEFF{}\n");
  assert.equal(run("plan").code, 0, "a byte order mark is fine");

  // A settings path that can't be written gives a plain sentence, not a raw error.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const blocked = main(["apply", "--settings", path.join(blocker, "settings.json"), "--home", home]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /^Could not (write|read) /);
  assert.match(blocked.stderr, /not changed/);

  // The helper script: created once, never overwritten, no token inside.
  const loc = locations({ home });
  out = run("helper");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /Created the header helper/);
  assert.equal(fs.readFileSync(loc.helperFile, "utf8"), loc.helperContent);
  fs.writeFileSync(loc.helperFile, "# my own version\n");
  out = run("helper");
  assert.match(out.stdout, /already exists/);
  assert.equal(fs.readFileSync(loc.helperFile, "utf8"), "# my own version\n");
  assert.match(run("plan").stdout, /Header helper: .*\(present\)/);
  fs.mkdirSync(path.dirname(loc.tokenFile), { recursive: true });
  fs.writeFileSync(loc.tokenFile, "nsc_example\n");
  assert.match(run("plan").stdout, /Token file: .*\(present\)/);
  assert.doesNotMatch(run("plan").stdout, /nsc_example/, "the token is never printed");

  // Token guidance names the sign-in case, hides the typed code on both platforms, and never asks for it in chat.
  out = run("token");
  assert.match(out.stdout, /My agents.*Insights panel.*Get tracking code/);
  assert.match(out.stdout, /agents connected by signing in too/);
  assert.match(out.stdout, /Never paste it into a chat/);
  assert.match(out.stdout, /24 hours: it activates on the first tracking upload, with no MCP step/);
  assert.doesNotMatch(out.stdout, /Regenerate MCP code|tools\/call|whoami/, "tracking setup does not require reconnecting or an MCP activation call");
  assert.doesNotMatch(out.stdout, /\b401\b|display_name/, "plain words, no status codes or field names");
  const winToken = main(["token", "--platform", "win32", "--home", "C:\\Users\\me"]).stdout;
  assert.match(winToken, /Read-Host "Nosphera token" -AsSecureString/);
  assert.match(winToken, /NetworkCredential/);
  assert.match(main(["token", "--platform", "posix", "--home", "/home/me"]).stdout, /read -rs NOSPHERA_TOKEN/);

  // Argument handling: a missing or empty value never falls back to the real settings file.
  assert.equal(main([]).code, 2);
  assert.equal(main(["bogus"]).code, 2);
  assert.equal(main(["plan", "--nope"]).code, 2);
  assert.equal(main(["plan", "--settings"]).code, 2);
  assert.equal(main(["plan", "--settings", ""]).code, 2);
  assert.equal(main(["plan", "--settings", "--home", home]).code, 2);
  assert.equal(main(["plan", "--platform", "mac", "--home", home]).code, 2);

  // As a real process: plan prints, apply writes, a bad file exits 1 without changes.
  const fresh = path.join(dir, "fresh.json");
  const text = execFileSync(process.execPath, [script, "plan", "--settings", fresh, "--home", home], { encoding: "utf8" });
  assert.match(text, /Settings file: .*fresh\.json \(does not exist yet/);
  execFileSync(process.execPath, [script, "apply", "--settings", fresh, "--home", home], { encoding: "utf8" });
  assert.equal(JSON.parse(fs.readFileSync(fresh, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://mcp.nosphera.com/otlp");
  fs.writeFileSync(fresh, "[]");
  const bad = spawnSync(process.execPath, [script, "apply", "--settings", fresh, "--home", home], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSON object/);
  assert.equal(fs.readFileSync(fresh, "utf8"), "[]");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("insights-settings.test.js passed");
