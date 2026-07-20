import { MODULE_ID } from "./constants.mjs";
import { assertGmInitiator } from "./prompts/socket-auth.mjs";

export const CALLS = Object.freeze({
  OPEN: "openDrawingPrompt",
  REOPEN: "reopenDrawingPrompt",
  TIMER_UPDATED: "timerUpdated",
  CANCEL: "cancelDrawingPrompt",
  SHOW: "showDrawingPrompt",
  REQUEST_SNAPSHOT: "requestSnapshot",
  OPENED: "assignmentOpened",
  SNAPSHOT: "drawingSnapshot",
  SUBMITTED: "drawingSubmitted",
  REJECTED: "drawingRejected",
  WINDOW_CLOSED: "playerWindowClosed"
});

let socket = null;

/**
 * Register all Drawing Prompts socketlib handlers.
 * @param {Record<string, Function>} handlers Socket handlers keyed by call name.
 * @returns {void}
 */
export function initSocket(handlers) {
  if ( !globalThis.socketlib ) {
    ui.notifications.error(game.i18n.localize("DRAWING-PROMPTS.errors.socketlibMissing"));
    socket = null;
    return;
  }
  socket = socketlib.registerModule(MODULE_ID);
  if ( !socket ) {
    ui.notifications.error(game.i18n.localize("DRAWING-PROMPTS.errors.socketRegistrationFailed"));
    return;
  }
  for ( const callName of Object.values(CALLS) ) {
    const handler = handlers[callName] ?? (() => console.debug(`${MODULE_ID} | Unhandled socket call`, callName));
    socket.register(callName, wrapPlayerGmHandler(callName, handler));
  }
}

/**
 * Wrap player-targeted handlers so only a GM initiator can invoke them.
 * @param {string} callName Socket call name.
 * @param {Function} handler Registered handler.
 * @returns {Function} Wrapped handler.
 */
function wrapPlayerGmHandler(callName, handler) {
  if ( !PLAYER_GM_INITIATED_CALLS.has(callName) ) return handler;
  return function wrappedPlayerGmHandler(...args) {
    try {
      assertGmInitiator(this?.socketdata?.userId, game.users);
    } catch (_err) {
      console.debug(`${MODULE_ID} | rejected non-GM socket call`, callName, this?.socketdata?.userId);
      return;
    }
    return handler.apply(this, args);
  };
}

const PLAYER_GM_INITIATED_CALLS = new Set([
  CALLS.OPEN,
  CALLS.REOPEN,
  CALLS.TIMER_UPDATED,
  CALLS.CANCEL,
  CALLS.SHOW,
  CALLS.REQUEST_SNAPSHOT
]);

/**
 * Test whether socketlib registration completed.
 * @returns {boolean}
 */
export function isSocketReady() {
  return Boolean(socket);
}

/**
 * Return the registered socket or throw if it is unavailable.
 * @returns {object}
 */
function requireSocket() {
  if ( !socket ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.socketlibMissing"));
  return socket;
}

export const emit = {
  /**
   * Ask a player client to open a drawing prompt.
   * @param {string} userId Target user id.
   * @param {object} payload Assignment payload.
   * @returns {Promise<*>}
   */
  openDrawingPrompt(userId, payload) {
    return requireSocket().executeAsUser(CALLS.OPEN, userId, payload);
  },

  /**
   * Ask a player client to reopen a drawing prompt.
   * @param {string} userId Target user id.
   * @param {object} payload Assignment payload.
   * @returns {Promise<*>}
   */
  reopenDrawingPrompt(userId, payload) {
    return requireSocket().executeAsUser(CALLS.REOPEN, userId, payload);
  },

  /**
   * Send a prompt timer change to an assigned player.
   * @param {string} userId Target user id.
   * @param {string} assignmentId Assignment id used to validate prompt ownership.
   * @param {object} timerState Canonical timer state.
   * @returns {Promise<*>}
   */
  timerUpdated(userId, assignmentId, timerState) {
    return requireSocket().executeAsUser(CALLS.TIMER_UPDATED, userId, assignmentId, timerState);
  },

  /**
   * Ask a player client to cancel an assignment.
   * @param {string} userId Target user id.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<*>}
   */
  cancelDrawingPrompt(userId, assignmentId) {
    return requireSocket().executeAsUser(CALLS.CANCEL, userId, assignmentId);
  },

  /**
   * Ask a player client to show an assignment window.
   * @param {string} userId Target user id.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<*>}
   */
  showDrawingPrompt(userId, assignmentId) {
    return requireSocket().executeAsUser(CALLS.SHOW, userId, assignmentId);
  },

  /**
   * Ask a player client for its latest snapshot.
   * @param {string} userId Target user id.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<*>}
   */
  requestSnapshot(userId, assignmentId) {
    return requireSocket().executeAsUser(CALLS.REQUEST_SNAPSHOT, userId, assignmentId);
  },

  /**
   * Notify the owning GM that an assignment opened.
   * @param {string} gmUserId Prompt-owning GM user id.
   * @param {string} assignmentId Assignment id.
   * @param {string} userId Player user id.
   * @returns {Promise<*>}
   */
  assignmentOpened(gmUserId, assignmentId, userId) {
    return requireSocket().executeForUsers(CALLS.OPENED, [gmUserId], assignmentId, userId);
  },

  /**
   * Send a preview snapshot to the owning GM.
   * @param {string} gmUserId Prompt-owning GM user id.
   * @param {string} assignmentId Assignment id.
   * @param {string} userId Player user id.
   * @param {string} snapshotDataUrl Snapshot data URL.
   * @returns {Promise<*>}
   */
  drawingSnapshot(gmUserId, assignmentId, userId, snapshotDataUrl) {
    return requireSocket().executeForUsers(CALLS.SNAPSHOT, [gmUserId], assignmentId, userId, snapshotDataUrl);
  },

  /**
   * Send a drawing submission to the owning GM.
   * @param {string} gmUserId Prompt-owning GM user id.
   * @param {string} assignmentId Assignment id.
   * @param {string} userId Player user id.
   * @param {object} submissionPayload Submission data.
   * @returns {Promise<*>}
   */
  drawingSubmitted(gmUserId, assignmentId, userId, submissionPayload) {
    return requireSocket().executeForUsers(CALLS.SUBMITTED, [gmUserId], assignmentId, userId, submissionPayload);
  },

  /**
   * Notify the owning GM that a player rejected an assignment.
   * @param {string} gmUserId Prompt-owning GM user id.
   * @param {string} assignmentId Assignment id.
   * @param {string} userId Player user id.
   * @param {*} reason Rejection reason payload.
   * @returns {Promise<*>}
   */
  drawingRejected(gmUserId, assignmentId, userId, reason) {
    return requireSocket().executeForUsers(CALLS.REJECTED, [gmUserId], assignmentId, userId, reason);
  },

  /**
   * Notify the owning GM that the player window closed.
   * @param {string} gmUserId Prompt-owning GM user id.
   * @param {string} assignmentId Assignment id.
   * @param {string} userId Player user id.
   * @returns {Promise<*>}
   */
  playerWindowClosed(gmUserId, assignmentId, userId) {
    return requireSocket().executeForUsers(CALLS.WINDOW_CLOSED, [gmUserId], assignmentId, userId);
  }
};
