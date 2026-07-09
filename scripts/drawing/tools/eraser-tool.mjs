/**
 * Eraser tool. Erases only the foreground drawing layer.
 */
export class EraserTool {
  /**
   * Begin an erase stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerDown(pt, engineCtx) {
    engineCtx.beginStroke("erase", pt);
  }

  /**
   * Extend an erase stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerMove(pt, engineCtx) {
    engineCtx.extendStroke(pt);
  }

  /**
   * Commit an erase stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerUp(pt, engineCtx) {
    engineCtx.commitStroke(pt);
  }
}
