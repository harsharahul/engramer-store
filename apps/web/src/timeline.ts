/**
 * The photos timeline: media files grouped into month sections, newest
 * first. Pure so the grouping can be checked without a DOM; the grid
 * component only decides how much of each section is worth rendering.
 */

export interface MonthSection<F> {
  /** Stable section key, "2026-08". */
  key: string;
  /** What the header shows, "August 2026". */
  label: string;
  files: F[];
}

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function monthKey(mtime: number): string {
  const date = new Date(mtime);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Sections in reverse chronology, files inside each newest first. */
export function byMonth<F extends { mtime: number }>(files: readonly F[]): MonthSection<F>[] {
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime);
  const sections: MonthSection<F>[] = [];
  for (const file of sorted) {
    const key = monthKey(file.mtime);
    const last = sections[sections.length - 1];
    if (last && last.key === key) {
      last.files.push(file);
    } else {
      sections.push({ key, label: MONTH_LABEL.format(new Date(file.mtime)), files: [file] });
    }
  }
  return sections;
}
