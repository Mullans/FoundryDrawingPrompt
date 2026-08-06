import assert from "node:assert/strict";
import { test } from "node:test";

import { CANVAS_CHROME } from "../scripts/constants.mjs";
import { canvasChromeCssClass, normalizeCanvasChrome } from "../scripts/drawing/canvas-chrome.mjs";

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
