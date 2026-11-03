/**
 * The phone's places, per the information architecture: Timeline, Files,
 * Photos, Search and More. Tabs are places, never actions: Add is the plus
 * in the top bar, and Notices is the bell beside it, as on the Mac.
 */

import type { ReactNode } from "react";
import { CalendarGlyph, FolderGlyph, MenuGlyph, PhotoGlyph, SearchGlyph } from "./Icon";

export type PhoneTab = "timeline" | "files" | "photos" | "search" | "more";

export function PhoneTabs(props: {
  /** The place on screen, or null while something else (Notices) is over it. */
  active: PhoneTab | null;
  onTimeline(): void;
  onFiles(): void;
  onPhotos(): void;
  onSearch(): void;
  onMore(): void;
}) {
  const tab = (key: PhoneTab, label: string, glyph: ReactNode, onClick: () => void) => (
    <button
      key={key}
      className={`tab${props.active === key ? " active" : ""}`}
      {...(props.active === key ? { "aria-current": "page" as const } : {})}
      onClick={onClick}
    >
      {glyph}
      <span>{label}</span>
    </button>
  );
  return (
    <nav className="tabbar">
      {tab("timeline", "Timeline", <CalendarGlyph size={19} />, props.onTimeline)}
      {tab("files", "Files", <FolderGlyph size={19} />, props.onFiles)}
      {tab("photos", "Photos", <PhotoGlyph size={19} />, props.onPhotos)}
      {tab("search", "Search", <SearchGlyph size={19} />, props.onSearch)}
      {tab("more", "More", <MenuGlyph size={19} />, props.onMore)}
    </nav>
  );
}
