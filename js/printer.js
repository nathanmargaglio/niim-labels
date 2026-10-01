/**
 * Thin wrapper over niimbluelib's printer clients.
 *
 * The printer can be reached two ways, and everything above the connection is
 * shared between them:
 * - `bluetooth` uses Web Bluetooth (Chrome and Edge on Android and desktop).
 * - `usb` uses Web Serial: over USB the printer is a serial port (a COM port on
 *   Windows), which Chrome and Edge on desktop can open.
 *
 * niimbluelib is loaded as a global by a plain <script> tag so the app needs no
 * bundler; everything it exports is reached through `lib()`.
 */

const lib = () => globalThis.niimbluelib;

/** Printer model this app is built around; used before a printer identifies itself. */
export const DEFAULT_MODEL = "B1";

export const LABEL_TYPES = [
  { value: 1, label: "With gaps (die-cut)" },
  { value: 2, label: "Black mark" },
  { value: 3, label: "Continuous" },
  { value: 5, label: "Transparent" },
];

export const TRANSPORT_NAMES = { bluetooth: "Bluetooth", usb: "USB" };

/** Reports which transports this browser offers. */
export function transportSupport() {
  const api = lib();
  if (!api) return { bluetooth: false, usb: false };
  const { webBluetooth, webSerial } = api.Utils.getAvailableTransports();
  return { bluetooth: webBluetooth, usb: webSerial };
}

export class PrinterSession {
  constructor() {
    this.client = null;
    this.transport = null;
    this.deviceName = "";
    this.heartbeat = null;
    this.listeners = new Set();
  }

  /** Subscribes to state changes; returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.listeners) listener(this.status());
  }

  isConnected() {
    return Boolean(this.client?.isConnected());
  }

  /** Everything the UI needs to describe the current connection. */
  status() {
    if (!this.isConnected()) return { connected: false };
    const info = this.client.getPrinterInfo();
    const meta = this.client.getModelMetadata();
    const model = meta?.model ?? "Unknown";
    return {
      connected: true,
      transport: this.transport,
      // A Bluetooth printer advertises a name like "B1-H123"; a USB port is only
      // known by its vendor and product ids, so the reported model stands in.
      name: this.deviceName || `${model} · ${TRANSPORT_NAMES[this.transport]}`,
      deviceName: this.deviceName,
      model,
      dpi: meta?.dpi ?? 203,
      printheadPixels: meta?.printheadPixels ?? 384,
      densityMin: meta?.densityMin ?? 1,
      densityMax: meta?.densityMax ?? 5,
      densityDefault: meta?.densityDefault ?? 3,
      serial: info.serial,
      softwareVersion: info.softwareVersion,
      battery: this.heartbeat?.batteryPercents ?? info.batteryPercents,
      paperInserted: this.heartbeat?.paperInserted,
      lidClosed: this.heartbeat?.lidClosed,
    };
  }

  /** The geometry to render for, whether or not a printer is attached yet. */
  capabilities() {
    const meta = lib()?.getPrinterMetaByModel(DEFAULT_MODEL);
    const status = this.status();
    return {
      dpi: status.dpi ?? meta?.dpi ?? 203,
      printheadPixels: status.printheadPixels ?? meta?.printheadPixels ?? 384,
      densityMin: status.densityMin ?? meta?.densityMin ?? 1,
      densityMax: status.densityMax ?? meta?.densityMax ?? 5,
    };
  }

  /**
   * Opens the browser's device or port picker and negotiates with the chosen
   * printer.
   *
   * @param {"bluetooth"|"usb"} transport
   */
  async connect(transport) {
    const api = lib();
    if (!api) throw new Error("The printer library failed to load. Reload the page and try again.");
    const usb = transport === "usb";
    const supported = transportSupport();
    if (usb ? !supported.usb : !supported.bluetooth) {
      throw new Error(`This browser cannot use ${TRANSPORT_NAMES[transport] ?? transport} printers.`);
    }

    await this.disconnect();

    const client = usb ? new api.NiimbotSerialClient() : new api.NiimbotBluetoothClient();
    // Events from a client that has since been replaced are ignored: a Bluetooth
    // link reports its disconnect asynchronously, and switching to USB must not
    // let that late event tear down the new connection.
    client.on("heartbeat", (event) => {
      if (this.client !== client) return;
      this.heartbeat = event.data;
      this.#notify();
    });
    client.on("disconnect", () => {
      if (this.client !== client) return;
      this.client = null;
      this.transport = null;
      this.heartbeat = null;
      this.#notify();
    });

    const info = await client.connect();
    this.client = client;
    this.transport = usb ? "usb" : "bluetooth";
    this.deviceName = usb ? "" : (info.deviceName ?? "");
    this.#notify();
    return this.status();
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.heartbeat = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // The printer may already be gone; dropping the reference is enough.
      }
    }
    this.#notify();
  }

  /**
   * Prints a run of labels, rendering each page only when it is needed.
   *
   * @param {object} job
   * @param {number} job.count Number of distinct labels.
   * @param {(index: number) => HTMLCanvasElement} job.renderPage Renders label `index`.
   * @param {number} job.copies Copies of each label.
   * @param {number} job.density
   * @param {number} job.labelType
   * @param {(progress: {printed: number, total: number, index: number}) => void} job.onProgress
   * @param {() => boolean} job.isCancelled Polled between labels.
   * @returns {Promise<{printed: number, cancelled: boolean}>}
   */
  async print({ count, renderPage, copies = 1, density, labelType, onProgress = () => {}, isCancelled = () => false }) {
    const api = lib();
    if (!this.isConnected()) throw new Error("The printer is not connected.");

    const taskName = this.client.getPrintTaskType() ?? DEFAULT_MODEL;
    const direction = this.client.getModelMetadata()?.printDirection ?? "top";
    const total = count * copies;

    const task = this.client.protocol.newPrintTask(taskName, {
      totalPages: total,
      density,
      labelType,
      statusPollIntervalMs: 300,
      statusTimeoutMs: 8000,
      pageTimeoutMs: 30000,
    });

    let printed = 0;
    let cancelled = false;
    try {
      await task.printInit();
      for (let index = 0; index < count; index++) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }
        const image = api.ImageEncoder.encodeCanvas(renderPage(index), api.PageColorType.SingleColor, direction);
        await task.printPage(image, copies);
        await task.waitForPageFinished();
        printed += copies;
        onProgress({ printed, total, index });
      }
      // waitForFinished polls until every page of the task has come out, so it
      // must be skipped when the run was cut short.
      if (!cancelled) await task.waitForFinished();
    } finally {
      try {
        await this.client.protocol.printEnd();
      } catch {
        // Best effort: the run is over either way.
      }
    }
    return { printed, cancelled };
  }
}
