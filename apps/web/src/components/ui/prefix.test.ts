import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every Tailwind class in this app carries the "tw:" prefix (app.css). A class
 * without it generates no CSS at all, so the element silently renders
 * unstyled. The shadcn generator missed the prefix inside components built
 * with useRender/mergeProps (SidebarGroupLabel, SidebarMenuAction,
 * SidebarMenuSubButton); this keeps a later `shadcn add` from doing it again.
 */

const UTILITY =
  /^!?-?(flex|grid|inline|relative|absolute|fixed|hidden|block|h-|w-|size-|p[xytrbl]?-|m[xytrbl]?-|gap-|rounded|text-|bg-|border|ring|shadow|items-|justify-|overflow|opacity|transition|z-|top-|left-|right-|bottom-|min-|max-|group|peer|data-|aria-|has-|focus|hover|outline|shrink|truncate|select|cursor|font-|leading|tracking|duration|ease|translate|origin|pointer|after:|before:|\[&)/;

describe("shadcn components", () => {
  it("prefix every Tailwind class with tw:", () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/"([^"\n]{12,})"/g)) {
        const tokens = match[1]!.split(/\s+/);
        const utilities = tokens.filter((t) => UTILITY.test(t));
        if (utilities.length >= 2) {
          const bare = utilities.filter((t) => !t.startsWith("tw:"));
          if (bare.length > 0) {
            offenders.push(`${file}: ${bare.slice(0, 3).join(" ")}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
