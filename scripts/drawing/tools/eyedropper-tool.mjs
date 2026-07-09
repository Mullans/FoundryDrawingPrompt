/**
 * Eyedropper tool. Samples the composited canvas without committing operations.
 */
export class EyedropperTool {
  /**
   * Sample a color.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerDown(pt, engineCtx) {
    engineCtx.sampleColor(pt);
  }

  /** @returns {void} */
  onPointerMove() {}

  /** @returns {void} */
  onPointerUp() {}
}
