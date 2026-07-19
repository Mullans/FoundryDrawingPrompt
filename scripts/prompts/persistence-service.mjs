import { FLAG_PROMPT, MODULE_ID } from "../constants.mjs";
import { DrawingPrompt } from "./prompt-models.mjs";
import { assertGM } from "./socket-auth.mjs";
import { TimerUpdateQueue } from "./timer-update-queue.mjs";

/** @type {Map<string, string>|null} */
let assignmentIndex = null;
const promptSaveQueue = new TimerUpdateQueue();

/**
 * Get the localized Journal folder name.
 * @returns {string}
 */
function journalFolderName() {
  return game.i18n.localize("DRAWING-PROMPTS.journal.folderName");
}

/**
 * Rebuild the assignment id to prompt id lookup index.
 * @returns {Map<string, string>} Assignment index.
 */
export function rebuildAssignmentIndex() {
  assignmentIndex = new Map();
  for ( const entry of game.journal ) {
    const data = entry.getFlag(MODULE_ID, FLAG_PROMPT);
    if ( !data?.assignments ) continue;
    for ( const assignment of Object.values(data.assignments) ) {
      if ( assignment?.id ) assignmentIndex.set(assignment.id, data.id ?? entry.id);
    }
  }
  return assignmentIndex;
}

/**
 * Resolve a prompt id for an assignment id using the warm index.
 * @param {string} assignmentId Assignment id.
 * @returns {string|null} Prompt id.
 */
export function getPromptIdForAssignment(assignmentId) {
  if ( !assignmentIndex ) rebuildAssignmentIndex();
  return assignmentIndex.get(assignmentId) ?? null;
}

/**
 * Update the assignment index after prompt mutations.
 * @param {DrawingPrompt} prompt Prompt model.
 * @returns {void}
 */
function indexPromptAssignments(prompt) {
  if ( !assignmentIndex ) assignmentIndex = new Map();
  for ( const assignment of Object.values(prompt.assignments ?? {}) ) {
    if ( assignment?.id ) assignmentIndex.set(assignment.id, prompt.id);
  }
}

/**
 * Remove one prompt's assignments from the index.
 * @param {string} promptId Prompt id.
 * @returns {void}
 */
function unindexPrompt(promptId) {
  if ( !assignmentIndex ) return;
  for ( const [assignmentId, indexedPromptId] of assignmentIndex.entries() ) {
    if ( indexedPromptId === promptId ) assignmentIndex.delete(assignmentId);
  }
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
  indexPromptAssignments(prompt);
  return entry;
}

/**
 * Save the full prompt state to its JournalEntry flag.
 * Timer-only saves merge into the latest persisted prompt. All other saves
 * preserve the latest persisted timer state, preventing stale assignment
 * models from moving the deadline back.
 * @param {DrawingPrompt} prompt Prompt model to save.
 * @param {object} [options] Save options.
 * @param {boolean} [options.timerOnly=false] Persist only the timer state.
 * @returns {Promise<JournalEntry>}
 */
export async function savePrompt(prompt, { timerOnly = false } = {}) {
  assertGM();
  return promptSaveQueue.enqueue(prompt.id, async () => {
    const entry = game.journal.get(prompt.id);
    if ( !entry ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
    const persisted = entry.getFlag(MODULE_ID, FLAG_PROMPT);
    const latest = persisted ? DrawingPrompt.fromObject(persisted) : null;
    let savedPrompt = prompt;
    if ( latest && timerOnly ) {
      latest.timerState = prompt.timerState;
      savedPrompt = latest;
      prompt.assignments = latest.assignments;
    } else if ( latest ) {
      prompt.timerState = latest.timerState;
    }
    indexPromptAssignments(savedPrompt);
    return entry.setFlag(MODULE_ID, FLAG_PROMPT, savedPrompt.toObject());
  });
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
  if ( !assignmentIndex ) rebuildAssignmentIndex();
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
  if ( !entry ) return null;
  unindexPrompt(promptId);
  return entry.delete();
}
