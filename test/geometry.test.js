import test from "node:test";
import assert from "node:assert/strict";
import { labelGeometry } from "../js/geometry.js";
import { DEFAULTS, clean } from "../js/settings.js";

const B1 = { dpi: 203, printheadPixels: 384 };

const settings = (overrides = {}) => ({ ...DEFAULTS, ...overrides });

test("a 50 mm label is centred under the narrower printhead", () => {
  const geo = labelGeometry(settings(), B1);
  assert.equal(geo.widthPx, 400);
  assert.equal(geo.heightPx, 240);
  // 16 px of label overhang the printhead, half on each side.
  assert.equal(geo.shiftX, -8);
  assert.deepEqual(
    [geo.unreachableLeft, geo.unreachableRight],
    [8, 8],
  );
  // 2.5 mm margins are wider than the overhang, so they decide the text box.
  assert.deepEqual(geo.content, { x: 20, y: 20, width: 360, height: 200 });
});

test("a 40 mm label is placed in the middle of a full-width image", () => {
  const geo = labelGeometry(settings({ widthMm: 40 }), B1);
  assert.equal(geo.widthPx, 320);
  // The label's left edge lands 32 px into the 384 px image, so it is centred
  // rather than pinned to the side of the printhead.
  assert.equal(geo.shiftX, 32);
  assert.equal(geo.shiftX + geo.widthPx + geo.shiftX, B1.printheadPixels);
  assert.deepEqual([geo.unreachableLeft, geo.unreachableRight], [0, 0]);
  assert.deepEqual(geo.content, { x: 20, y: 20, width: 280, height: 200 });
});

test("each margin moves only its own side", () => {
  const geo = labelGeometry(settings({ widthMm: 40, marginRightMm: 5, marginTopMm: 1 }), B1);
  assert.deepEqual(geo.content, { x: 20, y: 8, width: 260, height: 212 });
});

test("the alignment offset moves the print without moving the text box", () => {
  const base = labelGeometry(settings({ widthMm: 40 }), B1);
  const moved = labelGeometry(settings({ widthMm: 40, offsetXMm: -2, offsetYMm: 1 }), B1);
  assert.equal(moved.shiftX, base.shiftX - 16);
  assert.equal(moved.shiftY, 8);
  assert.deepEqual(moved.content, base.content);
});

test("text is kept inside the part of the label the printhead reaches", () => {
  // Zero margins on a 50 mm label would put text on the strips the printhead
  // overhangs; the text box shrinks to what it can print.
  const geo = labelGeometry(
    settings({ marginLeftMm: 0, marginRightMm: 0, marginTopMm: 0, marginBottomMm: 0, offsetYMm: 1 }),
    B1,
  );
  assert.deepEqual(geo.content, { x: 8, y: 0, width: 384, height: 232 });
});

test("a single legacy margin carries over to all four sides", () => {
  const migrated = clean({ marginMm: 4, marginLeftMm: 1 });
  assert.equal(migrated.marginTopMm, 4);
  assert.equal(migrated.marginRightMm, 4);
  assert.equal(migrated.marginBottomMm, 4);
  assert.equal(migrated.marginLeftMm, 1);
  assert.equal(migrated.offsetXMm, 0);
  assert.equal(clean({ offsetXMm: 99 }).offsetXMm, 10);
});
