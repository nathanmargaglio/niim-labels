/**
 * Parses a spreadsheet-style orders PDF into people and their orders.
 *
 * The expected shape is one printed sheet where the first row is a header
 * containing a `Total` cell followed by one column per person, and every
 * following row names an order in the left-hand column and carries a per-person
 * count under each person's column:
 *
 *     9.21.26        Total   Nate  Richard  Clement  Nathaniel
 *     Chicken Caesar Salad  4   1     1                 2
 *     Chicken Elote Salad   4   2     1        1
 *
 * Cells are recovered from the positions of the PDF's text runs, so the parser
 * works from x/y coordinates rather than any table structure (printed
 * spreadsheets carry none).
 *
 * This module is deliberately free of browser APIs so it can be unit tested.
 */

/** Matches the header cell that separates the row labels from the person columns. */
const TOTAL_LABEL = /^totals?$/i;

/** Gap between two text runs, in points, above which they are separate words. */
const WORD_GAP = 0.6;

/** Slack applied to a column's left edge, in points, to absorb rounding. */
const EDGE_SLACK = 0.75;

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Reads a cell as a whole number, or returns null when it is not one. */
export function parseCount(text) {
  const trimmed = text.replace(/[,\s]/g, "");
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** Joins text runs that share a row, inserting a space only where one was printed. */
function joinCells(cells) {
  let out = "";
  let prevRight = null;
  for (const cell of cells) {
    if (out !== "" && (prevRight === null || cell.x - prevRight > WORD_GAP)) out += " ";
    out += cell.text;
    prevRight = cell.x + cell.width;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Groups a page's text runs into rows by their baseline.
 *
 * @param {Array<{str: string, x: number, y: number, width?: number, height?: number}>} items
 * @returns {Array<{y: number, cells: Array<{text: string, x: number, width: number}>}>}
 */
export function itemsToRows(items) {
  const cells = items
    .map((item) => ({
      text: String(item.str ?? "").replace(/\s+/g, " ").trim(),
      x: item.x,
      y: item.y,
      width: item.width ?? 0,
      height: item.height ?? 0,
    }))
    .filter((cell) => cell.text !== "");
  if (cells.length === 0) return [];

  // Rows are separated by at least one line height, so half a line height is a
  // tolerance that absorbs baseline jitter without merging adjacent rows.
  const heights = cells.map((c) => c.height).filter((h) => h > 0);
  const tolerance = heights.length ? Math.min(Math.max(median(heights) * 0.5, 0.35), 8) : 1;

  cells.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const cell of cells) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.y - cell.y) <= tolerance) current.cells.push(cell);
    else rows.push({ y: cell.y, cells: [cell] });
  }
  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Locates the header row and derives the horizontal extent of every column
 * that follows the `Total` cell.
 */
function readHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cellIndex = rows[i].cells.findIndex((cell) => TOTAL_LABEL.test(cell.text));
    // A usable header needs at least one person column after the Total cell.
    if (cellIndex < 0 || rows[i].cells.length - cellIndex < 2) continue;

    const cells = rows[i].cells;
    const columns = cells.slice(cellIndex + 1).map((cell) => ({
      name: cell.text,
      x: cell.x,
      // A column headed by a bare number is a sheet-level total, not a person.
      isPerson: parseCount(cell.text) === null,
    }));

    const pitches = [];
    for (let c = 1; c < columns.length; c++) pitches.push(columns[c].x - columns[c - 1].x);
    // The rightmost column has no neighbour to bound it; a typical column width
    // keeps unheaded trailing totals from being read as that person's count.
    const pitch = Math.max(pitches.length ? median(pitches) : 24, 1);

    columns.forEach((column, c) => {
      column.start = c === 0 ? column.x - EDGE_SLACK : column.x;
      column.end = c + 1 < columns.length ? columns[c + 1].x : column.x + pitch;
    });

    return {
      rowIndex: i,
      title: joinCells(cells.slice(0, cellIndex)),
      totalX: cells[cellIndex].x,
      columns,
    };
  }
  return null;
}

