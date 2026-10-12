"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { fingerprint, findLesson, main, ITEM_ID } = require("./fingerprint");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ITEM = "0f1e2d3c-4b5a-4697-8877-665544332211";
const LESSON = "Run the full test suite before merging; the smoke test alone missed the migration.";

// The digest is the plain sha256 of the trimmed text, so it can be checked with any tool.
assert.equal(fingerprint(LESSON), sha256(LESSON));
assert.equal(fingerprint(`  ${LESSON}\n`), sha256(LESSON), "surrounding whitespace never changes the fingerprint");
assert.match(fingerprint("x"), /^[0-9a-f]{64}$/);
assert.notEqual(fingerprint("a"), fingerprint("b"));

// Finding the lesson line in a memory file.
const memory = [
  "# Project notes",
  "",
  "## Lessons from Nosphera",
  "",
  `- nosphera:${ITEM}: ${LESSON}`,
  "* nosphera:other-item: Use the other form too.",
  "- nosphera:empty-item:",
  "",
  "Unrelated text mentioning nosphera:" + ITEM + ": inside a paragraph is not a lesson line.",
].join("\r\n");
assert.equal(findLesson(memory, ITEM), LESSON);
assert.equal(findLesson(memory, "other-item"), "Use the other form too.");
assert.equal(findLesson(memory, "empty-item"), "");
assert.equal(findLesson(memory, "missing-item"), null);
assert.equal(findLesson(memory, "../../etc"), null, "an item id with odd characters never matches");
assert.ok(ITEM_ID.test(ITEM));
assert.ok(!ITEM_ID.test("a b"));

// The command-line behaviour, through main().
const dir = mkdtempSync(path.join(tmpdir(), "nosphera-fingerprint-"));
try {
  const file = path.join(dir, "CLAUDE.md");
  writeFileSync(file, memory);
  assert.deepEqual(main(["--file", file, "--item", ITEM], ""), { code: 0, stdout: sha256(LESSON) });
  assert.equal(main(["--file", file, "--item", "missing-item"], "").code, 1);
  assert.match(main(["--file", file, "--item", "missing-item"], "").stderr, /- nosphera:missing-item: /, "tells the agent the line to add");
  assert.equal(main(["--file", file, "--item", "empty-item"], "").code, 1);
  assert.equal(main(["--file", path.join(dir, "nope.md"), "--item", ITEM], "").code, 1);
  assert.equal(main(["--file", file], "").code, 2, "both options are needed");
  assert.equal(main(["--item", "x y"], "").code, 2);
  assert.equal(main(["--bogus"], "").code, 2);
  assert.equal(main(["--help"], "").code, 0);
  assert.deepEqual(main([], `${LESSON}\n`), { code: 0, stdout: sha256(LESSON) });
  assert.equal(main([], "   \n").code, 1, "empty stdin is an error, not an empty-string fingerprint");

  // Real processes: file mode, stdin mode, and the exit code on a missing line.
  const script = path.join(__dirname, "fingerprint.js");
  assert.equal(execFileSync(process.execPath, [script, "--file", file, "--item", ITEM], { encoding: "utf8" }).trim(), sha256(LESSON));
  assert.equal(execFileSync(process.execPath, [script], { input: LESSON, encoding: "utf8" }).trim(), sha256(LESSON));
  const missing = spawnSync(process.execPath, [script, "--file", file, "--item", "missing-item"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /No lesson for item missing-item/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("fingerprint.test.js passed");
