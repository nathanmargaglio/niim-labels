/** Print settings, persisted in localStorage so a phone remembers them. */

const STORAGE_KEY = "niim-labels:settings:v1";

/**
 * What a corner index counts against.
 * - `sheet`  — the label's place among every label in the PDF
 * - `run`    — its place within the range being printed
 * - `person` — its place among that person's own orders
 * - `off`    — the corner is left blank
 */
export const BADGE_SCOPES = [
  { value: "off", label: "Off" },
  { value: "sheet", label: "Whole sheet (14/28)" },
  { value: "run", label: "This print run (2/3)" },
  { value: "person", label: "This person's orders (3/5)" },
];

const SCOPE_VALUES = BADGE_SCOPES.map((scope) => scope.value);

export const DEFAULTS = {
  /** Label roll that ships with the B1: 50 x 30 mm. */
  widthMm: 50,
  heightMm: 30,
  marginMm: 2.5,
  density: 3,
  labelType: 1,
  copies: 1,
  topBadge: "sheet",
  bottomBadge: "person",
  font: "sans",
  boldName: true,
};

const NUMBERS = {
  widthMm: [5, 120],
  heightMm: [5, 200],
  marginMm: [0, 15],
  density: [1, 5],
  copies: [1, 20],
};

function clean(raw) {
  const settings = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return settings;

  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) settings[key] = Math.min(max, Math.max(min, value));
  }
  if (SCOPE_VALUES.includes(raw.topBadge)) settings.topBadge = raw.topBadge;
  if (SCOPE_VALUES.includes(raw.bottomBadge)) settings.bottomBadge = raw.bottomBadge;
  if (["sans", "mono", "serif"].includes(raw.font)) settings.font = raw.font;
  if (typeof raw.boldName === "boolean") settings.boldName = raw.boldName;
  if ([1, 2, 3, 5].includes(Number(raw.labelType))) settings.labelType = Number(raw.labelType);
  return settings;
}

export function loadSettings() {
  try {
    return clean(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  const cleaned = clean(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Private browsing can refuse storage; the settings still apply this session.
  }
  return cleaned;
}
