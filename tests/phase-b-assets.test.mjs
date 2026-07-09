import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT_DIR = path.join(ROOT, "scripts");
const TEMPLATE_DIR = path.join(ROOT, "templates");
const LANG_PATH = path.join(ROOT, "lang", "en.json");
const MODULE_JSON = path.join(ROOT, "module.json");

test("ApplicationV2 template part paths exist", () => {
  const scripts = readFiles(SCRIPT_DIR, file => file.endsWith(".mjs"));
  const templatePaths = new Set();

  for ( const file of scripts ) {
    const text = fs.readFileSync(file, "utf8");
    for ( const match of text.matchAll(/template:\s*"([^"]+)"/g) ) templatePaths.add(match[1]);
  }

  assert.deepEqual([...templatePaths].sort(), [
    "modules/drawing-prompts/templates/drawing-prompt-manager.hbs",
    "modules/drawing-prompts/templates/player-drawing-app.hbs",
    "modules/drawing-prompts/templates/player-prompt-list.hbs"
  ]);

  for ( const templatePath of templatePaths ) {
    const relative = templatePath.replace(/^modules\/drawing-prompts\//, "");
    assert.equal(pathExistsCaseSensitive(path.join(ROOT, relative)), true, `${templatePath} should exist with exact case`);
  }
});

test("all module localization keys referenced by scripts, templates, and module.json exist", () => {
  const lang = JSON.parse(fs.readFileSync(LANG_PATH, "utf8"));
  const files = [
    MODULE_JSON,
    ...readFiles(SCRIPT_DIR, file => file.endsWith(".mjs")),
    ...readFiles(TEMPLATE_DIR, file => file.endsWith(".hbs"))
  ];
  const referenced = new Set();
  const ignoredDynamicPrefixes = new Set([
    "DRAWING-PROMPTS.choices.fitMode",
    "DRAWING-PROMPTS.settings",
    "DRAWING-PROMPTS.status"
  ]);

  for ( const file of files ) {
    const text = fs.readFileSync(file, "utf8");
    for ( const match of text.matchAll(/DRAWING-PROMPTS(?:\.[A-Za-z0-9_-]+)+/g) ) {
      if ( ignoredDynamicPrefixes.has(match[0]) ) continue;
      if ( text.slice(match.index + match[0].length, match.index + match[0].length + 2) === ".$" ) continue;
      referenced.add(match[0]);
    }
  }

  const missing = [...referenced].filter(key => !(key in lang)).sort();
  assert.deepEqual(missing, []);
});

/**
 * Recursively read files matching a predicate.
 * @param {string} dir Directory.
 * @param {(file: string) => boolean} predicate Predicate.
 * @returns {string[]}
 */
function readFiles(dir, predicate) {
  if ( !fs.existsSync(dir) ) return [];
  const files = [];
  for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
    const fullPath = path.join(dir, entry.name);
    if ( entry.isDirectory() ) files.push(...readFiles(fullPath, predicate));
    else if ( predicate(fullPath) ) files.push(fullPath);
  }
  return files;
}

/**
 * Check that a path exists and each path segment matches directory casing exactly.
 * @param {string} targetPath Target path.
 * @returns {boolean}
 */
function pathExistsCaseSensitive(targetPath) {
  const parsed = path.parse(targetPath);
  const relativeParts = path.relative(parsed.root, targetPath).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for ( const part of relativeParts ) {
    if ( !fs.existsSync(current) ) return false;
    const entries = fs.readdirSync(current);
    if ( !entries.includes(part) ) return false;
    current = path.join(current, part);
  }

  return fs.existsSync(current);
}
