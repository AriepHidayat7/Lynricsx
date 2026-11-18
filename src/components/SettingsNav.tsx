import type { ReactNode } from "react";

/** The settings categories, in navigation order. */
export type SettingsCategory = "general" | "appearance" | "lyrics" | "advanced" | "about";

interface NavEntry {
  id: SettingsCategory;
  label: string;
  /** Single-glyph terminal-style icon, drawn as a path so it scales crisply. */
  icon: ReactNode;
}

/* 12x12 icon paths, stroked with currentColor so the accent drives them. */
const ICONS: Record<SettingsCategory, ReactNode> = {
  general: (
    <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M1.5 3h9M1.5 6h9M1.5 9h9" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="4" cy="3" r="1.4" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="8" cy="6" r="1.4" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5" cy="9" r="1.4" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  ),
  appearance: (
    <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M6 1.2a4.8 4.8 0 1 0 0 9.6 1.5 1.5 0 0 0 1.1-2.5 1.4 1.4 0 0 1 1-2.4h1a1.7 1.7 0 0 0 1.7-1.7A4.3 4.3 0 0 0 6 1.2Z"
        stroke="currentColor" strokeWidth="1.1" fill="none" />
      <circle cx="4" cy="4.4" r="0.8" fill="currentColor" />
      <circle cx="7.4" cy="3.6" r="0.8" fill="currentColor" />
      <circle cx="3.4" cy="7.2" r="0.8" fill="currentColor" />
    </svg>
  ),
  lyrics: (
    <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M1.6 2.6h5.2M1.6 6h5.2M1.6 9.4h3.4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <path d="M9.8 4.2v4.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8.7" cy="9" r="1.1" fill="currentColor" />
    </svg>
  ),
  advanced: (
    <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M6 1v1.6M6 9.4V11M1 6h1.6M9.4 6H11M2.5 2.5l1.1 1.1M8.4 8.4l1.1 1.1M9.5 2.5L8.4 3.6M3.6 8.4 2.5 9.5"
        stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4.9" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <circle cx="6" cy="3.8" r="0.85" fill="currentColor" />
      <path d="M6 5.6v3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
};

const ENTRIES: NavEntry[] = [
  { id: "general", label: "General", icon: ICONS.general },
  { id: "appearance", label: "Appearance", icon: ICONS.appearance },
  { id: "lyrics", label: "Lyrics", icon: ICONS.lyrics },
  { id: "advanced", label: "Advanced", icon: ICONS.advanced },
  { id: "about", label: "About", icon: ICONS.about },
];

/**
 * Persistent left navigation for the settings window.
 *
 * Rendered as a `nav` with real buttons, so keyboard arrows/Tab work without a
 * roving-tabindex implementation. Only the active item is marked `aria-current`.
 */
export default function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsCategory;
  onSelect: (id: SettingsCategory) => void;
}) {
  return (
    <nav className="set-nav" aria-label="Settings categories">
      {ENTRIES.map((e) => (
        <button
          key={e.id}
          type="button"
          className={`set-nav-item${e.id === active ? " is-active" : ""}`}
          aria-current={e.id === active ? "page" : undefined}
          onClick={() => onSelect(e.id)}
        >
          <span className="set-nav-icon">{e.icon}</span>
          <span className="set-nav-label">{e.label}</span>
        </button>
      ))}
    </nav>
  );
}
