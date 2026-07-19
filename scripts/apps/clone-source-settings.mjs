import { MODULE_ID, SETTINGS } from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Configure the world Actor used as the default Copy Actor source.
 */
export class CloneSourceSettings extends HandlebarsApplicationMixin(ApplicationV2) {
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
    attachActorFilter(this.element, "cloneSourceSearch", "actorUuid");
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

/**
 * Build sorted world Actor options.
 * @param {string} selectedUuid Selected Actor UUID.
 * @returns {Array<{uuid: string, name: string, selected: boolean}>}
 */
function worldActorOptions(selectedUuid) {
  return Array.from(game.actors ?? [])
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(actor => ({
      uuid: actor.uuid,
      name: actor.name,
      selected: actor.uuid === selectedUuid
    }));
}

/**
 * Attach a simple text filter to an Actor select.
 * @param {HTMLElement} root Application root.
 * @param {string} searchName Search input name.
 * @param {string} selectName Select name.
 * @returns {void}
 */
function attachActorFilter(root, searchName, selectName) {
  const search = root?.querySelector(`[name="${searchName}"]`);
  const select = root?.querySelector(`select[name="${selectName}"]`);
  search?.addEventListener("input", () => {
    const query = String(search.value || "").trim().toLocaleLowerCase();
    for ( const option of select?.options ?? [] ) {
      if ( !option.value ) continue;
      option.hidden = Boolean(query) && !option.text.toLocaleLowerCase().includes(query);
    }
  });
}
