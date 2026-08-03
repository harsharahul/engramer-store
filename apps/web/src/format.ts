export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "doc"
  | "sheet"
  | "archive"
  | "other";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function fileKind(mime: string, name: string): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === DOCX_MIME || /\.docx$/i.test(name)) return "doc";
  if (mime === XLSX_MIME || /\.xlsx$/i.test(name)) return "sheet";
  if (mime.startsWith("text/") || /\.(md|txt|json|ya?ml|csv|log)$/i.test(name)) return "text";
  if (/\.(zip|tar|gz|bz2|7z|rar)$/i.test(name)) return "archive";
  return "other";
}

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}
