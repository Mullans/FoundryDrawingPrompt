import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildPromptAssetPath,
  createPathProvider,
  isForge,
  normalizePath,
  resolvePromptAssetLocation
} from "../scripts/foundry/path-provider.mjs";
import {
  defaultAssetFolder,
  pendingDir,
  stagingDir
} from "../scripts/prompts/asset-service.mjs";

const originalForgeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ForgeVTT");
const originalGameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "game");

afterEach(() => {
  if ( originalForgeDescriptor ) Object.defineProperty(globalThis, "ForgeVTT", originalForgeDescriptor);
  else delete globalThis.ForgeVTT;
  if ( originalGameDescriptor ) Object.defineProperty(globalThis, "game", originalGameDescriptor);
  else delete globalThis.game;
});

test("normalizePath uses forward slashes and removes edge slashes", () => {
  assert.equal(normalizePath("/worlds\\test\\drawing-prompts/"), "worlds/test/drawing-prompts");
});

test("local paths default below the current world", () => {
  const paths = createPathProvider({ forge: false, worldId: "test-world", settingValue: "" });

  assert.equal(paths.base, "worlds/test-world/drawing-prompts");
});

test("Forge paths default below a world-specific shared assets root", () => {
  const paths = createPathProvider({ forge: true, worldId: "test-world", settingValue: "" });

  assert.equal(paths.base, "drawing-prompts/test-world");
});

test("configured asset folders override both local and Forge defaults", () => {
  assert.equal(createPathProvider({
    forge: false,
    worldId: "test-world",
    settingValue: "/custom\\assets/"
  }).base, "custom/assets");
  assert.equal(createPathProvider({
    forge: true,
    worldId: "test-world",
    settingValue: "/forge\\assets/"
  }).base, "forge/assets");
});

test("derived paths are normalized below the provider base", () => {
  const paths = createPathProvider({
    forge: false,
    worldId: "test-world",
    settingValue: "/custom\\assets/"
  });

  assert.equal(paths.staging(), "custom/assets/staging");
  assert.equal(paths.pending("assignment-1"), "custom/assets/pending/assignment-1");
  assert.equal(paths.promptAssets("2026-07-19-draw-a-dragon-a1b2"), "custom/assets/2026-07-19-draw-a-dragon-a1b2");
});

test("pending paths preserve the legacy fallback for missing assignment ids", () => {
  const paths = createPathProvider({ forge: false, worldId: "test-world", settingValue: "" });

  assert.equal(paths.pending(), "worlds/test-world/drawing-prompts/pending/assignment");
  assert.equal(paths.pending(""), "worlds/test-world/drawing-prompts/pending/assignment");
});

test("pending paths reject assignment ids that are not safe single segments", () => {
  const paths = createPathProvider({ forge: false, worldId: "test-world", settingValue: "" });

  for ( const assignmentId of [".", "..", "parent/child", "parent\\child"] ) {
    assert.throws(() => paths.pending(assignmentId), TypeError, assignmentId);
  }
});

test("prompt asset paths reject folder names that are not safe single segments", () => {
  const paths = createPathProvider({ forge: false, worldId: "test-world", settingValue: "" });

  for ( const promptFolderName of [undefined, "", ".", "..", "parent/child", "parent\\child"] ) {
    assert.throws(() => paths.promptAssets(promptFolderName), TypeError, String(promptFolderName));
  }
});

test("isForge detects ForgeVTT lazily at each call", () => {
  delete globalThis.ForgeVTT;
  assert.equal(isForge(), false);

  globalThis.ForgeVTT = { usingTheForge: true };
  assert.equal(isForge(), true);

  globalThis.ForgeVTT.usingTheForge = false;
  assert.equal(isForge(), false);
});

test("asset-service delegates runtime paths through lazy Forge detection", () => {
  let settingValue = "";
  globalThis.game = {
    settings: { get: () => settingValue },
    world: { id: "runtime-world" }
  };

  delete globalThis.ForgeVTT;
  assert.equal(defaultAssetFolder(), "worlds/runtime-world/drawing-prompts");

  globalThis.ForgeVTT = { usingTheForge: true };
  assert.equal(defaultAssetFolder(), "drawing-prompts/runtime-world");
  assert.equal(stagingDir(), "drawing-prompts/runtime-world/staging");
  assert.equal(pendingDir("assignment-2"), "drawing-prompts/runtime-world/pending/assignment-2");
  assert.equal(
    buildPromptAssetPath("drawing-prompts/runtime-world", "prompt-folder"),
    "drawing-prompts/runtime-world/prompt-folder"
  );

  settingValue = "/configured\\root/";
  assert.equal(defaultAssetFolder(), "configured/root");
});

test("resolvePromptAssetLocation combines the chosen parent and prompt folder exactly once", () => {
  assert.deepEqual(resolvePromptAssetLocation({
    selectedParent: "/custom/assets/",
    rememberedParent: "worlds/test/drawing-prompts",
    defaultParent: "fallback",
    promptFolderName: "2026-07-19-draw-a-dragon-a1b2"
  }), {
    parent: "custom/assets",
    final: "custom/assets/2026-07-19-draw-a-dragon-a1b2"
  });
});

test("resolvePromptAssetLocation is idempotent for resaves and another assignment of the same prompt", () => {
  const promptFolderName = "2026-07-19-draw-a-dragon-a1b2";
  const final = `custom/assets/${promptFolderName}`;
  assert.deepEqual(resolvePromptAssetLocation({ assignmentFolder: final, promptFolderName }), {
    parent: "custom/assets",
    final
  });
  assert.deepEqual(resolvePromptAssetLocation({ rememberedParent: "custom/assets", promptFolderName }), {
    parent: "custom/assets",
    final
  });
  assert.deepEqual(resolvePromptAssetLocation({ rememberedParent: final, promptFolderName }), {
    parent: "custom/assets",
    final
  });
});

test("a new prompt using the remembered parent is a sibling of the previous prompt", () => {
  const location = resolvePromptAssetLocation({
    rememberedParent: "custom/assets",
    promptFolderName: "2026-07-20-draw-a-door-z9y8"
  });
  assert.equal(location.final, "custom/assets/2026-07-20-draw-a-door-z9y8");
  assert.equal(location.parent, "custom/assets");
});

test("an explicitly selected parent relocates a resave while retaining the stored prompt folder", () => {
  assert.deepEqual(resolvePromptAssetLocation({
    selectedParent: "new-parent",
    assignmentFolder: "old-parent/2026-07-19-draw-a-dragon-a1b2",
    promptFolderName: "2026-07-19-draw-a-dragon-a1b2"
  }), {
    parent: "new-parent",
    final: "new-parent/2026-07-19-draw-a-dragon-a1b2"
  });
});
