/**
 * Draws a single label onto a canvas at the printer's native resolution.
 *
 * The layout is fixed: the person's name at the top, the order in the middle,
 * the same name again at the bottom, all left justified, with an optional
 * index in each right-hand corner.
 *
 *     Nate                14/28
 *
 *     Chicken Elote Salad
 *
 *     Nate                  3/5
 */

const MM_PER_INCH = 25.4;

/** Converts millimetres to device pixels at the given resolution. */
export function mmToPx(mm, dpi) {
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

/** Converts device pixels back to millimetres, for display. */
export function pxToMm(px, dpi) {
  return (px / dpi) * MM_PER_INCH;
}

export const FONT_STACKS = {
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: '"DejaVu Sans Mono", "Courier New", monospace',
  serif: 'Georgia, "Times New Roman", serif',
};

/**
 * Font box metrics for the current font.
 *
 * measureText reports these relative to the current textBaseline, so it is
 * pinned to the alphabetic baseline and restored, making the split between
 * ascent and descent independent of how the caller happens to be drawing.
 */
function fontBox(ctx, fallbackSize) {
  const previous = ctx.textBaseline;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("Hg");
  ctx.textBaseline = previous;
  const ascent = m.fontBoundingBoxAscent || fallbackSize * 0.8;
  const descent = m.fontBoundingBoxDescent || fallbackSize * 0.2;
  return { ascent, descent, height: ascent + descent };
}

/** Height a line of the current font occupies, including ascender and descender. */
function lineHeight(ctx, fallbackSize) {
  return fontBox(ctx, fallbackSize).height;
}

/** Greedily breaks text into lines that each fit within maxWidth. */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length ? lines : [""];
}

/** Largest font size at which text fits on one line within maxWidth. */
function fitOneLine(ctx, text, font, maxWidth, maxSize, minSize) {
  ctx.font = font(100);
  const width = ctx.measureText(text).width;
  if (width <= 0) return maxSize;
  let size = Math.floor((100 * maxWidth) / width);
  size = Math.min(maxSize, Math.max(minSize, size));
  // The proportional estimate is exact for most fonts but hinting can round the
  // wrong way, so step down until it really fits.
  while (size > minSize) {
    ctx.font = font(size);
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

/** Largest font size at which the wrapped text fits inside the given box. */
function fitBlock(ctx, text, font, maxWidth, maxHeight, maxSize, minSize) {
  let best = minSize;
  let lo = minSize;
  let hi = maxSize;
  while (lo <= hi) {
    const size = (lo + hi) >> 1;
    ctx.font = font(size);
    const lines = wrapText(ctx, text, maxWidth);
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const height = lines.length * lineHeight(ctx, size);
    if (widest <= maxWidth && height <= maxHeight) {
      best = size;
      lo = size + 1;
    } else {
      hi = size - 1;
    }
  }
  return best;
}

/**
 * Forces every pixel to pure black or pure white.
 *
 * The printer treats any non-white pixel as black, so anti-aliased glyph edges
 * would otherwise print as a fattened, muddy outline.
 */
export function thresholdCanvas(canvas, level = 176) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = luminance < level ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Renders one label.
 *
 * @param {HTMLCanvasElement} canvas Resized in place to the label's pixel size.
 * @param {{person: string, order: string, topRight?: string, bottomRight?: string}} label
 *        `topRight` and `bottomRight` are drawn in the corners; omit or pass an
 *        empty string to leave a corner blank.
 * @param {object} style Pixel geometry and typography.
 * @returns {HTMLCanvasElement} The same canvas, thresholded and ready to encode.
 */
export function renderLabel(canvas, label, style) {
  const {
    widthPx,
    heightPx,
    marginPx,
    fontFamily = FONT_STACKS.sans,
    boldName = true,
    threshold = 176,
  } = style;

  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const contentWidth = Math.max(1, widthPx - marginPx * 2);
  const contentHeight = Math.max(1, heightPx - marginPx * 2);
  const nameFont = (size) => `${boldName ? "bold " : ""}${size}px ${fontFamily}`;
  const plainFont = (size) => `${size}px ${fontFamily}`;
  const name = label.person || "";
  const orderText = (label.order || "").trim();
  const topRight = (label.topRight || "").trim();
  const bottomRight = (label.bottomRight || "").trim();

  // Corner badges are sized independently of the name, so that the width they
  // leave for the name is known before the name is fitted.
  let badgeSize = Math.max(6, Math.round(contentHeight * 0.15));
  for (const text of [topRight, bottomRight]) {
    if (text !== "") {
      badgeSize = Math.min(badgeSize, fitOneLine(ctx, text, plainFont, contentWidth * 0.4, badgeSize, 6));
    }
  }
  ctx.font = plainFont(badgeSize);
  const topBadgeWidth = topRight === "" ? 0 : ctx.measureText(topRight).width;
  const bottomBadgeWidth = bottomRight === "" ? 0 : ctx.measureText(bottomRight).width;
  // Both rows show the same name at the same size, so the wider badge governs.
  const widestBadge = Math.max(topBadgeWidth, bottomBadgeWidth);
  const nameWidth = Math.max(1, contentWidth - (widestBadge > 0 ? widestBadge + badgeSize * 0.6 : 0));

  // The name is sized next; the order takes whatever height is left between the
  // two copies of it. If that leaves too little room, the name gives some back.
  let nameSize = fitOneLine(ctx, name, nameFont, nameWidth, Math.round(contentHeight * 0.26), 7);
  let nameHeight;
  let bandTop;
  let bandHeight;
  for (let attempt = 0; attempt < 8; attempt++) {
    ctx.font = nameFont(nameSize);
    nameHeight = lineHeight(ctx, nameSize);
    const gap = nameSize * 0.4;
    bandTop = marginPx + nameHeight + gap;
    bandHeight = heightPx - marginPx - nameHeight - gap - bandTop;
    if (bandHeight >= contentHeight * 0.3 || nameSize <= 7) break;
    nameSize = Math.max(7, Math.floor(nameSize * 0.88));
  }
  bandHeight = Math.max(1, bandHeight);

  const orderSize = fitBlock(
    ctx,
    orderText,
    plainFont,
    contentWidth,
    bandHeight,
    Math.round(contentHeight * 0.4),
    6,
  );

  // Name and badge sit on a shared baseline so their differing sizes line up.
  ctx.font = nameFont(nameSize);
  const nameAscent = fontBox(ctx, nameSize).ascent;
  const topBaseline = marginPx + nameAscent;
  const bottomBaseline = heightPx - marginPx - nameHeight + nameAscent;

  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, marginPx, topBaseline, nameWidth);
  ctx.fillText(name, marginPx, bottomBaseline, nameWidth);

  ctx.textAlign = "right";
  ctx.font = plainFont(badgeSize);
  if (topRight !== "") ctx.fillText(topRight, widthPx - marginPx, topBaseline);
  if (bottomRight !== "") ctx.fillText(bottomRight, widthPx - marginPx, bottomBaseline);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = plainFont(orderSize);
  const orderLines = wrapText(ctx, orderText, contentWidth);
  const orderLineHeight = lineHeight(ctx, orderSize);
  let y = bandTop + (bandHeight - orderLines.length * orderLineHeight) / 2;
  for (const line of orderLines) {
    ctx.fillText(line, marginPx, y, contentWidth);
    y += orderLineHeight;
  }

  return thresholdCanvas(canvas, threshold);
}
