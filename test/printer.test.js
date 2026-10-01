import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FakeB1Port, installFakeSerial } from "./fake-b1.js";

// Drive the bundle the site actually ships, not the npm package it was built
// from, so a bad vendor build fails here too.
const bundle = fs.readFileSync(new URL("../vendor/niimbluelib.js", import.meta.url), "utf8");
globalThis.niimbluelib = new Function(`${bundle}\nreturn niimbluelib;`)();

const { PrinterSession, transportSupport } = await import("../js/printer.js");

/** Stands in for a rendered label: white, with one black row so it has ink. */
function labelCanvas(width = 384, height = 240) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 0; x < width; x++) data.set([0, 0, 0, 255], (12 * width + x) * 4);
  return { width, height, getContext: () => ({ getImageData: () => ({ data, width, height }) }) };
}

/** Connects a session to `port` over USB and arranges for both to be torn down. */
async function connectUsb(t, port) {
  const uninstall = installFakeSerial(port);
  const session = new PrinterSession();
  t.after(async () => {
    await session.disconnect();
    uninstall();
  });
  await session.connect("usb");
  return session;
}

test("offers USB only where the browser has Web Serial", (t) => {
  assert.deepEqual(transportSupport(), { bluetooth: false, usb: false });
  const uninstall = installFakeSerial(new FakeB1Port());
  t.after(uninstall);
  assert.deepEqual(transportSupport(), { bluetooth: false, usb: true });
});

test("connects over USB and identifies the printer", async (t) => {
  const port = new FakeB1Port();
  const session = await connectUsb(t, port);

  assert.equal(port.baudRate, 115200);
  const status = session.status();
  assert.equal(status.connected, true);
  assert.equal(status.transport, "usb");
  assert.equal(status.model, "B1");
  // A USB port has no advertised name, so the model names the printer.
  assert.equal(status.name, "B1 · USB");
  assert.equal(status.deviceName, "");
  assert.equal(status.serial, "G327071185");
  assert.equal(status.dpi, 203);
  assert.equal(status.printheadPixels, 384);
  assert.equal(session.client.getPrintTaskType(), "B1");
});

test("prints over USB", async (t) => {
  const port = new FakeB1Port();
  const session = await connectUsb(t, port);

  const progress = [];
  const result = await session.print({
    count: 3,
    renderPage: () => labelCanvas(),
    copies: 1,
    density: 4,
    labelType: 1,
    onProgress: ({ printed, total }) => progress.push(`${printed}/${total}`),
  });

  assert.deepEqual(result, { printed: 3, cancelled: false });
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
  assert.equal(port.printed.pages, 3);
  assert.equal(port.printed.starts, 1);
  assert.equal(port.printed.density, 4);
  assert.equal(port.printed.labelType, 1);
  assert.deepEqual(port.printed.sizes, Array(3).fill({ rows: 240, cols: 384 }));
  assert.ok(port.printed.rows > 0, "bitmap rows were sent");
  assert.ok(port.printed.ends >= 1, "the run was closed with PrintEnd");
  assert.deepEqual(port.unanswered, []);
});

test("prints copies of each label over USB", async (t) => {
  const port = new FakeB1Port();
  const session = await connectUsb(t, port);

  const result = await session.print({ count: 2, renderPage: () => labelCanvas(), copies: 2, density: 3, labelType: 1 });

  assert.deepEqual(result, { printed: 4, cancelled: false });
  assert.equal(port.printed.pages, 4);
  assert.equal(port.printed.sizes.length, 2, "each label is sent once with a copy count");
});

test("stops between labels when cancelled", async (t) => {
  const port = new FakeB1Port();
  const session = await connectUsb(t, port);

  let done = 0;
  const result = await session.print({
    count: 5,
    renderPage: () => labelCanvas(),
    density: 3,
    labelType: 1,
    onProgress: () => done++,
    isCancelled: () => done >= 2,
  });

  assert.deepEqual(result, { printed: 2, cancelled: true });
  assert.equal(port.printed.pages, 2);
  assert.ok(port.printed.ends >= 1, "a cancelled run still ends the print");
});

test("unplugging the cable drops the connection", async (t) => {
  const port = new FakeB1Port();
  const session = await connectUsb(t, port);
  const seen = [];
  session.onChange((status) => seen.push(status.connected));

  port.unplug();

  assert.equal(session.isConnected(), false);
  assert.deepEqual(seen, [false]);
});

test("a late disconnect from a replaced connection is ignored", async (t) => {
  const first = new FakeB1Port();
  const session = await connectUsb(t, first);

  // Reconnect to a second port, as when switching printers or transports.
  const second = new FakeB1Port();
  const uninstall = installFakeSerial(second);
  t.after(uninstall);
  await session.connect("usb");

  // The first connection reporting its loss afterwards must not end the second.
  first.unplug();

  assert.equal(session.isConnected(), true);
  assert.equal(session.status().transport, "usb");
  assert.equal(first.closed, true, "the first port was released");
});

test("dismissing the port picker fails cleanly", async (t) => {
  const uninstall = installFakeSerial(null);
  t.after(uninstall);
  const session = new PrinterSession();

  await assert.rejects(session.connect("usb"), /No port selected/);
  assert.equal(session.isConnected(), false);
});

test("a port held by another program fails cleanly", async (t) => {
  const busy = new DOMException("Failed to open serial port.", "NetworkError");
  const uninstall = installFakeSerial(new FakeB1Port({ openError: busy }));
  t.after(uninstall);
  const session = new PrinterSession();

  await assert.rejects(session.connect("usb"), /Failed to open serial port/);
  assert.equal(session.isConnected(), false);
});

test("a port that is not a printer is released after the handshake fails", async (t) => {
  const port = new FakeB1Port({ silent: true });
  const uninstall = installFakeSerial(port);
  t.after(uninstall);
  const session = new PrinterSession();

  await assert.rejects(session.connect("usb"), /initial negotiate/);
  assert.equal(session.isConnected(), false);
  assert.equal(port.closed, true);
});

test("refuses a transport the browser lacks", async (t) => {
  const session = new PrinterSession();
  // Should a connect wrongly succeed, its heartbeat must not keep the run alive.
  t.after(() => session.disconnect());
  await assert.rejects(session.connect("bluetooth"), /cannot use Bluetooth printers/);
  await assert.rejects(session.connect("usb"), /cannot use USB printers/);
});
