/**
 * Shared Prompt / Assignment lookup and ownership checks.
 * Small seam used by lifecycle, placement, Save, and socket handlers.
 */

import { getPromptIdForAssignment, loadAllPrompts, loadPrompt } from "./persistence-service.mjs";

/**
 * Load a prompt by id.
 * @param {string} promptId Prompt id.
 * @returns {import("./prompt-models.mjs").DrawingPrompt|null}
 */
export function getPrompt(promptId) {
  return loadPrompt(promptId);
}

/**
 * Find an assignment by id across persisted prompts.
 * @param {string} assignmentId Assignment id.
 * @returns {import("./prompt-models.mjs").DrawingAssignment|null}
 */
export function getAssignment(assignmentId) {
  const promptId = getPromptIdForAssignment(assignmentId);
  if ( promptId ) {
    const assignment = loadPrompt(promptId)?.getAssignment(assignmentId);
    if ( assignment ) return assignment;
  }
  for ( const prompt of loadAllPrompts() ) {
    const assignment = prompt.getAssignment(assignmentId);
    if ( assignment ) return assignment;
  }
  return null;
}

/**
 * Find the prompt and assignment pair for an assignment id.
 * @param {string} assignmentId Assignment id.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment}}
 */
export function requirePromptAssignment(assignmentId) {
  const promptId = getPromptIdForAssignment(assignmentId);
  if ( promptId ) {
    const prompt = loadPrompt(promptId);
    const assignment = prompt?.getAssignment(assignmentId);
    if ( prompt && assignment ) return { prompt, assignment };
  }
  for ( const prompt of loadAllPrompts() ) {
    const assignment = prompt.getAssignment(assignmentId);
    if ( assignment ) return { prompt, assignment };
  }
  throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.assignmentNotFound"));
}

/**
 * Verify prompt ownership.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {void}
 */
export function assertPromptOwner(prompt) {
  if ( prompt.gmUserId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notPromptOwner"));
}
