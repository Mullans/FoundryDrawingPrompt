import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CANVAS_CHROME } from "../scripts/constants.mjs";
import { canvasChromeCssClass, normalizeCanvasChrome } from "../scripts/drawing/canvas-chrome.mjs";

const lang = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lang", "en.json"), "utf8")
);

test("normalizeCanvasChrome defaults to checkerboard", () => {
  assert.equal(normalizeCanvasChrome(undefined), CANVAS_CHROME.CHECKERBOARD);
  assert.equal(normalizeCanvasChrome(null), CANVAS_CHROME.CHECKERBOARD);
  assert.equal(normalizeCanvasChrome(""), CANVAS_CHROME.CHECKERBOARD);
  assert.equal(normalizeCanvasChrome("mystery"), CANVAS_CHROME.CHECKERBOARD);
});

test("normalizeCanvasChrome accepts the three chrome values", () => {
  assert.equal(normalizeCanvasChrome(CANVAS_CHROME.WHITE), CANVAS_CHROME.WHITE);
  assert.equal(normalizeCanvasChrome(CANVAS_CHROME.BLACK), CANVAS_CHROME.BLACK);
  assert.equal(normalizeCanvasChrome(CANVAS_CHROME.CHECKERBOARD), CANVAS_CHROME.CHECKERBOARD);
});

test("normalizeCanvasChrome trims and lowercases raw setting strings", () => {
  assert.equal(normalizeCanvasChrome("  White "), CANVAS_CHROME.WHITE);
  assert.equal(normalizeCanvasChrome("BLACK"), CANVAS_CHROME.BLACK);
  assert.equal(normalizeCanvasChrome("Checkerboard"), CANVAS_CHROME.CHECKERBOARD);
});

test("canvasChromeCssClass maps each value to a stable surface class", () => {
  assert.equal(canvasChromeCssClass(CANVAS_CHROME.WHITE), "dp-chrome-white");
  assert.equal(canvasChromeCssClass(CANVAS_CHROME.BLACK), "dp-chrome-black");
  assert.equal(canvasChromeCssClass(CANVAS_CHROME.CHECKERBOARD), "dp-chrome-checkerboard");
  assert.equal(canvasChromeCssClass("nope"), "dp-chrome-checkerboard");
});

test("player and settings Background labels avoid chrome jargon", () => {
  assert.equal(lang["DRAWING-PROMPTS.player.fields.canvasChrome"], "Background");
  assert.equal(lang["DRAWING-PROMPTS.settings.canvasChrome.name"], "Background");
  assert.match(lang["DRAWING-PROMPTS.settings.canvasChrome.hint"], /not included/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.player.fields.canvasChrome"], /chrome/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.settings.canvasChrome.name"], /chrome/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.settings.canvasChrome.hint"], /chrome/i);
});

test("Background choice labels stay plain color names", () => {
  assert.equal(lang["DRAWING-PROMPTS.choices.canvasChrome.white"], "White");
  assert.equal(lang["DRAWING-PROMPTS.choices.canvasChrome.black"], "Black");
  assert.match(lang["DRAWING-PROMPTS.choices.canvasChrome.checkerboard"], /checkerboard/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.choices.canvasChrome.white"], /chrome/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.choices.canvasChrome.black"], /chrome/i);
  assert.doesNotMatch(lang["DRAWING-PROMPTS.choices.canvasChrome.checkerboard"], /chrome/i);
});
