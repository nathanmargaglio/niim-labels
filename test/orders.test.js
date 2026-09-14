import test from "node:test";
import assert from "node:assert/strict";
import { parsePages, buildQueue, itemsToRows, parseCount } from "../js/orders.js";

/**
 * Builds the text runs a printed spreadsheet produces.
 *
 * Every cell becomes one run positioned the way pdf.js reports it: `x` is the
 * left edge of the run and `y` its baseline, measured from the bottom of the
 * page.
 */
function sheet({ header, rows, top = 700, rowGap = 3, charWidth = 0.9, height = 2 }) {
  const run = (text, x, y) => ({ str: text, x, y, width: text.length * charWidth, height });
  const items = [];
  for (const [text, x] of header) items.push(run(text, x, top));
  rows.forEach((cells, index) => {
    for (const [text, x] of cells) items.push(run(text, x, top - rowGap * (index + 1)));
  });
  return items;
}

/** Columns laid out like the real sheet: a Total column, then one per person. */
const HEADER = [
  ["9.21.26", 78],
  ["Total", 113],
  ["Nate", 119],
  ["Richard", 127],
  ["Clement", 136],
  ["Nathaniel", 145],
];

test("parseCount accepts whole numbers only", () => {
  assert.equal(parseCount("4"), 4);
  assert.equal(parseCount(" 1,024 "), 1024);
  assert.equal(parseCount("Nate"), null);
  assert.equal(parseCount("1.5"), null);
  assert.equal(parseCount(""), null);
});

test("itemsToRows groups runs by baseline and orders them left to right", () => {
  const rows = itemsToRows([
    { str: "b", x: 20, y: 100, width: 2, height: 2 },
    { str: "a", x: 10, y: 100.3, width: 2, height: 2 },
    { str: "c", x: 10, y: 96, width: 2, height: 2 },
    { str: "   ", x: 30, y: 100, width: 2, height: 2 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0].cells.map((c) => c.text),
    ["a", "b"],
  );
  assert.deepEqual(
    rows[1].cells.map((c) => c.text),
    ["c"],
  );
});

test("reads counts into the person column they sit under", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      rows: [
        [["Chicken Caesar Salad", 51], ["4", 115], ["1", 120], ["1", 129], ["2", 147]],
        [["Chicken Elote Salad", 51], ["4", 115], ["2", 120], ["1", 129], ["1", 138]],
      ],
    }),
  ]);

  assert.equal(parsed.title, "9.21.26");
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.orders, ["Chicken Caesar Salad", "Chicken Elote Salad"]);
  assert.equal(parsed.totalLabels, 8);
  assert.deepEqual(
    parsed.people.map((p) => [p.name, p.total]),
    [
      ["Nate", 3],
      ["Richard", 2],
      ["Clement", 1],
      ["Nathaniel", 2],
    ],
  );
  assert.deepEqual(parsed.people[0].items, [
    { order: "Chicken Caesar Salad", count: 1 },
    { order: "Chicken Elote Salad", count: 2 },
  ]);
});

test("ignores zero counts, blank rows and the sheet's own total row", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      rows: [
        [["Chicken Caesar Salad", 51], ["1", 115], ["0", 120], ["1", 129], ["0", 147]],
        [["0", 115]],
        [],
        [["Total", 51], ["1", 115], ["0", 120], ["1", 129]],
      ],
    }),
  ]);

  assert.deepEqual(parsed.orders, ["Chicken Caesar Salad"]);
  assert.deepEqual(
    parsed.people.map((p) => p.name),
    ["Richard"],
  );
  assert.equal(parsed.totalLabels, 1);
});

test("ignores an unheaded total column to the right of the last person", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      // The trailing 3 sits past Nathaniel's column, as a row total does.
      rows: [[["Chicken Caesar Salad", 51], ["3", 115], ["1", 120], ["2", 147], ["3", 200]]],
    }),
  ]);

  assert.equal(parsed.totalLabels, 3);
  assert.deepEqual(
    parsed.people.map((p) => [p.name, p.total]),
    [
      ["Nate", 1],
      ["Nathaniel", 2],
    ],
  );
});

