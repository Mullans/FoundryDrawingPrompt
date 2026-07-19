/**
 * Build sorted world Actor options.
 * @param {string} selectedUuid Selected Actor UUID.
 * @returns {Array<{uuid: string, name: string, selected: boolean}>}
 */
export function worldActorOptions(selectedUuid) {
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
export function attachActorFilter(root, searchName, selectName) {
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
