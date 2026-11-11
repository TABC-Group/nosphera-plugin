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
  // Nosphera's settings plus explicit routing/credential overrides for existing OTel configurations.
  assert.deepEqual(ENV, {
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
  });
  assert.equal(ENV.OTEL_EXPORTER_OTLP_HEADERS, "", "static credentials are cleared, never stored in settings.json");
  assert.equal(ENV.OTEL_EXPORTER_OTLP_LOGS_HEADERS, "");

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

  // Content switches are reported; old static credentials are cleared, with a warning.
  const noisy = plan({ env: { OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "0", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" } }, block);
  assert.equal(noisy.warnings.length, 2);
  assert.match(noisy.warnings[0], /OTEL_LOG_USER_PROMPTS/);
  assert.match(noisy.warnings[1], /OTEL_EXPORTER_OTLP_HEADERS/);
  assert.equal(noisy.merged.env.OTEL_EXPORTER_OTLP_HEADERS, "", "old credentials are not sent to Nosphera");

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
  fs.writeFileSync(settings, `${JSON.stringify({
    enabledPlugins: { x: true },
    env: {
      FOO: "bar",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example.test/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=example-old-generic-key",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-api-key=example-old-logs-key",
      BETA_TRACING_ENDPOINT: "https://collector.example.test/beta",
      ENABLE_BETA_TRACING_DETAILED: "1",
    },
    otelHeadersHelper: 'echo {"Authorization":"Bearer nsc_oldtoken"}',
  }, null, 2)}\n`);
  out = run("plan");
  assert.match(out.stdout, /~ env\.OTEL_LOGS_EXPORTER: "none" -> "otlp"/);
  assert.match(out.stdout, /~ otelHeadersHelper: .*Bearer \[hidden\]/);
  assert.doesNotMatch(out.stdout, /nsc_oldtoken/, "an old inline token is never printed");
  assert.match(out.stdout, /~ env\.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https:\/\/collector\.example\.test\/v1\/logs" -> "https:\/\/mcp\.nosphera\.com\/otlp\/v1\/logs"/);
  assert.match(out.stdout, /~ env\.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc" -> "http\/json"/);
  assert.match(out.stdout, /~ env\.OTEL_EXPORTER_OTLP_LOGS_HEADERS: "\[hidden\]" -> ""/);
  assert.doesNotMatch(out.stdout, /example-old-(generic|logs)-key/, "third-party credentials stay hidden in the plan");
  assert.match(out.stdout, /Every other setting in the file stays exactly as it is/);
  assert.equal(read().env.OTEL_LOGS_EXPORTER, "none", "plan still never writes");
  assert.equal(read().env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "https://collector.example.test/v1/logs", "the endpoint changes only when apply is requested");
  out = run("apply");
  assert.equal(out.code, 0);
  assert.doesNotMatch(out.stdout, /nsc_oldtoken/);
  assert.doesNotMatch(out.stdout, /example-old-(generic|logs)-key/, "apply output also hides third-party credentials");
  assert.match(out.stdout, /The backup holds everything the file held/);
  const applied = read();
  assert.deepEqual(applied.enabledPlugins, { x: true });
  assert.equal(applied.env.FOO, "bar");
  assert.equal(applied.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(applied.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "https://mcp.nosphera.com/otlp/v1/logs", "the helper's token cannot go to the old logs endpoint");
  assert.equal(applied.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, "http/json");
  assert.equal(applied.env.OTEL_EXPORTER_OTLP_HEADERS, "");
  assert.equal(applied.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, "");
  assert.equal(applied.env.BETA_TRACING_ENDPOINT, "", "detailed beta tracing cannot redirect logs to the old collector");
  assert.equal(applied.env.ENABLE_BETA_TRACING_DETAILED, "1", "unrelated settings are preserved");
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

async function testBrowserSetup() {
  const { constants, createHash, createPublicKey, publicEncrypt, randomBytes } = require("node:crypto");
  const { switchOnTracking, codexConfig } = require("./insights-settings");
  const isolated = fs.mkdtempSync(path.join(tmpdir(), "nosphera-browser-setup-"));
  const toolCredential = "nsu_" + "a".repeat(64); // TEST ONLY
  const agentCredential = "nsc_" + "a".repeat(32); // TEST ONLY
  const codex = path.join(isolated, "config.toml");
  const claude = path.join(isolated, "settings.json");
  const unrelated = 'model = "test"\r\nexamples = [\r\n  ["otel"]\r\n]\r\n[profiles.work]\r\ninstructions = """\r\n[otel]\r\n# BEGIN Nosphera Insights tracking\r\n"""\r\n';
  const oldOtel = '\r\n[otel]\r\nexporter = "none"\r\n[otel.metrics_exporter.otlp-http]\r\nendpoint = "https://old.example.test"\r\n';
  const original = unrelated + oldOtel;
  const oldClaude = '{"theme":"dark","env":{"OTEL_LOG_TOOL_CONTENT":"1","MY_SETTING":"kept"}}';
  fs.writeFileSync(codex, original);
  fs.writeFileSync(claude, oldClaude);
  const results = [];
  const originalPath = process.env.PATH;
  const originalSite = process.env.NOSPHERA_TRACKING_SITE;
  try {
    if (process.platform === "win32") {
      // Stand-ins that reject the Windows arguments used by tracking setup.
      const shadow = path.join(isolated, "shadow-bin");
      fs.mkdirSync(shadow);
      const standIn = path.join(process.env.SystemRoot, "System32", "where.exe");
      for (const name of ["whoami.exe", "icacls.exe"]) {
        fs.copyFileSync(standIn, path.join(shadow, name));
      }
      process.env.PATH = [shadow, originalPath].join(path.delimiter);
      const lookup = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
      assert.ifError(lookup.error);
      assert.notEqual(lookup.status, 0, "a bare whoami.exe call hits the stand-in");
    }
    for (const { app, settings, credential, origin, label, destination, fail } of [
      {
        app: "codex", settings: codex, credential: agentCredential, origin: "https://dev.nosphera.com",
        label: "Codex", destination: "In My agents, open your agent’s Insights tab.",
      },
      {
        app: "claude_code", settings: claude, credential: toolCredential, origin: "https://nosphera.com",
        label: "Claude Code", destination: "In My agents, go to Your tools and open your tool’s card.",
      },
      {
        app: "codex", settings: codex, credential: agentCredential, origin: "https://dev.nosphera.com", fail: true,
      },
    ]) {
      process.env.NOSPHERA_TRACKING_SITE = origin;
      const before = fs.readFileSync(settings, "utf8");
      let opened;
      const browser = new Promise((resolve) => { opened = resolve; });
      const finished = switchOnTracking({ app, settings, home: isolated }, {
        openBrowser: opened, write: (line) => results.push(line), timeout: 5000,
      });
      const page = new URL(await browser);
      assert.equal(page.origin, origin);
      assert.equal(page.pathname, "/my-agents/tracking");
      const { port, state, key, expires } = Object.fromEntries(page.searchParams);
      const callback = new URL("http://127.0.0.1:" + port + "/finish");
      const seal = publicEncrypt({
        key: createPublicKey({ key: { kty: "RSA", n: key, e: "AQAB" }, format: "jwk" }),
        padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
        oaepLabel: Buffer.from([state, app, port, expires].join(":")),
      }, Buffer.from(credential)).toString("base64url");
      callback.search = new URLSearchParams({ state: randomBytes(32).toString("base64url"), sealed: seal });
      assert.equal((await fetch(callback)).status, 404);
      callback.search = new URLSearchParams({ state, sealed: randomBytes(256).toString("base64url") });
      assert.equal((await fetch(callback)).status, 404);
      assert.equal(fs.readFileSync(settings, "utf8"), before);
      if (fail) fs.appendFileSync(settings, "# Changed while setup was open\n");
      callback.searchParams.set("sealed", seal);
      const response = await fetch(callback);
      assert.equal(response.status, fail ? 500 : 200);
      const html = await response.text();
      assert.ok(!html.includes(credential));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
      const styleHash = createHash("sha256").update(css).digest("base64");
      assert.equal(response.headers.get("content-security-policy"),
        `default-src 'none'; script-src 'unsafe-inline'; style-src 'sha256-${styleHash}'; frame-ancestors 'none'`);
      assert.match(css, /color-scheme: light dark/);
      assert.ok(html.includes('history.replaceState(null, "", "/done")'));
      const done = await finished;
      assert.ok(!JSON.stringify(done).includes(credential));
      await assert.rejects(fetch(callback));
      if (fail) {
        assert.equal(done.code, 1);
        assert.match(done.stderr, /Could not update your tracking settings/);
        assert.ok(html.includes(`<h1>${done.stderr}</h1>`));
        assert.doesNotMatch(html, /<ol>|<a href=/);
        assert.equal(fs.readFileSync(settings, "utf8"), before + "# Changed while setup was open\n");
        fs.writeFileSync(settings, before);
        continue;
      }
      assert.equal(done.code, 0);
      assert.match(html, /<h1>Tracking settings saved<\/h1>/);
      assert.ok(html.includes(`<li>Restart ${label} to start sending usage numbers.</li>`));
      assert.ok(html.includes("<li>Send one prompt.</li>"));
      assert.ok(html.includes(`<li>${destination.replace("My agents", `<a href="${origin}/my-agents">My agents</a>`)}</li>`));
      assert.match(html, /The first numbers show within about a minute/);
      assert.equal(done.stdout.split("\n").at(-1), destination);
      assert.equal(fs.readFileSync(settings + ".before-nosphera-insights", "utf8"), before);
    }
    const next = fs.readFileSync(codex, "utf8");
    assert.ok(next.startsWith(unrelated));
    assert.equal(next.split("[otel]").length, 3, "one real table plus one in the instruction string");
    assert.ok(next.includes("Bearer " + agentCredential));
    assert.ok(!next.includes("https://old.example.test"));
    assert.equal(codexConfig(next, "https://dev-mcp.nosphera.com/otlp", agentCredential), next);
    const claudeSettings = JSON.parse(fs.readFileSync(claude, "utf8"));
    assert.equal(claudeSettings.theme, "dark");
    assert.equal(claudeSettings.env.MY_SETTING, "kept");
    assert.equal(claudeSettings.env.OTEL_LOG_TOOL_CONTENT, "0");
    assert.ok(!JSON.stringify(claudeSettings).includes(toolCredential));
    const token = path.join(locations({ home: isolated }).helperDir, "tracking-token");
    assert.ok(fs.readFileSync(token, "utf8").trim() === toolCredential);
    if (process.platform !== "win32") assert.equal(fs.statSync(token).mode & 0o777, 0o600);
    assert.ok(!results.join("").includes(agentCredential));
    assert.ok(!results.join("").includes(toolCredential));
    const unused = path.join(isolated, "unused.toml");
    const timedOut = await switchOnTracking({ app: "codex", settings: unused, home: isolated }, {
      openBrowser: () => {}, write: () => {}, timeout: 25,
    });
    assert.match(timedOut.stderr, /link expired/);
    assert.ok(!fs.existsSync(unused));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSite === undefined) delete process.env.NOSPHERA_TRACKING_SITE;
    else process.env.NOSPHERA_TRACKING_SITE = originalSite;
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

testBrowserSetup().then(() => {
  console.log("insights-settings.test.js passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
