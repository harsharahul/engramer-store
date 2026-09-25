import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Every Tailwind class in this app carries the "tw:" prefix (see app.css).
const twMerge = extendTailwindMerge({ prefix: "tw" });

/** Joins class names and lets a later Tailwind class override an earlier one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
