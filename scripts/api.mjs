import { MODULE_ID } from "./constants.mjs";
import {
  applyAssignmentTransform,
  cancelAssignment,
  createPrompt,
  getAssignment,
  getPrompt,
  openPromptManager,
  placeAssignmentAsTile,
  placeAssignmentAsToken,
  reopenAssignment,
  saveAssignment
} from "./prompts/prompt-service.mjs";

/**
 * Register the module public API on the Foundry module record.
 * @returns {void}
 */
export function registerAPI() {
  game.modules.get(MODULE_ID).api = {
    createPrompt,
    openPromptManager,
    getPrompt,
    getAssignment,
    saveAssignment,
    applyAssignmentTransform,
    placeAssignmentAsTile,
    placeAssignmentAsToken,
    reopenAssignment,
    cancelAssignment
  };
}
