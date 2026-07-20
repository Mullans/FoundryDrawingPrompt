import { MODULE_ID, SETTINGS } from "../constants.mjs";
import { attachActorFilter, worldActorOptions } from "../foundry/actor-picker.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Configure the world Actor used as the default Copy Actor source.
 */
export class CloneSourceSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {WeakSet<HTMLElement>} Search inputs which already have actor filters attached. */
  #actorFilterInputs = new WeakSet();

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-clone-source-settings",
    classes: ["drawing-prompts", "drawing-prompts-clone-source-settings"],
    tag: "form",
    window: {
      contentClasses: ["standard-form"],
      title: "DRAWING-PROMPTS.settings.cloneSource.title",
      icon: "fa-solid fa-user-group",
      resizable: false
    },
    position: { width: 460 },
    form: {
      closeOnSubmit: true,
      handler: CloneSourceSettings.#onSubmit
    }
  };

  static PARTS = {
    body: {
      template: "modules/drawing-prompts/templates/clone-source-settings.hbs"
    }
  };

  constructor(options = {}) {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    super(options);
  }

  /** @override */
  async _prepareContext(options) {
    const selectedUuid = String(game.settings.get(MODULE_ID, SETTINGS.DEFAULT_CLONE_SOURCE_ACTOR_UUID) || "");
    return {
      actors: worldActorOptions(selectedUuid),
      buttons: [{
        type: "submit",
        icon: "fa-solid fa-floppy-disk",
        label: "DRAWING-PROMPTS.settings.cloneSource.save"
      }]
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#attachActorFilter(this.element, "cloneSourceSearch", "actorUuid");
  }

  /**
   * Attach an actor filter once to the current rendered search input.
   * @param {HTMLElement|null} root Application root.
   * @param {string} searchName Search input name.
   * @param {string} selectName Actor select name.
   * @returns {void}
   */
  #attachActorFilter(root, searchName, selectName) {
    const search = root?.querySelector(`[name="${searchName}"]`);
    if ( !search || this.#actorFilterInputs.has(search) ) return;
    attachActorFilter(root, searchName, selectName);
    this.#actorFilterInputs.add(search);
  }

  /**
   * Persist the selected world Actor UUID.
   * @this {CloneSourceSettings}
   * @param {SubmitEvent} _event Submit event.
   * @param {HTMLFormElement} _form Submitted form.
   * @param {object} formData Foundry expanded form data.
   * @returns {Promise<void>}
   */
  static async #onSubmit(_event, _form, formData) {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    await game.settings.set(MODULE_ID, SETTINGS.DEFAULT_CLONE_SOURCE_ACTOR_UUID, String(formData.object.actorUuid || ""));
  }
}
