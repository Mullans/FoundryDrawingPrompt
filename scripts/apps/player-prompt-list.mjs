import { STATUS } from "../constants.mjs";
import { getAssignment, listAssignments } from "../prompts/client-store.mjs";
import { PlayerDrawingApp } from "./player-drawing-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Player-side list of session-known drawing prompts.
 */
export class PlayerPromptList extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-player-list",
    classes: ["drawing-prompts", "drawing-prompts-list"],
    tag: "section",
    window: {
      title: "DRAWING-PROMPTS.list.title",
      icon: "fa-solid fa-list-check",
      resizable: true,
      positioned: true
    },
    position: { width: 560, height: 520 },
    actions: {
      openAssignment: PlayerPromptList.#onOpenAssignment
    }
  };

  static PARTS = {
    body: {
      template: "modules/drawing-prompts/templates/player-prompt-list.hbs"
    }
  };

  /**
   * Open or focus the prompt list.
   * @returns {Promise<PlayerPromptList>}
   */
  static async open() {
    this.#instance ??= new this();
    await this.#instance.render({ force: true });
    this.#instance.bringToFront();
    return this.#instance;
  }

  /**
   * Refresh the list if open.
   * @returns {void}
   */
  static refreshOpen() {
    this.#instance?.render({ parts: ["body"] });
  }

  /** @override */
  async _prepareContext(options) {
    return {
      assignments: listAssignments().map(payload => {
        const active = [STATUS.PENDING, STATUS.OPENED].includes(payload.assignment.status);
        return {
          ...payload,
          promptText: truncate(payload.prompt.promptText ?? ""),
          statusLabel: game.i18n.localize(`DRAWING-PROMPTS.status.${payload.assignment.status}`),
          statusClass: `status-${payload.assignment.status}`,
          sentAt: formatTimestamp(payload.prompt.sentAt),
          openedAt: formatTimestamp(payload.assignment.openedAt),
          submittedAt: formatTimestamp(payload.assignment.submittedAt),
          canOpen: active
        };
      })
    };
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( this.constructor.#instance === this ) this.constructor.#instance = null;
  }

  /**
   * @this {PlayerPromptList}
   * @param {PointerEvent} _event Click event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<void>}
   */
  static async #onOpenAssignment(_event, target) {
    const payload = getAssignment(target.dataset.assignmentId);
    if ( !payload ) return;
    await PlayerDrawingApp.open(payload, { mode: "live" });
  }
}

/**
 * Truncate prompt text.
 * @param {string} text Text.
 * @returns {string}
 */
function truncate(text) {
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

/**
 * Format a timestamp.
 * @param {number|null} ts Epoch milliseconds.
 * @returns {string}
 */
function formatTimestamp(ts) {
  return ts ? new Date(ts).toLocaleString() : "";
}
