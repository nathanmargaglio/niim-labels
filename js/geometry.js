/**
 * Where a label sits under the printhead, in device pixels.
 *
 * The printer always prints a full printhead-wide image: a narrower image is
 * not centred by the B1, it is pinned to one side of the printhead, so a 40 mm
 * label printed as a 40 mm image came out several millimetres off to one side
 * with its right edge cut off. The label roll, though, is centred under the
 * printhead. So the label is drawn at its real size and then placed in the
 * middle of a printhead-wide image, nudged by the alignment offset.
 *
 * Two coordinate systems are used:
 * - label coordinates: (0, 0) is the label's top-left corner;
 * - image coordinates: (0, 0) is the top-left of the image sent to the printer,
 *   which is always `printheadPixels` wide and as tall as the label.
 *
 * imageX = labelX + shiftX, and imageY = labelY + shiftY.
 *
 * No DOM here, so it is unit tested.
 */

const MM_PER_INCH = 25.4;

/** Converts millimetres to device pixels at the given resolution, at least 1. */
export function mmToPx(mm, dpi) {
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

/** Converts a signed length, which may be zero, to device pixels. */
function mmToSignedPx(mm, dpi) {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

/** Converts device pixels back to millimetres, for display. */
export function pxToMm(px, dpi) {
  return (px / dpi) * MM_PER_INCH;
}

/**
 * @param {object} settings Label size, margins and alignment offset in mm.
 * @param {{dpi: number, printheadPixels: number}} caps
 */
export function labelGeometry(settings, caps) {
  const { dpi, printheadPixels } = caps;
  const widthPx = mmToPx(settings.widthMm, dpi);
  const heightPx = mmToPx(settings.heightMm, dpi);

  // Positive offsets move the print right and down on the label.
  const shiftX = Math.round((printheadPixels - widthPx) / 2) + mmToSignedPx(settings.offsetXMm ?? 0, dpi);
  const shiftY = mmToSignedPx(settings.offsetYMm ?? 0, dpi);

  // The part of the label the printhead can reach. Across the label that is the
  // printhead's width; along it, the image rows, which are as many as the label
  // is tall, so a vertical offset trades space at one end for the other.
  const printable = intersect(
    { left: -shiftX, top: -shiftY, right: printheadPixels - shiftX, bottom: heightPx - shiftY },
    { left: 0, top: 0, right: widthPx, bottom: heightPx },
  );

  // Text is kept inside both the margins and the printable area, so a margin
  // narrower than the strip the printhead cannot reach never cuts text off.
  const margins = {
    left: mmToSignedPx(settings.marginLeftMm, dpi),
    right: mmToSignedPx(settings.marginRightMm, dpi),
    top: mmToSignedPx(settings.marginTopMm, dpi),
    bottom: mmToSignedPx(settings.marginBottomMm, dpi),
  };
  const content = intersect(
    { left: margins.left, top: margins.top, right: widthPx - margins.right, bottom: heightPx - margins.bottom },
    printable,
  );

  return {
    dpi,
    printheadPixels,
    widthPx,
    heightPx,
    shiftX,
    shiftY,
    printable,
    content: {
      x: content.left,
      y: content.top,
      width: Math.max(1, content.right - content.left),
      height: Math.max(1, content.bottom - content.top),
    },
    /** Label width the printhead cannot reach, on the left and right, in px. */
    unreachableLeft: printable.left,
    unreachableRight: widthPx - printable.right,
  };
}

function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  return {
    left,
    top,
    right: Math.max(left, Math.min(a.right, b.right)),
    bottom: Math.max(top, Math.min(a.bottom, b.bottom)),
  };
}
