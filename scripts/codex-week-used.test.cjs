"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { constants, createPublicKey, publicEncrypt } = require("node:crypto");
const { codexConfig, switchOnTracking } = require("./insights-settings");
const { latestWeek, sendWeek, trackingBlock, weekFromLine } = require("./codex-week-used.cjs");

// All codes, readings, names and records in this file are TEST ONLY.
const token = "nsu_" + "a".repeat(64);
const id = "00000000-0000-4000-8000-000000000158";
const now = Date.now();
const resetsAt = Math.floor(now / 1000) + 4 * 86400;
const window = (used_percent = 62) => ({ used_percent, window_minutes: 10080, resets_at: resetsAt });
const entry = (rate_limits) => JSON.stringify({ type: "event_msg", payload: {
  type: "token_count", rate_limits, text: "TEST ONLY private text",
} });
const notice = { type: "agent-turn-complete", "thread-id": id, "last-assistant-message": "TEST ONLY answer" };

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosphera-week-used-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("reads only the weekly fields from primary or secondary Codex windows", () => {
  for (const slot of ["primary", "secondary"]) {
    assert.deepEqual(weekFromLine(entry({
      [slot]: { ...window(), private: "TEST ONLY" },
      plan_type: "TEST ONLY plan", credits: { balance: "TEST ONLY credits" }, limit_id: "codex",
    }), now), window());
  }
  assert.equal(weekFromLine(entry({ primary: window(101) }), now), null);
  assert.equal(weekFromLine(entry({ primary: { ...window(), resets_at: 1 } }), now), null);
  assert.equal(weekFromLine(entry({ primary: window(), limit_id: "test-only-other-limit" }), now), null);
  assert.equal(weekFromLine(entry({ primary: { ...window(), window_minutes: 300 } }), now), null);
  assert.equal(weekFromLine(JSON.stringify({ type: "response_item", text: entry({ primary: window() }) }), now), null);
});

test("reads the newest valid window across chunk boundaries and ignores chat records", (t) => {
  const file = path.join(temp(t), "test-only.jsonl");
  fs.writeFileSync(file, [
    entry({ primary: window(41) }),
    entry({ primary: window(), plan_type: "x".repeat(100_000) }),
    JSON.stringify({ type: "response_item", text: "TEST ONLY chat" }),
    '{"unfinished":',
  ].join("\n"));
  assert.deepEqual(latestWeek(file, now), window());
});

test("puts the notify command inside a removable block and preserves existing commands", () => {
  const original = '\uFEFFmodel = "test-only"\r\n[projects."test-only"]\r\ntrust_level = "trusted"\r\n';
  const endpoint = "https://mcp.nosphera.com/otlp";
  const command = ["node", "test only.cjs", "test only.toml"];
  const configured = codexConfig(original, endpoint, token, command);
  assert.match(configured, /# BEGIN Nosphera Insights tracking\r\nnotify = \["node","test only.cjs","test only.toml"\]/);
  assert.equal(configured.replace(/^# BEGIN Nosphera Insights tracking[\s\S]*?^# END Nosphera Insights tracking\r\n/m, ""), original);
  assert.equal(codexConfig(configured, endpoint, token, command), configured);
  assert.equal(codexConfig(configured, endpoint, token), codexConfig(original, endpoint, token));
  assert.ok(trackingBlock(configured));
  assert.equal(trackingBlock(codexConfig(configured, endpoint, token)), null);
  const custom = 'notify = ["test-only-notifier"]\n' + original.slice(1);
  assert.equal(codexConfig(custom, endpoint, token, command), null);
  assert.ok(codexConfig(custom, endpoint, token).startsWith(custom));
});

test("loopback approval installs the helper only with a sealed, affirmative tool choice", async (t) => {
  const dir = temp(t);
  const settings = path.join(dir, "config.toml");
  const helper = path.join(dir, "codex-week-used.cjs");
  for (const optedIn of [true, false]) {
    const result = await switchOnTracking({ app: "codex", settings, home: dir }, {
      write() {},
      openBrowser(address) {
        const fields = new URL(address).searchParams;
        assert.equal(fields.get("week"), "ask");
        const port = fields.get("port"), state = fields.get("state"), expires = fields.get("expires");
        const key = createPublicKey({ key: { kty: "RSA", n: fields.get("key"), e: "AQAB" }, format: "jwk" });
        const label = [state, "codex", port, expires, ...(optedIn ? ["week"] : [])].join(":");
        const sealed = publicEncrypt({
          key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(label),
        }, Buffer.from(token)).toString("base64url");
        const finish = new URL(`http://127.0.0.1:${port}/finish`);
        finish.search = new URLSearchParams({ state, sealed });
        if (optedIn) finish.searchParams.set("week", "1");
        void fetch(finish).then((response) => response.text());
      },
    });
    assert.equal(result.code, 0);
    const config = fs.readFileSync(settings, "utf8");
    assert.equal(Boolean(trackingBlock(config)), optedIn);
    if (optedIn) {
      assert.ok(fs.existsSync(helper));
      assert.doesNotMatch(fs.readFileSync(helper, "utf8"), new RegExp(token));
    }
    assert.doesNotMatch(result.stdout, new RegExp(token));
  }
});

test("sends only changed readings, throttles attempts and stops with the block removed", async (t) => {
  const dir = temp(t);
  const settings = path.join(dir, "config.toml");
  const session = path.join(dir, "sessions", "2026", "11", "12");
  fs.mkdirSync(session, { recursive: true });
  const transcript = path.join(session, "rollout-test-only-" + id + ".jsonl");
  const received = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ route: request.url, bearer: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(503).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/otlp`;
  fs.writeFileSync(settings, codexConfig("", endpoint, token, ["test-only-helper"]));
  fs.writeFileSync(transcript, entry({ secondary: window(), credits: { balance: "TEST ONLY" } }) + "\n");
  await sendWeek(settings, notice, now);
  await sendWeek(settings, notice, now + 180_001);
  fs.appendFileSync(transcript, entry({ primary: window(63) }) + "\n");
  await sendWeek(settings, notice, now + 120_000);
  await sendWeek(settings, notice, now + 180_002);
  fs.writeFileSync(settings, codexConfig("", endpoint, token));
  fs.appendFileSync(transcript, entry({ primary: window(65) }) + "\n");
  await sendWeek(settings, notice, now + 360_003);
  assert.deepEqual(received, [62, 63].map((percent) => ({
    route: "/otlp/v1/tool-week-used", bearer: "Bearer " + token, body: window(percent),
  })));
});
