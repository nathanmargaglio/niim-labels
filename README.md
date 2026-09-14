# Order Labels

A mobile-first web app that turns an orders PDF into one printed label per item
and sends them straight to a **NIIMBOT B1** over Bluetooth. It is a static site —
no server, no build step at runtime — so it runs from GitHub Pages.

Each label is laid out with the person's name top and bottom and the numbered
order in the middle, all left justified:

```
Nate

2. Chicken Elote Salad

Nate
```

## How it works

1. **Load the PDF.** The app reads the printed sheet with pdf.js and recovers the
   table from the positions of the text, since a printed spreadsheet carries no
   table structure of its own. It expects a header row with a `Total` cell
   followed by one column per person, and one row per order:

   |            | Total | Nate | Richard | Clement | Nathaniel |
   | ---------- | ----- | ---- | ------- | ------- | --------- |
   | Chicken Caesar Salad | 4 | 1 | 1 |   | 2 |
   | Chicken Elote Salad  | 4 | 2 | 1 | 1 |   |

   Zero cells, blank rows, the sheet's own grand-total row and any unheaded
   trailing total column are all ignored. Wide sheets that print across several
   pages are merged by person. Every row's own `Total` is compared against its
   person columns, and a mismatch is reported rather than silently printed.

2. **Pick what to print.** Choose everyone or one person, then a range. Each
   label is numbered within that person's own order, so the number on a label
   never changes with what you select — printing `#4–#6` prints exactly the
   labels shown as `#4`, `#5` and `#6`.

3. **Print.** Connect the printer through the browser's Bluetooth picker and
   print. Progress is shown per label and a run can be stopped between labels.

## Browser support

Printing needs [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API),
which is available in **Chrome and Edge on Android, Windows, macOS and Linux**.

**On iPhone and iPad neither Safari nor Chrome supports Web Bluetooth**, so a
Web Bluetooth browser such as Bluefy is required there. Loading a PDF and
checking the labels works in any modern browser.

The page must be served over HTTPS (GitHub Pages is) or from `localhost`.

## Label size

The B1 prints at 203 dpi across a 384 px (48 mm) printhead. The defaults match
the 50 × 30 mm roll that ships with it; a label wider than the printhead is
rendered at the printhead's width, which the preview says when it happens. Label
size, margin, darkness, label type, copies, numbering and font are all in
**Settings** and are remembered on the device.

## Deploying

Pushing to `main` runs the tests and publishes the site through
`.github/workflows/pages.yml`. Enable it once under **Settings → Pages → Build
and deployment → Source → GitHub Actions**.

## Development

```bash
npm install
npm test              # parser unit tests
npm run serve         # http://localhost:8080 — a secure context, so Bluetooth works
npm run build:vendor  # regenerate vendor/ after changing a dependency
```

Nothing in `vendor/` is edited by hand: `tools/build-vendor.mjs` bundles
[`@mmote/niimbluelib`](https://github.com/MultiMote/niimbluelib) (MIT) into a
browser global and copies [`pdfjs-dist`](https://github.com/mozilla/pdf.js)
(Apache-2.0). Both are committed so GitHub Pages can serve the site as-is; CI
rebuilds them and fails if the committed copies have drifted from
`package.json`.

### Layout

| Path                | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `js/orders.js`      | PDF text runs → people, orders and the label queue. No DOM, unit tested. |
| `js/pdf-source.js`  | Reads a PDF into positioned text runs with pdf.js.          |
| `js/label.js`       | Draws one label on a canvas and reduces it to pure black and white. |
| `js/printer.js`     | Web Bluetooth connection and the print run.                 |
| `js/settings.js`    | Settings, validated and persisted in `localStorage`.        |
| `js/app.js`         | UI wiring.                                                  |

Text is thresholded to pure black or white before it is sent, because the
printer treats every non-white pixel as black and anti-aliased glyph edges would
otherwise print as a fattened outline.
