/**
 * Draws a single label onto a canvas at the printer's native resolution.
 *
 * The layout is fixed: the person's name at the top, the numbered order in the
 * middle, the same name again at the bottom, everything left justified.
 *
 *     Nate
 *
 *     2. Chicken Elote Salad
 *
 *     Nate
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

/** Height a line of the current font occupies, including ascender and descender. */
function lineHeight(ctx, fallbackSize) {
  const m = ctx.measureText("Hg");
  if (m.fontBoundingBoxAscent && m.fontBoundingBoxDescent) {
    return m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  }
  return fallbackSize * 1.2;
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
 * @param {{person: string, number: number, order: string}} label
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
  const orderFont = (size) => `${size}px ${fontFamily}`;
  const name = label.person || "";
  const orderText = `${label.number}. ${label.order}`.trim();

  // The name is sized first; the order takes whatever height is left between the
  // two copies of it. If that leaves too little room, the name gives some back.
  let nameSize = fitOneLine(ctx, name, nameFont, contentWidth, Math.round(contentHeight * 0.26), 7);
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
    orderFont,
    contentWidth,
    bandHeight,
    Math.round(contentHeight * 0.4),
    6,
  );

  ctx.font = nameFont(nameSize);
  ctx.fillText(name, marginPx, marginPx, contentWidth);
  ctx.fillText(name, marginPx, heightPx - marginPx - nameHeight, contentWidth);

  ctx.font = orderFont(orderSize);
  const orderLines = wrapText(ctx, orderText, contentWidth);
  const orderLineHeight = lineHeight(ctx, orderSize);
  const blockHeight = orderLines.length * orderLineHeight;
  let y = bandTop + (bandHeight - blockHeight) / 2;
  for (const line of orderLines) {
    ctx.fillText(line, marginPx, y, contentWidth);
    y += orderLineHeight;
  }

  return thresholdCanvas(canvas, threshold);
}
