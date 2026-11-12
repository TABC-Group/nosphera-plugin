"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { constants, createPublicKey, publicEncrypt } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { switchOnTracking } = require("./insights-settings");
const { claudeReading, statusText } = require("./claude-week-used.cjs");

// All codes, readings, names and records in this file are TEST ONLY.
const token = "nsu_" + "a".repeat(64);
const resetAt = Math.floor(Date.now() / 1000) + 4 * 86400;
const input = Buffer.from(JSON.stringify({
  rate_limits: { seven_day: { used_percentage: 62, resets_at: resetAt },
    five_hour: { used_percentage: 10, resets_at: resetAt }, spend_limit: { used_usd: 1000 } },
  text: "TEST ONLY content", model: "TEST ONLY model", account: "TEST ONLY account",
}) + "\r\n");
const reading = { used_percent: 62, window_minutes: 10080, resets_at: resetAt };

async function fixture(t, original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosphera-claude-week-test-"));
  const settings = path.join(dir, "settings.json");
  if (original) fs.writeFileSync(settings, JSON.stringify(original));
  const received = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push([request.method, request.url, request.headers.authorization, body && JSON.parse(body)]);
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const oldSite = process.env.NOSPHERA_TRACKING_SITE, oldEndpoint = process.env.NOSPHERA_TRACKING_OTLP_URL;
  process.env.NOSPHERA_TRACKING_SITE = "http://127.0.0.1:3268";
  process.env.NOSPHERA_TRACKING_OTLP_URL = `http://127.0.0.1:${server.address().port}/otlp`;
  t.after(() => {
    if (oldSite === undefined) delete process.env.NOSPHERA_TRACKING_SITE;
    else process.env.NOSPHERA_TRACKING_SITE = oldSite;
    if (oldEndpoint === undefined) delete process.env.NOSPHERA_TRACKING_OTLP_URL;
    else process.env.NOSPHERA_TRACKING_OTLP_URL = oldEndpoint;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function setup(weekly, confirmStatusLine) {
    const result = await switchOnTracking({ app: "claude_code", settings, home: dir }, {
      confirmStatusLine, write() {},
      openBrowser(address) {
        const fields = new URL(address).searchParams;
        assert.equal(fields.get("week"), "ask");
        const port = fields.get("port"), state = fields.get("state"), expires = fields.get("expires");
        const key = createPublicKey({ key: { kty: "RSA", n: fields.get("key"), e: "AQAB" }, format: "jwk" });
        const label = [state, "claude_code", port, expires, ...(weekly ? ["week"] : [])].join(":");
        const sealed = publicEncrypt({
          key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(label),
        }, Buffer.from(token)).toString("base64url");
        const finish = new URL(`http://127.0.0.1:${port}/finish`);
        finish.search = new URLSearchParams({ state, sealed });
        if (weekly) finish.searchParams.set("week", "1");
        void fetch(finish).then((response) => response.text());
      },
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    return JSON.parse(fs.readFileSync(settings, "utf8"));
  }
  return { dir, setup, received };
}

function runStatusLine(command) {
  const script = command.match(/^node "([^"]+)"$/)[1];
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function waitForSend(received) {
  for (let attempt = 0; attempt < 40 && !received.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(received, [["POST", "/otlp/v1/tool-week-used", "Bearer " + token, reading]]);
}

test("only the seven-day status line fields become a reading", () => {
  assert.deepEqual(claudeReading(input, Date.now()), reading);
  assert.equal(claudeReading(Buffer.from("{"), Date.now()), null);
  assert.equal(claudeReading(input, (resetAt + 1) * 1000), null);
});

test("a user can decline a new status line and keeps regular tracking", async (t) => {
  const { setup, received } = await fixture(t, { theme: "test-only" });
  let asked = 0;
  const unchanged = await setup(false, () => { asked += 1; return true; });
  assert.equal(asked, 0);
  assert.equal(unchanged.statusLine, undefined);
  const declined = await setup(true, () => { asked += 1; return false; });
  assert.equal(asked, 1);
  assert.equal(declined.statusLine, undefined);
  assert.equal(declined.theme, "test-only");
  assert.equal(declined.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.deepEqual(received, [["DELETE", "/otlp/v1/tool-week-used", "Bearer " + token, ""]]);
});

test("yes adds just the local weekly line and running setup unchecked removes it", async (t) => {
  const { setup, received } = await fixture(t);
  const yes = await setup(true, () => true);
  const result = await runStatusLine(yes.statusLine.command);
  assert.equal(result.stdout, statusText(reading) + "\n");
  assert.match(result.stdout, /^Week 62% · resets /);
  assert.equal(result.stderr, "");
  await waitForSend(received);
  const after = await setup(false, () => { throw new Error("Should not ask again"); });
  assert.equal(after.statusLine, undefined);
});

test("keeps an existing command's input, output and options and restores it on opt-out", async (t) => {
  const { dir, setup, received } = await fixture(t);
  const custom = path.join(dir, "test-only user status line.cjs").replaceAll("\\", "/");
  fs.writeFileSync(custom, 'const fs = require("node:fs"); process.stdout.write("\\x1b[32m  test-only  \\x1b[0m\\n"); process.stdout.write(fs.readFileSync(0));');
  const original = { type: "command", command: `node "${custom}"`, padding: 3 };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ statusLine: original }));
  const wrapped = await setup(true, () => { throw new Error("An existing line needs no second choice"); });
  assert.equal(wrapped.statusLine.padding, 3);
  assert.notEqual(wrapped.statusLine.command, original.command);
  const result = await runStatusLine(wrapped.statusLine.command);
  assert.equal(result.stdout, "\x1b[32m  test-only  \x1b[0m\n" + input.toString());
  assert.equal(result.stderr, "");
  await waitForSend(received);
  const restored = await setup(false, () => { throw new Error("Should not ask on opt-out"); });
  assert.deepEqual(restored.statusLine, original);
});
