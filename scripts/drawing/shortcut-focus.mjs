/**
 * A drawing owns shortcuts only while keyboard focus is inside its root.
 * An application's frontmost z-index is not keyboard focus (the board may own it).
 * @param {HTMLElement|null} root Drawing application root.
 * @param {KeyboardEvent} event Keyboard event.
 * @returns {boolean} Whether the drawing may handle this event.
 */
export function ownsDrawingShortcut(root, event) {
  const target = event?.target;
  if ( !root || !target || !root.contains(target) || event.defaultPrevented ) return false;
  if ( event.ctrlKey || event.metaKey || event.altKey || event.isComposing ) return false;
  if ( target.isContentEditable || target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])") ) return false;
  if ( ["Enter", " "].includes(event.key) && target.closest?.("button, a[href], [role='button']") ) return false;
  return true;
}