test("warns when a row's own total disagrees with its person columns", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      rows: [[["Chicken Caesar Salad", 51], ["9", 115], ["1", 120], ["2", 147]]],
    }),
  ]);

  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /Chicken Caesar Salad.*9.*3/);
  // The counts are still returned so a mis-totalled sheet can be printed anyway.
  assert.equal(parsed.totalLabels, 3);
});

test("merges people and orders across pages", () => {
  const page = (rows) => sheet({ header: HEADER, rows });
  const parsed = parsePages([
    page([[["Chicken Caesar Salad", 51], ["1", 115], ["1", 120]]]),
    page([[["Chicken Caesar Salad", 51], ["2", 115], ["1", 120], ["1", 129]]]),
  ]);

  assert.deepEqual(parsed.orders, ["Chicken Caesar Salad"]);
  assert.deepEqual(
    parsed.people.map((p) => [p.name, p.total]),
    [
      ["Nate", 2],
      ["Richard", 1],
    ],
  );
});

test("reports a sheet with no recognisable table", () => {
  const parsed = parsePages([[{ str: "Just some prose", x: 50, y: 700, width: 30, height: 2 }]]);
  assert.equal(parsed.people.length, 0);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /No order table found/);
});

test("stitches an order name split across several text runs", () => {
  const parsed = parsePages([
    [
      { str: "Total", x: 113, y: 700, width: 4, height: 2 },
      { str: "Nate", x: 119, y: 700, width: 4, height: 2 },
      { str: "Chick", x: 51, y: 697, width: 5, height: 2 },
      // Abuts the previous run, so it is the same word.
      { str: "en", x: 56.1, y: 697, width: 2, height: 2 },
      { str: "Salad", x: 60, y: 697, width: 5, height: 2 },
      { str: "1", x: 120, y: 697, width: 1, height: 2 },
    ],
  ]);
  assert.deepEqual(parsed.orders, ["Chicken Salad"]);
});

test("buildQueue expands counts in sheet order, indexed per person and per sheet", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      rows: [
        [["Chicken Caesar Salad", 51], ["3", 115], ["1", 120], ["2", 147]],
        [["Chicken Elote Salad", 51], ["2", 115], ["2", 120]],
      ],
    }),
  ]);

  assert.deepEqual(
    buildQueue(parsed).map((l) => `${l.position}|${l.person}|${l.order}|${l.personIndex}/${l.personTotal}|${l.sheetPosition}/${l.sheetTotal}`),
    [
      "1|Nate|Chicken Caesar Salad|1/3|1/5",
      "2|Nate|Chicken Elote Salad|2/3|2/5",
      "3|Nate|Chicken Elote Salad|3/3|3/5",
      "4|Nathaniel|Chicken Caesar Salad|1/2|4/5",
      "5|Nathaniel|Chicken Caesar Salad|2/2|5/5",
    ],
  );
});

test("filtering by person keeps both the person and sheet indexes intact", () => {
  const parsed = parsePages([
    sheet({
      header: HEADER,
      rows: [[["Chicken Caesar Salad", 51], ["3", 115], ["1", 120], ["2", 147]]],
    }),
  ]);

  // position renumbers to the filtered list, but the two fixed indexes do not
  // move: Nathaniel's labels are still 1/2 and 2/2 of his, and 2/3 and 3/3 of
  // the sheet, so the printed label reads the same either way.
  assert.deepEqual(
    buildQueue(parsed, { people: ["Nathaniel"] }).map((l) => [
      l.position,
      l.person,
      `${l.personIndex}/${l.personTotal}`,
      `${l.sheetPosition}/${l.sheetTotal}`,
    ]),
    [
      [1, "Nathaniel", "1/2", "2/3"],
      [2, "Nathaniel", "2/2", "3/3"],
    ],
  );
});
