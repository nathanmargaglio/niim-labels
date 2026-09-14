import { parsePages, buildQueue } from "./orders.js";
import { readPdfPages } from "./pdf-source.js";
import { renderLabel, mmToPx, pxToMm, FONT_STACKS } from "./label.js";
import { PrinterSession, transportSupport, LABEL_TYPES } from "./printer.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  sourceSummary: $("source-summary"),
  warnings: $("warnings"),

  selectCard: $("select-card"),
  personSelect: $("person-select"),
  rangeFrom: $("range-from"),
  rangeTo: $("range-to"),
  rangeAll: $("range-all"),
  rangeSummary: $("range-summary"),
  queue: $("queue"),

  previewCard: $("preview-card"),
  preview: $("preview"),
  previewPrev: $("preview-prev"),
  previewNext: $("preview-next"),
  previewCaption: $("preview-caption"),
  previewMeta: $("preview-meta"),

  printbar: $("printbar"),
  printButton: $("print-button"),
  cancelButton: $("cancel-button"),
  printProgress: $("print-progress"),
  printBarFill: $("print-bar-fill"),
  printProgressText: $("print-progress-text"),
  printMessage: $("print-message"),

  printerButton: $("printer-button"),
  printerLabel: $("printer-label"),
  printerDot: $("printer-dot"),
  printerDialog: $("printer-dialog"),
  printerDetails: $("printer-details"),
  printerError: $("printer-error"),
  bluetoothNotice: $("bluetooth-notice"),
  connectButton: $("connect-button"),
  disconnectButton: $("disconnect-button"),

  settingsButton: $("settings-button"),
  settingsDialog: $("settings-dialog"),
  settingsReset: $("settings-reset"),
  widthNotice: $("width-notice"),
  setWidth: $("set-width"),
  setHeight: $("set-height"),
  setMargin: $("set-margin"),
  setCopies: $("set-copies"),
  setDensity: $("set-density"),
  setDensityValue: $("set-density-value"),
  setLabelType: $("set-label-type"),
  setNumbering: $("set-numbering"),
  setFont: $("set-font"),
  setBold: $("set-bold"),
};

const printer = new PrinterSession();
const printCanvas = document.createElement("canvas");

const state = {
  sheet: null,
  queue: [],
  from: 1,
  to: 0,
  previewIndex: 0,
  settings: loadSettings(),
  printing: false,
  cancelRequested: false,
};

/* ---------------------------------------------------------------- geometry */

/** Pixel geometry for the current settings, clamped to what the printhead covers. */
function geometry() {
  const caps = printer.capabilities();
  const requestedWidth = mmToPx(state.settings.widthMm, caps.dpi);
  const widthPx = Math.min(requestedWidth, caps.printheadPixels);
  return {
    dpi: caps.dpi,
    widthPx,
    heightPx: mmToPx(state.settings.heightMm, caps.dpi),
    marginPx: mmToPx(state.settings.marginMm, caps.dpi),
    clampedFrom: requestedWidth > caps.printheadPixels ? requestedWidth : null,
    printheadPixels: caps.printheadPixels,
  };
}

function labelStyle(geo) {
  return {
    widthPx: geo.widthPx,
    heightPx: geo.heightPx,
    marginPx: geo.marginPx,
    fontFamily: FONT_STACKS[state.settings.font] ?? FONT_STACKS.sans,
    boldName: state.settings.boldName,
  };
}

/* ------------------------------------------------------------------ source */

