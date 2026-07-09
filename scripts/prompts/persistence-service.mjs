import { FLAG_PROMPT, MODULE_ID } from "../constants.mjs";
import { DrawingPrompt } from "./prompt-models.mjs";

/**
 * Ensure the current user is a GM before writing world data.
 * @returns {void}
 */
function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
}

/**
 * Get the localized Journal folder name.
 * @returns {string}
 */
function journalFolderName() {
  return game.i18n.localize("DRAWING-PROMPTS.journal.folderName");
}

/**
 * Find or create the Drawing Prompts JournalEntry folder.
 * @returns {Promise<Folder>}
 */
export async function ensureJournalFolder() {
  assertGM();
  const name = journalFolderName();
  const existing = game.folders.find(folder => folder.type === "JournalEntry" && folder.name === name);
  if ( existing ) return existing;
  return Folder.create({ name, type: "JournalEntry" });
}

/**
 * Create a hidden JournalEntry for a prompt and persist its flag data.
 * @param {DrawingPrompt} prompt Prompt model to persist.
 * @returns {Promise<JournalEntry>}
 */
export async function createPromptEntry(prompt) {
  assertGM();
  const folder = await ensureJournalFolder();
  const name = game.i18n.format("DRAWING-PROMPTS.journal.entryName", { name: prompt.drawingName || prompt.promptText || prompt.id || "" });
  const entry = await JournalEntry.create({
    name,
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: {
      [MODULE_ID]: {
        [FLAG_PROMPT]: prompt.toObject()
      }
    }
  });
  prompt.id = entry.id;
  for ( const assignment of Object.values(prompt.assignments) ) assignment.promptId = prompt.id;
  await entry.setFlag(MODULE_ID, FLAG_PROMPT, prompt.toObject());
  return entry;
}

/**
 * Save the full prompt state to its JournalEntry flag.
 * @param {DrawingPrompt} prompt Prompt model to save.
 * @returns {Promise<JournalEntry>}
 */
export async function savePrompt(prompt) {
  assertGM();
  const entry = game.journal.get(prompt.id);
  if ( !entry ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  return entry.setFlag(MODULE_ID, FLAG_PROMPT, prompt.toObject());
}

/**
 * Load a persisted prompt by JournalEntry id.
 * @param {string} promptId JournalEntry id.
 * @returns {DrawingPrompt|null}
 */
export function loadPrompt(promptId) {
  const entry = game.journal.get(promptId);
  const data = entry?.getFlag(MODULE_ID, FLAG_PROMPT);
  return data ? DrawingPrompt.fromObject(data) : null;
}

/**
 * Load all persisted Drawing Prompts.
 * @param {object} [options] Load options.
 * @param {boolean} [options.activeOnly=false] Whether to return only prompts with active assignments.
 * @returns {DrawingPrompt[]}
 */
export function loadAllPrompts({ activeOnly = false } = {}) {
  const prompts = [];
  for ( const entry of game.journal ) {
    const data = entry.getFlag(MODULE_ID, FLAG_PROMPT);
    if ( !data ) continue;
    const prompt = DrawingPrompt.fromObject(data);
    if ( activeOnly && !prompt.isActive ) continue;
    prompts.push(prompt);
  }
  return prompts;
}

/**
 * Delete a prompt JournalEntry.
 * @param {string} promptId JournalEntry id.
 * @returns {Promise<JournalEntry|null>}
 */
export async function deletePromptEntry(promptId) {
  assertGM();
  const entry = game.journal.get(promptId);
  return entry ? entry.delete() : null;
}
