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
