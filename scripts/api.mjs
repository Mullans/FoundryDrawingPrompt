import { MODULE_ID } from "./constants.mjs";
import {
  applyAssignmentTransform,
  cancelAssignment,
  closePrompt,
  reopenPrompt,
  archivePrompt,
  restorePrompt,
  deletePrompt,
  createPrompt,
  updatePrompt,
  sendPrompt,
  getAssignment,
  getPrompt,
  openPromptLibrary,
  openNewPrompt,
  openPrompt,
  openPromptCopy,
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
    updatePrompt,
    sendPrompt,
    openPromptLibrary,
    openNewPrompt,
    openPrompt,
    openPromptCopy,
    getPrompt,
    getAssignment,
    saveAssignment,
    applyAssignmentTransform,
    placeAssignmentAsTile,
    placeAssignmentAsToken,
    reopenAssignment,
    cancelAssignment,
    closePrompt,
    reopenPrompt,
    archivePrompt,
    restorePrompt,
    deletePrompt
  };
}
