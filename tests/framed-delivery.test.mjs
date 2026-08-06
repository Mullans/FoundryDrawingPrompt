import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { BG_SOURCE, FIT_MODE } from "../scripts/constants.mjs";
import {
  assertBackgroundUnlocked,
  resolvePromptFraming,
  serializeBackgroundForPlayer
} from "../scripts/prompts/framed-delivery.mjs";
import { DrawingPrompt } from "../scripts/prompts/prompt-models.mjs";

beforeEach(() => {
  globalThis.game = { user: { id: "gm1" } };
});

test("DrawingPrompt round-trips Prompt Framing on background", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    canvasWidth: 800,
    canvasHeight: 600,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.FIT_CANVAS,
      naturalWidth: 1200,
      naturalHeight: 900,
      framing: { x: 100, y: 50, width: 400, height: 300 },
      framedPath: "drawing-prompts/staging/p1-framed.webp"
    }
  });

  const roundTrip = DrawingPrompt.fromObject(JSON.parse(JSON.stringify(prompt.toObject())));
  assert.deepEqual(roundTrip.background.framing, { x: 100, y: 50, width: 400, height: 300 });
  assert.equal(roundTrip.background.framedPath, "drawing-prompts/staging/p1-framed.webp");
});

test("resolvePromptFraming defaults to full source when framing is unset", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: 640,
      naturalHeight: 480,
      framing: null,
      framedPath: null
    }
  });

  assert.deepEqual(resolvePromptFraming(prompt), { x: 0, y: 0, width: 640, height: 480 });
});

test("resolvePromptFraming is null for blank prompts", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p2",
    background: {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: null,
      naturalHeight: null,
      framing: null,
      framedPath: null
    }
  });

  assert.equal(resolvePromptFraming(prompt), null);
});

test("assertBackgroundUnlocked rejects fitMode changes after send", () => {
  const current = { fitMode: FIT_MODE.FIT_WIDTH, framing: { x: 0, y: 0, width: 100, height: 100 } };
  assert.throws(
    () => assertBackgroundUnlocked({ fitMode: FIT_MODE.STRETCH }, current, { sentAt: 1000 }),
    /locked/i
  );
});

test("assertBackgroundUnlocked rejects framing changes after send", () => {
  const current = { fitMode: FIT_MODE.FIT_WIDTH, framing: { x: 0, y: 0, width: 100, height: 100 } };
  assert.throws(
    () => assertBackgroundUnlocked({ framing: { x: 10, y: 0, width: 100, height: 100 } }, current, { sentAt: 1000 }),
    /locked/i
  );
});

test("assertBackgroundUnlocked allows non-framing background changes after send", () => {
  const current = { fitMode: FIT_MODE.FIT_WIDTH, framing: { x: 0, y: 0, width: 100, height: 100 } };
  assert.doesNotThrow(() => assertBackgroundUnlocked({ path: "maps/other.webp" }, current, { sentAt: 1000 }));
});

test("serializeBackgroundForPlayer omits GM source metadata", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    canvasWidth: 512,
    canvasHeight: 384,
    sentAt: 500,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/secret-full.webp",
      fitMode: FIT_MODE.FIT_HEIGHT,
      naturalWidth: 2048,
      naturalHeight: 1536,
      framing: { x: 0, y: 0, width: 2048, height: 1536 },
      framedPath: "drawing-prompts/staging/p1-framed.webp"
    }
  });

  const serialized = serializeBackgroundForPlayer(prompt);
  assert.deepEqual(serialized, {
    sourceType: BG_SOURCE.FILE,
    path: "drawing-prompts/staging/p1-framed.webp",
    fitMode: FIT_MODE.STRETCH,
    preFramed: true,
    naturalWidth: 512,
    naturalHeight: 384
  });
  assert.equal(JSON.stringify(serialized).includes("secret-full"), false);
  assert.equal(JSON.stringify(serialized).includes("2048"), false);
});
