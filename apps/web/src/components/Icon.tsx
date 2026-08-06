interface IconProps {
  size?: number;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      {children}
    </svg>
  );
}

export const Keyhole = ({ size = 22 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="keyhole">
    <circle cx="12" cy="9" r="3.2" fill="currentColor" />
    <path d="M10.6 11.4 L9 18.5 h6 L13.4 11.4 Z" fill="currentColor" />
    <circle cx="12" cy="12" r="10.4" {...stroke} />
  </svg>
);

export const SearchGlyph = ({ size = 15 }: IconProps) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8 20 20" />
  </Svg>
);

export const FolderGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5h-7l-2-2.5H4.5A1.5 1.5 0 0 0 3 6.5Z" />
  </Svg>
);

export const ClockGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const CalendarGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="1.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </Svg>
);

export const TrashGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5 7.5 20h9l1-13.5M10 10.5v6M14 10.5v6" />
  </Svg>
);

export const DownloadGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 4v11M7.5 11.5 12 16l4.5-4.5M5 19.5h14" />
  </Svg>
);

export const ShareGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="6.5" cy="12" r="2.6" />
    <circle cx="17.5" cy="6" r="2.6" />
    <circle cx="17.5" cy="18" r="2.6" />
    <path d="m8.9 10.8 6.3-3.6M8.9 13.2l6.3 3.6" />
  </Svg>
);

export const PencilGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="m5 19 .9-3.7L16.8 4.4a1.4 1.4 0 0 1 2 0l.8.8a1.4 1.4 0 0 1 0 2L8.7 18.1 5 19Z" />
  </Svg>
);

export const XGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const PlusGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const UploadGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19.5h14" />
  </Svg>
);

export const LockGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="5.5" y="10.5" width="13" height="9" rx="1.6" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);

export const RestoreGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4.5 7.5v5h5" />
    <path d="M5.5 12.5a7 7 0 1 0 1.6-6.4" />
  </Svg>
);

export const CopyGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="9" y="9" width="11" height="11" rx="1.6" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Svg>
);

export const TagGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M11.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.4a1.5 1.5 0 0 1-.44 1.06l-6.6 6.6a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1 0-2.12l6.6-6.6a1.5 1.5 0 0 1 1.06-.44Z" />
    <circle cx="16" cy="8" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const StarGlyph = ({ size = 16, filled = false }: IconProps & { filled?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    {...stroke}
    fill={filled ? "currentColor" : "none"}
    aria-hidden="true"
  >
    <path d="m12 4 2.5 5.3 5.5.8-4 4 .95 5.6L12 17.1 7.05 19.7 8 14.1l-4-4 5.5-.8Z" />
  </svg>
);

export const SparkGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 17.9l-1.7-5.5L5 10.7 10.3 9Z" />
    <path d="M18.5 16.5 19.2 18.6 21.3 19.3 19.2 20 18.5 22.1 17.8 20 15.7 19.3 17.8 18.6Z" />
  </Svg>
);

export const PhotoGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="1.6" />
    <circle cx="8.8" cy="10" r="1.4" />
    <path d="m4.5 16.5 4.4-4 3.4 3 2.9-2.4 4.3 3.7" />
  </Svg>
);

export const DocGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M6.5 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
    <path d="M13.5 3.5V8H18M9 12.5h6M9 15.5h6" />
  </Svg>
);

export const VideoGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="3.5" y="6" width="13" height="12" rx="1.8" />
    <path d="m16.5 10 4-2.5v9l-4-2.5" />
  </Svg>
);

export const AudioGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M9.5 17.5V7.2l8.5-2v10" />
    <circle cx="7.3" cy="17.6" r="2.1" />
    <circle cx="15.8" cy="15.3" r="2.1" />
  </Svg>
);

export const ReceiptGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M6 3.5h12v16.5l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4Z" />
    <path d="M9 8.5h6M9 12h6" />
  </Svg>
);

export const NoteGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M5 4.5h14v11l-4 4H5Z" />
    <path d="M15 19.5V15h4M8.5 9h7M8.5 12.5H13" />
  </Svg>
);

export const CodeGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13 5.5l-2 13" />
  </Svg>
);

export const GridGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="4" y="4.5" width="16" height="15" rx="1.5" />
    <path d="M4 10h16M4 14.5h16M10 4.5v15" />
  </Svg>
);

export const EaselGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
    <path d="M12 3.5V5M12 15.5v2M8.5 20.5l3.5-3 3.5 3" />
  </Svg>
);

export const PenNibGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="m12 3.5 5.5 3.5-1.5 8.5-4 5-4-5L6.5 7Z" />
    <circle cx="12" cy="12" r="1.4" />
    <path d="M12 13.4v3.6" />
  </Svg>
);

export const BoxGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Z" />
    <path d="m4 8.5 8 4.5 8-4.5M12 13v7" />
  </Svg>
);

export const BookGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 6.5C10.5 5 8.2 4.5 5.5 4.5v13c2.7 0 5 .5 6.5 2 1.5-1.5 3.8-2 6.5-2v-13c-2.7 0-5 .5-6.5 2Z" />
    <path d="M12 6.5v13" />
  </Svg>
);

export const MonitorGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="3.5" y="5" width="17" height="11.5" rx="1.6" />
    <path d="M9.5 20h5M12 16.5V20" />
  </Svg>
);

export const AsteriskGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M6 8.5l12 7M18 8.5l-12 7" />
  </Svg>
);

export const LayoutGridGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="4" y="4" width="7" height="7" rx="1.4" />
    <rect x="13" y="4" width="7" height="7" rx="1.4" />
    <rect x="4" y="13" width="7" height="7" rx="1.4" />
    <rect x="13" y="13" width="7" height="7" rx="1.4" />
  </Svg>
);

export const LayoutListGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="5" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const InfoGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
  </Svg>
);

export const MoveGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M3 7.5V17a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 17V9.5A1.5 1.5 0 0 0 19.5 8h-7l-2-2.5H4.5A1.5 1.5 0 0 0 3 7Z" />
    <path d="M10.5 13h6M14 10.5l2.5 2.5-2.5 2.5" />
  </Svg>
);

export const LinkGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M8 12.5 5.8 14.7a3.6 3.6 0 0 0 0 5.1 3.6 3.6 0 0 0 5.1 0l2.6-2.6" />
    <path d="M16 11.5l2.2-2.2a3.6 3.6 0 0 0 0-5.1 3.6 3.6 0 0 0-5.1 0l-2.6 2.6" />
  </Svg>
);

export const InboxGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M3.5 13.5 6 6a1.5 1.5 0 0 1 1.4-1h9.2A1.5 1.5 0 0 1 18 6l2.5 7.5" />
    <path d="M3.5 13.5V18A1.5 1.5 0 0 0 5 19.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5a3.5 3.5 0 0 1-7 0Z" />
  </Svg>
);

export const ScanTextGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M8 10h8M8 13.5h5.5" />
  </Svg>
);

export const KeyGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="M11 12.5 19.5 4M15.5 8l2.5 2.5M13 10.5l2 2" />
  </Svg>
);

export const SunGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 3.5V5.5M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
  </Svg>
);

export const MoonGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M19 14.5A8 8 0 0 1 9.5 5a7 7 0 1 0 9.5 9.5Z" />
  </Svg>
);

export const CameraGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4.5 8h3l1.5-2.5h6L16.5 8h3A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-8A1.5 1.5 0 0 1 4.5 8Z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
);

export const MenuGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const DotsGlyph = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);
