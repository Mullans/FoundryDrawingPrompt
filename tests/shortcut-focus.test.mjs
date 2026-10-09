import test from "node:test";
import assert from "node:assert/strict";
import { ownsDrawingShortcut } from "../scripts/drawing/shortcut-focus.mjs";

test("only the drawing containing the keyboard target owns its shortcut", () => {
  const target = { closest: () => null };
  assert.equal(ownsDrawingShortcut({ contains: item => item === target }, { target }), true);
  assert.equal(ownsDrawingShortcut({ contains: () => false }, { target }), false);
});

test("outside focus, editing, composition and browser chords are left untouched", () => {
  const root = { contains: target => Boolean(target?.inside) };
  assert.equal(ownsDrawingShortcut(root, { target: { inside: false } }), false);
  assert.equal(ownsDrawingShortcut(root, { target: { inside: true, isContentEditable: true } }), false);
  assert.equal(ownsDrawingShortcut(root, { target: { inside: true, closest: () => ({}) } }), false);
  for ( const flag of ["ctrlKey", "metaKey", "altKey", "isComposing", "defaultPrevented"] ) {
    assert.equal(ownsDrawingShortcut(root, { target: { inside: true }, [flag]: true }), false);
  }
  assert.equal(ownsDrawingShortcut(null, { target: {} }), false);
});

test("Enter and Space retain native button activation", () => {
  const target = { closest: selector => selector.startsWith("button") ? {} : null };
  const root = { contains: () => true };
  assert.equal(ownsDrawingShortcut(root, { target, key: "Enter" }), false);
  assert.equal(ownsDrawingShortcut(root, { target, key: " " }), false);
  assert.equal(ownsDrawingShortcut(root, { target, key: "e" }), true);
});
