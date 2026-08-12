/**
 * Click-to-place polyline tool. Commits as a normal stroke op (reuses stroke renderer).
 */
export class LineTool {
  /** @type {{x: number, y: number}[]} */
  #vertices = [];
  /** @type {{x: number, y: number}|null} */
  #cursor = null;

  /**
   * Whether a polyline draft is in progress.
   * @returns {boolean}
   */
  isDrafting() {
    return this.#vertices.length > 0;
  }

  /**
   * Add a vertex on click.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerDown(pt, engineCtx) {
    this.#vertices.push({ x: pt.x, y: pt.y });
    this.#cursor = { x: pt.x, y: pt.y };
    engineCtx.previewPolyline(this.#previewPoints());
  }

  /**
   * Rubber-band the segment from the last vertex to the cursor.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerMove(pt, engineCtx) {
    if ( !this.#vertices.length ) return;
    this.#cursor = { x: pt.x, y: pt.y };
    engineCtx.previewPolyline(this.#previewPoints());
  }

  /** @returns {void} */
  onPointerUp() {}

  /**
   * Double-click finishes the polyline (last click already added a vertex).
   * @param {{x: number, y: number}} _pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {boolean} True when the event was handled.
   */
  onDoubleClick(_pt, engineCtx) {
    if ( !this.isDrafting() ) return false;
    this.#dedupeTrailingVertex();
    this.commit(engineCtx);
    return true;
  }

  /**
   * Commit the drafted vertices as a stroke (requires ≥2 points).
   * @param {object} engineCtx Engine tool context.
   * @returns {boolean}
   */
  commit(engineCtx) {
    const points = this.#vertices.map(pt => ({ x: pt.x, y: pt.y }));
    this.#vertices = [];
    this.#cursor = null;
    if ( points.length < 2 ) {
      engineCtx.cancelStrokePreview();
      return false;
    }
    engineCtx.previewPolyline(points);
    return engineCtx.commitStrokePreview();
  }

  /**
   * Cancel the in-progress polyline.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  cancel(engineCtx) {
    this.#vertices = [];
    this.#cursor = null;
    engineCtx.cancelStrokePreview();
  }

  /**
   * Vertices plus rubber-band cursor for live preview.
   * @returns {{x: number, y: number}[]}
   */
  #previewPoints() {
    if ( !this.#vertices.length ) return [];
    if ( !this.#cursor ) return this.#vertices.map(pt => ({ x: pt.x, y: pt.y }));
    const last = this.#vertices.at(-1);
    if ( Math.hypot(this.#cursor.x - last.x, this.#cursor.y - last.y) < 0.5 ) {
      return this.#vertices.map(pt => ({ x: pt.x, y: pt.y }));
    }
    return [...this.#vertices.map(pt => ({ x: pt.x, y: pt.y })), { x: this.#cursor.x, y: this.#cursor.y }];
  }

  /**
   * Drop a trailing duplicate vertex from the second click of a double-click.
   * @returns {void}
   */
  #dedupeTrailingVertex() {
    if ( this.#vertices.length < 2 ) return;
    const a = this.#vertices.at(-1);
    const b = this.#vertices.at(-2);
    if ( Math.hypot(a.x - b.x, a.y - b.y) < 2 ) this.#vertices.pop();
  }
}
