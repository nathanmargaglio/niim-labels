/**
 * An emulated NIIMBOT B1 behind a fake Web Serial port, for driving the USB
 * transport without hardware.
 *
 * The connection handshake is answered with bytes captured from a real B1 on
 * firmware 5.22, taken from niimbluelib's own test dumps (MIT). The print
 * commands, which that capture does not cover, are acknowledged with the
 * response each one is defined to expect in niimbluelib's command map, and the
 * emulator keeps count of what it was asked to print.
 */

/** Request (after any leading 0x03) → response, from niimbluelib's B1_V5_22 dump. */
const B1_HANDSHAKE = `
55 55 c1 01 01 c1 aa aa | 55 55 c2 01 03 c0 aa aa
55 55 a5 01 01 a5 aa aa | 55 55 b5 10 30 30 03 20 00 c8 00 00 00 0f 01 02 04 01 98 00 df aa aa
55 55 40 01 08 49 aa aa | 55 55 48 02 10 00 5a aa aa
55 55 40 01 0b 4a aa aa | 55 55 4b 0a 47 33 32 37 30 37 31 31 38 35 3a aa aa
55 55 40 01 0d 4c aa aa | 55 55 4d 06 27 03 07 17 6e 82 93 aa aa
55 55 40 01 0a 4b aa aa | 55 55 4a 01 04 4f aa aa
55 55 40 01 07 46 aa aa | 55 55 47 01 01 47 aa aa
55 55 40 01 03 42 aa aa | 55 55 43 01 01 43 aa aa
55 55 40 01 0c 4d aa aa | 55 55 4c 02 05 0a 41 aa aa
55 55 40 01 09 48 aa aa | 55 55 49 02 05 16 58 aa aa
55 55 dc 01 03 de aa aa | 55 55 de 0a 05 0a 05 16 01 80 02 02 01 00 48 aa aa
55 55 dc 01 04 d9 aa aa | 55 55 d9 09 20 41 04 4d 00 00 01 00 00 f9 aa aa
55 55 1a 01 01 1a aa aa | 55 55 1b 27 88 1d 7e 4f d9 97 00 00 08 31 30 32 36 32 32 36 30 10 50 5a 31 47 32 32 31 33 32 32 30 30 34 32 30 35 01 14 00 99 01 3d aa aa
`;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text) => Uint8Array.from(text.trim().split(/\s+/), (b) => Number.parseInt(b, 16));

const handshake = new Map(
  B1_HANDSHAKE.trim()
    .split("\n")
    .map((line) => line.split("|").map(unhex))
    .map(([request, response]) => [hex(request), response]),
);

/** Builds a packet: 55 55 <command> <length> <data…> <xor checksum> aa aa. */
function packet(command, data) {
  let checksum = command ^ data.length;
  for (const byte of data) checksum ^= byte;
  return Uint8Array.from([0x55, 0x55, command, data.length, ...data, checksum, 0xaa, 0xaa]);
}

/** Commands that are acknowledged with a single 0x01 byte, keyed request → response id. */
const ACKNOWLEDGED = {
  0x01: 0x02, // PrintStart
  0x03: 0x04, // PageStart
  0x13: 0x14, // SetPageSize
  0x21: 0x31, // SetDensity
  0x23: 0x33, // SetLabelType
  0xe3: 0xe4, // PageEnd
  0xf3: 0xf4, // PrintEnd
};

/** Bitmap row commands, which the printer takes without answering. */
const ROW_COMMANDS = new Set([0x83, 0x84, 0x85]);

export class FakeB1Port extends EventTarget {
  /**
   * @param {object} [options]
   * @param {boolean} [options.silent] Never answer, like a port that is not a printer.
   * @param {Error} [options.openError] Make open() fail, like a port held by another program.
   */
  constructor({ silent = false, openError = null } = {}) {
    super();
    this.silent = silent;
    this.openError = openError;
    this.readable = null;
    this.writable = null;
    this.baudRate = null;
    this.closed = false;
    this.unanswered = [];
    this.printed = { pages: 0, rows: 0, starts: 0, ends: 0, density: null, labelType: null, sizes: [] };
    this.pendingQuantity = 1;
    this.buffer = new Uint8Array(0);
  }

  getInfo() {
    return { usbVendorId: 0x3513, usbProductId: 0x0002 };
  }

  async open({ baudRate }) {
    if (this.openError) throw this.openError;
    this.baudRate = baudRate;
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream({ write: (chunk) => this.receive(chunk) });
  }

  async close() {
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }

  /** Simulates the cable being pulled. */
  unplug() {
    this.dispatchEvent(new Event("disconnect"));
  }

  send(bytes) {
    // A real port delivers asynchronously; answering on a later task keeps the
    // request/response ordering the client expects.
    setTimeout(() => this.controller?.enqueue(bytes), 1);
  }

  receive(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    for (;;) {
      const start = this.buffer.findIndex((b, i) => b === 0x55 && this.buffer[i + 1] === 0x55);
      if (start < 0 || this.buffer.length < start + 4) return;
      const end = start + 4 + this.buffer[start + 3] + 3;
      if (this.buffer.length < end) return;
      this.handle(this.buffer.slice(start, end));
      this.buffer = this.buffer.slice(end);
    }
  }

  handle(request) {
    const command = request[2];
    const data = request.slice(4, 4 + request[3]);
    if (this.silent) return;

    const captured = handshake.get(hex(request));
    if (captured) return this.send(captured);

    if (ROW_COMMANDS.has(command)) {
      this.printed.rows++;
      return;
    }
    if (command === 0x21) this.printed.density = data[0];
    if (command === 0x23) this.printed.labelType = data[0];
    if (command === 0x01) this.printed.starts++;
    if (command === 0xf3) this.printed.ends++;
    if (command === 0x13) {
      // rows, cols and copies, each a big-endian u16.
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.printed.sizes.push({ rows: view.getUint16(0), cols: view.getUint16(2) });
      this.pendingQuantity = data.length >= 6 ? view.getUint16(4) : 1;
    }
    if (command === 0xe3) this.printed.pages += this.pendingQuantity;

    if (command in ACKNOWLEDGED) return this.send(packet(ACKNOWLEDGED[command], [1]));

    if (command === 0xa3) {
      // PrintStatus: pages printed so far, then print and feed progress.
      const pages = this.printed.pages;
      return this.send(packet(0xb3, [pages >> 8, pages & 0xff, 100, 100]));
    }

    this.unanswered.push(hex(request));
  }
}

/** navigator.serial as it was before any fake was installed. */
const originalSerial = Object.getOwnPropertyDescriptor(globalThis.navigator, "serial");

/**
 * Installs a fake navigator.serial whose port picker hands back `port`, or
 * rejects as Chrome does when the picker is dismissed. Returns an uninstaller
 * that restores the original, so cleanups may run in any order.
 */
export function installFakeSerial(port) {
  Object.defineProperty(globalThis.navigator, "serial", {
    configurable: true,
    value: {
      requestPort: async () => {
        if (!port) throw new DOMException("No port selected by the user.", "NotFoundError");
        return port;
      },
      getPorts: async () => (port ? [port] : []),
    },
  });
  return () => {
    if (originalSerial) Object.defineProperty(globalThis.navigator, "serial", originalSerial);
    else delete globalThis.navigator.serial;
  };
}
