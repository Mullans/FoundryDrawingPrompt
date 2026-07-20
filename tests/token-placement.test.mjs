import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACE_MODES,
  buildTokenData,
  clampedTokenPosition,
  pickActorType,
  validatePlaceSelection
} from "../scripts/foundry/token-placement-service.mjs";

test("clampedTokenPosition centers one grid square on the viewport pivot", () => {
  assert.deepEqual(
    clampedTokenPosition({ x: 500, y: 400 }, 100, { width: 1000, height: 800 }),
    { x: 450, y: 350 }
  );
});

test("clampedTokenPosition keeps the token footprint inside scene bounds", () => {
  assert.deepEqual(
    clampedTokenPosition({ x: -20, y: 900 }, 100, { width: 1000, height: 800 }),
    { x: 0, y: 700 }
  );
});

test("buildTokenData creates exact visible TokenDocument data", () => {
  assert.deepEqual(buildTokenData({
    actorId: "actor-1",
    src: "drawing.webp",
    center: { x: 250, y: 175 },
    scene: { width: 1000, height: 800 },
    gridSize: 100
  }), {
    actorId: "actor-1",
    texture: { src: "drawing.webp" },
    width: 1,
    height: 1,
    x: 200,
    y: 125,
    hidden: false
  });
});

test("buildTokenData supports hidden token creation", () => {
  const data = buildTokenData({
    actorId: "actor-2",
    src: "drawing.png",
    center: { x: 50, y: 50 },
    scene: { width: 500, height: 500 },
    gridSize: 100,
    hidden: true
  });

  assert.equal(data.hidden, true);
});

test("pickActorType uses npc for dnd5e", () => {
  assert.equal(pickActorType("dnd5e", ["base", "character"]), "npc");
});

test("pickActorType uses the first non-base type for other systems", () => {
  assert.equal(pickActorType("pf2e", ["base", "character", "npc"]), "character");
  assert.equal(pickActorType("custom", ["base"]), null);
});

test("validatePlaceSelection accepts Tile without extra fields", () => {
  assert.equal(validatePlaceSelection({ mode: PLACE_MODES.TILE }), null);
});

test("validatePlaceSelection requires a name for New Actor", () => {
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.NEW_ACTOR, name: "  " }),
    "nameRequired"
  );
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.NEW_ACTOR, name: "Goblin Sketch" }),
    null
  );
});

test("validatePlaceSelection requires a name and actor UUID for Copy Actor", () => {
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.COPY_ACTOR, name: "", actorUuid: "Actor.source" }),
    "nameRequired"
  );
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.COPY_ACTOR, name: "Copy", actorUuid: "" }),
    "actorRequired"
  );
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.COPY_ACTOR, name: "Copy", actorUuid: "Actor.source" }),
    null
  );
});

test("validatePlaceSelection requires only an actor UUID for Existing Actor", () => {
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.EXISTING_ACTOR, name: "", actorUuid: "" }),
    "actorRequired"
  );
  assert.equal(
    validatePlaceSelection({ mode: PLACE_MODES.EXISTING_ACTOR, name: "", actorUuid: "Actor.existing" }),
    null
  );
});

test("validatePlaceSelection rejects unknown modes", () => {
  assert.equal(validatePlaceSelection({ mode: "surprise" }), "invalidMode");
});