async function loadFile(file) {
  if (!file) return;
  setPrintMessage("");
  el.sourceSummary.hidden = false;
  el.sourceSummary.textContent = `Reading ${file.name}…`;

  try {
    const pages = await readPdfPages(await file.arrayBuffer());
    const sheet = parsePages(pages);
    state.sheet = sheet;

    fillPersonSelect(sheet);
    recomputeQueue({ resetRange: true });

    const name = document.createElement("strong");
    name.textContent = file.name;
    const counts = [
      sheet.title,
      `${sheet.people.length} ${plural(sheet.people.length, "person", "people")}`,
      `${sheet.orders.length} ${plural(sheet.orders.length, "order")}`,
      `${sheet.totalLabels} ${plural(sheet.totalLabels, "label")}`,
    ].filter(Boolean);
    el.sourceSummary.replaceChildren(name, document.createElement("br"), counts.join(" · "));
    showWarnings(sheet.warnings);
  } catch (error) {
    state.sheet = null;
    state.queue = [];
    el.selectCard.hidden = true;
    el.previewCard.hidden = true;
    el.printbar.hidden = true;
    el.sourceSummary.textContent = `Could not read ${file.name}.`;
    showWarnings([String(error?.message ?? error)]);
  }
}

function showWarnings(warnings) {
  el.warnings.replaceChildren();
  el.warnings.hidden = warnings.length === 0;
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    el.warnings.append(li);
  }
}

function fillPersonSelect(sheet) {
  const options = [
    optionEl("", `Everyone (${sheet.totalLabels} ${plural(sheet.totalLabels, "label")})`),
    ...sheet.people.map((person) =>
      optionEl(person.name, `${person.name} (${person.total} ${plural(person.total, "label")})`),
    ),
  ];
  el.personSelect.replaceChildren(...options);
  el.personSelect.value = "";
}

