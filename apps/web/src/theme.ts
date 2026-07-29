/**
 * Appearance: a day/night mode and an accent palette drawn from the brand's
 * gradient logo variants. Both are applied as data attributes on <html> and
 * persisted locally. An inline script in index.html applies the stored choice
 * before first paint so there is no flash.
 */

export type ThemeMode = "light" | "dark";

export interface Accent {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** The six brand gradients, shown as swatches in the appearance picker. */
export const ACCENTS: Accent[] = [
  { id: "ocean", label: "Ocean", from: "#2563eb", to: "#22d3ee" },
  { id: "aurora", label: "Aurora", from: "#14b8a6", to: "#818cf8" },
  { id: "emerald", label: "Emerald", from: "#059669", to: "#34d399" },
  { id: "violet", label: "Violet", from: "#7c3aed", to: "#a78bfa" },
  { id: "sunset", label: "Sunset", from: "#e11d48", to: "#fbbf24" },
  { id: "midnight", label: "Midnight", from: "#1e293b", to: "#60a5fa" },
];

const THEME_KEY = "engram-theme";
const ACCENT_KEY = "engram-accent";

/* Matches --ink-0 in styles.css for each mode; keeps the browser chrome and
   installed-app title bar on the app's background color. */
const THEME_COLORS: Record<ThemeMode, string> = {
  dark: "#0a0e1a",
  light: "#eff3fa",
};

export function currentTheme(): ThemeMode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function currentAccent(): string {
  return document.documentElement.dataset.accent ?? "ocean";
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[mode]);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Persistence is best-effort.
  }
}

export function applyAccent(id: string): void {
  document.documentElement.dataset.accent = id;
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {
    // Persistence is best-effort.
  }
}