/** Extracts the order rows of a single page. Returns null if it has no header. */
function parsePage(items) {
  const rows = itemsToRows(items);
  const header = readHeader(rows);
  if (!header) return null;

  const { columns, totalX } = header;
  const firstColumnStart = columns[0].start;
  const orders = [];

  for (const row of rows.slice(header.rowIndex + 1)) {
    const order = joinCells(row.cells.filter((cell) => cell.x < totalX - EDGE_SLACK));
    // Blank spacer rows and the sheet's own grand-total row have no order name.
    if (order === "" || TOTAL_LABEL.test(order)) continue;

    let declaredTotal = null;
    const counts = [];
    for (const cell of row.cells) {
      if (cell.x < totalX - EDGE_SLACK) continue;
      if (cell.x < firstColumnStart) {
        if (declaredTotal === null) declaredTotal = parseCount(cell.text);
        continue;
      }
      const column = columns.find((c) => cell.x >= c.start && cell.x < c.end);
      if (!column || !column.isPerson) continue;
      const count = parseCount(cell.text);
      if (count !== null && count > 0) counts.push({ person: column.name, count });
    }
    orders.push({ order, counts, declaredTotal });
  }

  return { title: header.title, people: columns.filter((c) => c.isPerson).map((c) => c.name), orders };
}

/**
 * Parses every page of a sheet and merges them into one set of people.
 *
 * Wide sheets print as several pages, each repeating the header, so people and
 * orders are merged by name across pages.
 *
 * @param {Array<Array<object>>} pages One array of text runs per PDF page.
 * @returns {{title: string, people: Array, orders: string[], warnings: string[], totalLabels: number}}
 */
export function parsePages(pages) {
  const warnings = [];
  const byPerson = new Map();
  const orderRank = new Map();
  const personRank = new Map();
  let title = "";
  let parsedPages = 0;

  pages.forEach((items, pageIndex) => {
    const page = parsePage(items);
    if (!page) return;
    parsedPages++;
    if (title === "" && page.title !== "") title = page.title;
    // Keep people in the order their columns appear on the sheet.
    for (const person of page.people) if (!personRank.has(person)) personRank.set(person, personRank.size);

    for (const { order, counts, declaredTotal } of page.orders) {
      if (!orderRank.has(order)) orderRank.set(order, orderRank.size);

      const sum = counts.reduce((acc, entry) => acc + entry.count, 0);
      if (declaredTotal !== null && declaredTotal !== sum) {
        warnings.push(
          `Page ${pageIndex + 1}: "${order}" lists a total of ${declaredTotal} but the person ` +
            `columns add up to ${sum}. Check that row before printing.`,
        );
      }

      for (const { person, count } of counts) {
        if (!byPerson.has(person)) byPerson.set(person, { name: person, items: new Map(), total: 0 });
        const record = byPerson.get(person);
        record.items.set(order, (record.items.get(order) ?? 0) + count);
        record.total += count;
      }
    }
  });

  if (parsedPages === 0) {
    warnings.push(
      "No order table found. The sheet needs a header row with a “Total” cell followed by one column per person.",
    );
  }

  const people = [...byPerson.values()]
    .map((record) => ({
      name: record.name,
      total: record.total,
      items: [...record.items.entries()]
        .map(([order, count]) => ({ order, count }))
        .sort((a, b) => orderRank.get(a.order) - orderRank.get(b.order)),
    }))
    .filter((person) => person.total > 0)
    .sort((a, b) => (personRank.get(a.name) ?? 0) - (personRank.get(b.name) ?? 0));

  const orders = [...orderRank.keys()];
  const totalLabels = people.reduce((acc, person) => acc + person.total, 0);

  if (parsedPages > 0 && totalLabels === 0) {
    warnings.push("The order table was found but every count in it is zero, so there is nothing to print.");
  }

  return { title, people, orders, warnings, totalLabels };
}

/**
 * Flattens people and their orders into the sequence of labels to print.
 *
 * Every label carries two fixed indexes — its place among that person's orders
 * and its place in the whole sheet — so neither changes with what is selected
 * for printing. `position` is its place in the returned list, which is what the
 * range controls address.
 *
 * @param {object} sheet Result of {@link parsePages}.
 * @param {{people?: string[]|null}} [options] `people` narrows the list to those names.
 */
export function buildQueue(sheet, options = {}) {
  const { people = null } = options;

  // Built over everyone first, so the sheet-wide index survives filtering.
  const all = [];
  for (const person of sheet.people) {
    let nth = 0;
    for (const item of person.items) {
      for (let copy = 0; copy < item.count; copy++) {
        nth++;
        all.push({
          person: person.name,
          order: item.order,
          personIndex: nth,
          personTotal: person.total,
          sheetPosition: all.length + 1,
          sheetTotal: 0,
        });
      }
    }
  }
  for (const label of all) label.sheetTotal = all.length;

  const selected = people ? all.filter((label) => people.includes(label.person)) : all;
  return selected.map((label, index) => ({ ...label, position: index + 1 }));
}
