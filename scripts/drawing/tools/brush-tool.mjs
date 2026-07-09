/**
 * Brush foreground drawing tool.
 */
export class BrushTool {
  /**
   * Begin a brush stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerDown(pt, engineCtx) {
    engineCtx.beginStroke("stroke", pt);
  }

  /**
   * Extend a brush stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerMove(pt, engineCtx) {
    engineCtx.extendStroke(pt);
  }

  /**
   * Commit a brush stroke.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerUp(pt, engineCtx) {
    engineCtx.commitStroke(pt);
  }
}
