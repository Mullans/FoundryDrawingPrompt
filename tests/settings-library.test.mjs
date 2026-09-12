import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base
} } };

const { MODULE_ID, SETTINGS } = await import("../scripts/constants.mjs");
const { registerSettings } = await import("../scripts/settings.mjs");

let registrations;

beforeEach(() => {
  registrations = new Map();
  globalThis.game = { settings: {
    register: (moduleId, key, config) => registrations.set(`${moduleId}.${key}`, config),
    registerMenu: () => {}
  } };
});

test("Prompt Library sort defaults are configurable per client", () => {
  registerSettings();
  const field = registrations.get(`${MODULE_ID}.${SETTINGS.DEFAULT_LIBRARY_SORT_FIELD}`);
  const direction = registrations.get(`${MODULE_ID}.${SETTINGS.DEFAULT_LIBRARY_SORT_DIRECTION}`);

  assert.equal(field.scope, "client");
  assert.equal(field.config, true);
  assert.equal(field.default, "createdAt");
  assert.deepEqual(Object.keys(field.choices), ["status", "name", "createdAt", "closedAt"]);

  assert.equal(direction.scope, "client");
  assert.equal(direction.config, true);
  assert.equal(direction.default, "desc");
  assert.deepEqual(direction.choices, {
    asc: "DRAWING-PROMPTS.choices.librarySortDirection.ascending",
    desc: "DRAWING-PROMPTS.choices.librarySortDirection.descending"
  });
});

test("English settings use generic sort-direction labels and Prompt name terminology", async () => {
  const { readFile } = await import("node:fs/promises");
  const lang = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));

  assert.equal(lang["DRAWING-PROMPTS.choices.librarySortDirection.ascending"], "Ascending");
  assert.equal(lang["DRAWING-PROMPTS.choices.librarySortDirection.descending"], "Descending");
  assert.equal(lang["DRAWING-PROMPTS.manager.fields.promptName"], "Prompt name");
  assert.equal(lang["DRAWING-PROMPTS.manager.summary.promptName"], "Prompt name");
  assert.equal(lang["DRAWING-PROMPTS.manager.validation.promptName"], "Prompt name is required.");
});