function optionEl(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

/* ------------------------------------------------------------------- queue */

function recomputeQueue({ resetRange = false } = {}) {
  if (!state.sheet) return;
  const person = el.personSelect.value;
  state.queue = buildQueue(state.sheet, {
    people: person ? [person] : null,
    numbering: state.settings.numbering,
  });

  if (resetRange || state.from > state.queue.length) state.from = 1;
  if (resetRange || state.to > state.queue.length || state.to < 1) state.to = state.queue.length;
  clampRange();

  const hasLabels = state.queue.length > 0;
  el.selectCard.hidden = false;
  el.previewCard.hidden = !hasLabels;
  el.printbar.hidden = !hasLabels;

  state.previewIndex = Math.min(Math.max(state.previewIndex, state.from - 1), Math.max(state.to - 1, 0));
  renderQueue();
  renderRangeControls();
  renderPreview();
  updatePrintButton();
}

function clampRange() {
  const max = state.queue.length;
  state.from = Math.min(Math.max(Math.round(state.from) || 1, 1), Math.max(max, 1));
  state.to = Math.min(Math.max(Math.round(state.to) || max, state.from), Math.max(max, 1));
}

function renderRangeControls() {
  const max = Math.max(state.queue.length, 1);
  el.rangeFrom.max = String(max);
  el.rangeTo.max = String(max);
  el.rangeFrom.value = String(state.from);
  el.rangeTo.value = String(state.to);

  const selected = selectionSize();
  const copies = state.settings.copies;
  const sheets = selected * copies;
  el.rangeSummary.textContent = state.queue.length
    ? `${state.queue.length} ${plural(state.queue.length, "label")} in this selection — ` +
      `printing ${selected} of them (#${state.from}–#${state.to})` +
      (copies > 1 ? `, ${copies} copies each — ${sheets} ${plural(sheets, "sticker")}` : "")
    : "Nothing to print for this person.";
}

function selectionSize() {
  return state.queue.length === 0 ? 0 : state.to - state.from + 1;
}

function renderQueue() {
  const rows = state.queue.map((label) => {
    const li = document.createElement("li");
    li.className = "queue-row";
    li.dataset.position = String(label.position);

    const num = document.createElement("span");
    num.className = "queue-num";
    num.textContent = `#${label.position}`;

    const body = document.createElement("button");
    body.type = "button";
    body.className = "queue-body";
    const person = document.createElement("span");
    person.className = "queue-person";
    person.textContent = label.person;
    const order = document.createElement("span");
    order.className = "queue-order";
    order.textContent = `${label.number}. ${label.order}`;
    body.append(person, order);
    body.addEventListener("click", () => {
      state.previewIndex = label.position - 1;
      renderQueue();
      renderPreview();
    });

    const actions = document.createElement("span");
    actions.className = "queue-actions";
    actions.append(
      rangeButton("From", `Start printing at label ${label.position}`, () => {
        state.from = label.position;
        if (state.to < state.from) state.to = state.from;
        onRangeChanged();
      }),
      rangeButton("To", `Stop printing at label ${label.position}`, () => {
        state.to = label.position;
        if (state.from > state.to) state.from = state.to;
        onRangeChanged();
      }),
    );

    li.append(num, body, actions);
    return li;
  });

  el.queue.replaceChildren(...rows);
  paintQueueState();
}

function rangeButton(text, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

/** Updates only the classes that depend on the range, without rebuilding rows. */
function paintQueueState() {
  for (const row of el.queue.children) {
    const position = Number(row.dataset.position);
    row.classList.toggle("in-range", position >= state.from && position <= state.to);
    row.classList.toggle("selected", position === state.previewIndex + 1);
  }
}

function onRangeChanged() {
  clampRange();
  state.previewIndex = Math.min(Math.max(state.previewIndex, state.from - 1), state.to - 1);
  renderRangeControls();
  paintQueueState();
  renderPreview();
  updatePrintButton();
}

/* ----------------------------------------------------------------- preview */

function renderPreview() {
  const label = state.queue[state.previewIndex];
  if (!label) {
    el.previewCaption.textContent = "";
    el.previewMeta.textContent = "";
    return;
  }

  const geo = geometry();
  renderLabel(el.preview, label, labelStyle(geo));

  const inRange = label.position >= state.from && label.position <= state.to;
  el.previewCaption.textContent =
    `#${label.position} of ${state.queue.length} · ${label.person} ${label.personIndex}/${label.personTotal}` +
    (inRange ? "" : " · outside the print range");
  el.previewMeta.textContent =
    `${round1(pxToMm(geo.widthPx, geo.dpi))} × ${round1(pxToMm(geo.heightPx, geo.dpi))} mm ` +
    `· ${geo.widthPx} × ${geo.heightPx} px at ${geo.dpi} dpi` +
    (geo.clampedFrom === null ? "" : ` · width limited by the ${geo.printheadPixels} px printhead`);

  el.previewPrev.disabled = state.previewIndex <= 0;
  el.previewNext.disabled = state.previewIndex >= state.queue.length - 1;
}

function stepPreview(delta) {
  const next = state.previewIndex + delta;
  if (next < 0 || next >= state.queue.length) return;
  state.previewIndex = next;
  paintQueueState();
  renderPreview();
  el.queue.children[next]?.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------------- print */

function updatePrintButton() {
  const selected = selectionSize();
  const sheets = selected * state.settings.copies;
  const connected = printer.isConnected();
  el.printButton.disabled = state.printing || selected === 0 || !connected;
  el.printButton.textContent = state.printing
    ? "Printing…"
    : selected === 0
      ? "Nothing selected"
      : !connected
        ? `Connect a printer to print ${sheets} ${plural(sheets, "label")}`
        : `Print ${sheets} ${plural(sheets, "label")}`;
}

function setPrintMessage(text, kind = "") {
  el.printMessage.textContent = text;
  el.printMessage.className = `printbar-message${kind ? ` ${kind}` : ""}`;
  el.printMessage.hidden = text === "";
}

async function startPrint() {
  if (state.printing || !printer.isConnected()) return;
  const slice = state.queue.slice(state.from - 1, state.to);
  if (slice.length === 0) return;

  const geo = geometry();
  const style = labelStyle(geo);

  state.printing = true;
  state.cancelRequested = false;
  setPrintMessage("");
  el.cancelButton.hidden = false;
  el.printProgress.hidden = false;
  setProgress(0, slice.length * state.settings.copies);
  updatePrintButton();

  try {
    const { printed, cancelled } = await printer.print({
      count: slice.length,
      renderPage: (index) => renderLabel(printCanvas, slice[index], style),
      copies: state.settings.copies,
      density: state.settings.density,
      labelType: state.settings.labelType,
      onProgress: ({ printed: done, total }) => setProgress(done, total),
      isCancelled: () => state.cancelRequested,
    });
    setPrintMessage(
      cancelled
        ? `Stopped after ${printed} ${plural(printed, "label")}.`
        : `Printed ${printed} ${plural(printed, "label")}.`,
      cancelled ? "" : "ok",
    );
  } catch (error) {
    setPrintMessage(describeError(error), "error");
  } finally {
    state.printing = false;
    state.cancelRequested = false;
    el.cancelButton.hidden = true;
    el.printProgress.hidden = true;
    updatePrintButton();
  }
}

function setProgress(done, total) {
  el.printBarFill.style.width = `${total ? (done / total) * 100 : 0}%`;
  el.printProgressText.textContent = `${done} of ${total}`;
}

function describeError(error) {
  const message = String(error?.message ?? error);
  if (/user cancelled|user denied|chooser/i.test(message)) return "No printer was selected.";
  if (/not connected|gatt/i.test(message)) return "Lost the connection to the printer. Reconnect and try again.";
  return message;
}

/* ----------------------------------------------------------------- printer */

let lastPrinterSignature = "";

function renderPrinterState() {
  const status = printer.status();
  el.printerButton.classList.toggle("connected", status.connected);
  el.printerLabel.textContent = status.connected ? status.deviceName || status.model : "Not connected";
  el.connectButton.hidden = status.connected;
  el.disconnectButton.hidden = !status.connected;
  el.printerDetails.hidden = !status.connected;

  if (status.connected) {
    const rows = [
      ["Model", status.model],
      ["Device", status.deviceName || "—"],
      ["Resolution", `${status.dpi} dpi · ${status.printheadPixels} px wide`],
      status.battery != null ? ["Battery", `${status.battery}%`] : null,
      status.paperInserted != null ? ["Paper", status.paperInserted ? "Loaded" : "Not detected"] : null,
      status.lidClosed != null ? ["Lid", status.lidClosed ? "Closed" : "Open"] : null,
      status.softwareVersion ? ["Firmware", status.softwareVersion] : null,
      status.serial ? ["Serial", status.serial] : null,
    ].filter(Boolean);

    el.printerDetails.replaceChildren(
      ...rows.flatMap(([term, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = String(value);
        return [dt, dd];
      }),
    );
  }

  updatePrintButton();

  // Heartbeats land about once a second; only a change of printer changes the
  // geometry the preview is drawn at, so it is not redrawn for a battery tick.
  const signature = `${status.connected}|${status.model}|${status.dpi}|${status.printheadPixels}`;
  if (signature !== lastPrinterSignature) {
    lastPrinterSignature = signature;
    renderPreview();
    updateSettingsNotes();
  }
}

async function connect() {
  el.printerError.hidden = true;
  el.connectButton.disabled = true;
  el.connectButton.textContent = "Connecting…";
  try {
    await printer.connect();
    el.printerDialog.close();
  } catch (error) {
    el.printerError.textContent = describeError(error);
    el.printerError.hidden = false;
  } finally {
    el.connectButton.disabled = false;
    el.connectButton.textContent = "Connect a printer";
  }
}

function checkBluetoothSupport() {
  const { webBluetooth } = transportSupport();
  el.bluetoothNotice.hidden = webBluetooth;
  el.connectButton.disabled = !webBluetooth;
  if (!webBluetooth) {
    el.bluetoothNotice.textContent =
      "This browser cannot talk to Bluetooth devices. Use Chrome or Edge on Android, Windows, macOS or Linux. " +
      "On iPhone and iPad, Safari and Chrome have no Web Bluetooth support — a Web Bluetooth browser such as " +
      "Bluefy is needed. You can still load a PDF here and check the labels.";
  }
}

/* ---------------------------------------------------------------- settings */

/** Writes the stored settings into the form. Only on open and on reset, so that
    a value being typed is never overwritten by its own clamped version. */
function fillSettingsForm() {
  const s = state.settings;
  if (el.setLabelType.options.length === 0) {
    el.setLabelType.replaceChildren(...LABEL_TYPES.map((type) => optionEl(String(type.value), type.label)));
  }
  el.setWidth.value = String(s.widthMm);
  el.setHeight.value = String(s.heightMm);
  el.setMargin.value = String(s.marginMm);
  el.setCopies.value = String(s.copies);
  el.setDensity.value = String(s.density);
  el.setNumbering.value = s.numbering;
  el.setFont.value = s.font;
  el.setBold.checked = s.boldName;
  el.setLabelType.value = String(s.labelType);
  updateSettingsNotes();
}

function updateSettingsNotes() {
  el.setDensityValue.textContent = String(state.settings.density);
  const geo = geometry();
  el.widthNotice.hidden = geo.clampedFrom === null;
  if (geo.clampedFrom !== null) {
    el.widthNotice.textContent =
      `The printhead is ${geo.printheadPixels} px (${round1(pxToMm(geo.printheadPixels, geo.dpi))} mm) wide, ` +
      `so labels are rendered at that width instead of ${geo.clampedFrom} px.`;
  }
}

function applySettingsFromForm() {
  const previousNumbering = state.settings.numbering;
  state.settings = saveSettings({
    ...state.settings,
    widthMm: Number(el.setWidth.value),
    heightMm: Number(el.setHeight.value),
    marginMm: Number(el.setMargin.value),
    copies: Number(el.setCopies.value),
    density: Number(el.setDensity.value),
    labelType: Number(el.setLabelType.value),
    numbering: el.setNumbering.value,
    font: el.setFont.value,
    boldName: el.setBold.checked,
  });

  // Only the numbering scheme changes what the labels say, so only it needs the
  // queue rebuilt; the range survives because no label has moved.
  if (state.settings.numbering !== previousNumbering) {
    recomputeQueue();
  } else {
    renderRangeControls();
    renderPreview();
    updatePrintButton();
  }
  updateSettingsNotes();
}

/* -------------------------------------------------------------- misc utils */

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------ wiring */

el.fileInput.addEventListener("change", () => {
  loadFile(el.fileInput.files?.[0]);
  el.fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove("dragging"));
}
el.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  loadFile(event.dataTransfer?.files?.[0]);
});

el.personSelect.addEventListener("change", () => recomputeQueue({ resetRange: true }));
el.rangeFrom.addEventListener("change", () => {
  state.from = Number(el.rangeFrom.value);
  if (state.to < state.from) state.to = state.from;
  onRangeChanged();
});
el.rangeTo.addEventListener("change", () => {
  state.to = Number(el.rangeTo.value);
  if (state.from > state.to) state.from = state.to;
  onRangeChanged();
});
el.rangeAll.addEventListener("click", () => {
  state.from = 1;
  state.to = state.queue.length;
  onRangeChanged();
});

el.previewPrev.addEventListener("click", () => stepPreview(-1));
el.previewNext.addEventListener("click", () => stepPreview(1));

el.printButton.addEventListener("click", startPrint);
el.cancelButton.addEventListener("click", () => {
  state.cancelRequested = true;
  el.cancelButton.disabled = true;
  setPrintMessage("Stopping after the current label…");
  setTimeout(() => (el.cancelButton.disabled = false), 500);
});

el.printerButton.addEventListener("click", () => {
  checkBluetoothSupport();
  el.printerError.hidden = true;
  el.printerDialog.showModal();
});
el.connectButton.addEventListener("click", connect);
el.disconnectButton.addEventListener("click", () => printer.disconnect());

el.settingsButton.addEventListener("click", () => {
  fillSettingsForm();
  el.settingsDialog.showModal();
});
for (const input of [
  el.setWidth,
  el.setHeight,
  el.setMargin,
  el.setCopies,
  el.setDensity,
  el.setLabelType,
  el.setNumbering,
  el.setFont,
  el.setBold,
]) {
  input.addEventListener("input", applySettingsFromForm);
}
el.settingsReset.addEventListener("click", () => {
  state.settings = saveSettings({ ...DEFAULTS });
  fillSettingsForm();
  recomputeQueue();
});

printer.onChange(renderPrinterState);

checkBluetoothSupport();
renderPrinterState();
fillSettingsForm();
