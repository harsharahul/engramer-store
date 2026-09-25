/**
 * Liquid Glass toolbar pieces as class strings. Controls float on glass,
 * grouped into capsules (WWDC25 "Build an AppKit app with the new design"):
 * plain buttons share one capsule; the search field and the primary action
 * each get their own. The material comes from the platform tokens in
 * app.css, so another platform restyles every capsule at once.
 */
export const capsule =
  "tw:flex tw:h-10 tw:shrink-0 tw:items-center tw:gap-0.5 tw:rounded-full tw:border tw:border-(--glass-border) tw:bg-(--glass-bg) tw:p-0.5 tw:shadow-(--glass-shadow) tw:backdrop-blur-xl tw:backdrop-saturate-150";

/** An icon button inside a capsule. */
export const capsuleIcon = "tw:size-9 tw:rounded-full";
