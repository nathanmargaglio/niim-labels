// niimbluelib's Capacitor BLE transport is only used in native mobile builds.
// This app runs in the browser and uses the Web Bluetooth transport, so the
// Capacitor packages are aliased to this stub to keep the bundle small.
const unavailable = () => {
  throw new Error("Capacitor transport is not available in the browser build");
};

export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web" };
export const BleClient = new Proxy({}, { get: () => unavailable });
export const numbersToDataView = unavailable;
export const dataViewToNumbers = unavailable;
export default { Capacitor, BleClient };
