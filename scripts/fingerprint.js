#!/usr/bin/env node
/**
 * Fingerprint a lesson for Nosphera's lesson_added tool.
 *
 * Prints the sha256 hex digest (64 characters) of a lesson's text. The text
 * never leaves this machine: only the digest is sent to Nosphera.
 *
 *   node fingerprint.js --file CLAUDE.md --item <item_id>
 *       Finds the line "- nosphera:<item_id>: <lesson>" in the file and
 *       fingerprints <lesson>.
 *
 *   node fingerprint.js < lesson.txt
 *       Fingerprints the text read from stdin.
 *
 * In both cases the text is trimmed (no leading or trailing whitespace)
 * before hashing, so the same lesson always gives the same fingerprint.
 */

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function fingerprint(text) {
  return createHash("sha256").update(String(text).trim(), "utf8").digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The lesson text for an item in a memory file, or null when the line is missing. */
function findLesson(fileText, itemId) {
  if (!ITEM_ID.test(itemId)) return null;
  const line = new RegExp(`^\\s*[-*]\\s+nosphera:${escapeRegExp(itemId)}:\\s*(.*)$`);
  for (const raw of String(fileText).split(/\r?\n/)) {
    const match = line.exec(raw);
    if (match) return match[1].trim();
  }
  return null;
}

function parseArgs(argv) {
  const args = { file: null, item: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i] ?? null;
    else if (arg === "--item") args.item = argv[++i] ?? null;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else return { error: `Unknown option: ${arg}` };
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node fingerprint.js --file <memory file> --item <item_id>",
    "  node fingerprint.js < lesson.txt",
    "",
    "Prints the sha256 fingerprint of a lesson, for Nosphera's lesson_added tool.",
    "A lesson line in the memory file looks like:  - nosphera:<item_id>: <lesson>",
  ].join("\n");
}

function main(argv, stdinText) {
  const args = parseArgs(argv);
  if (args.error) return { code: 2, stderr: `${args.error}\n${usage()}` };
  if (args.help) return { code: 0, stdout: usage() };
  if (args.file || args.item) {
    if (!args.file || !args.item) return { code: 2, stderr: `Give both --file and --item.\n${usage()}` };
    if (!ITEM_ID.test(args.item)) return { code: 2, stderr: "The item id can only contain letters, digits, - and _." };
    let text;
    try {
      text = readFileSync(args.file, "utf8");
    } catch {
      return { code: 1, stderr: `Could not read ${args.file}.` };
    }
    const lesson = findLesson(text, args.item);
    if (lesson === null) {
      return { code: 1, stderr: `No lesson for item ${args.item} in ${args.file}. Add a line like:\n- nosphera:${args.item}: <what to do differently next time>` };
    }
    if (!lesson) return { code: 1, stderr: `The lesson line for item ${args.item} in ${args.file} is empty.` };
    return { code: 0, stdout: fingerprint(lesson) };
  }
  if (!String(stdinText).trim()) return { code: 1, stderr: `Nothing to fingerprint.\n${usage()}` };
  return { code: 0, stdout: fingerprint(stdinText) };
}

function run() {
  const argv = process.argv.slice(2);
  const wantsStdin = !argv.includes("--file") && !argv.includes("--item") && !argv.includes("-h") && !argv.includes("--help");
  const finish = (stdinText) => {
    const result = main(argv, stdinText);
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exit(result.code);
  };
  if (!wantsStdin) {
    finish("");
    return;
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => finish(raw));
}

if (require.main === module) {
  run();
}

module.exports = { fingerprint, findLesson, main, ITEM_ID };
