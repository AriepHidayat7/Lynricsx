// Virtual source-file name for the current track.
//
// Purely cosmetic: no file is ever written to disk. The name must be stable for
// the whole duration of a track (so it is derived only from metadata, never
// from the playback position) and safe for display.

import type { TrackSnapshot } from "../types";

/** Placeholder used when a title/artist is missing. */
const UNKNOWN = "untitled";

/**
 * Normalises one metadata component into a filename fragment:
 * lowercase, accents folded, everything that is not a letter/digit collapsed to
 * a single hyphen, no leading/trailing hyphens.
 */
export function slugify(input: string): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    // Strip combining marks so "Café" -> "cafe".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // `&` reads better as "and" in a filename than as a bare hyphen.
    .replace(/&/g, " and ")
    // Apostrophes are dropped, not hyphenated ("you're" -> "youre").
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Virtual editor filename for a track, e.g. `backburner.niki.lyrics.ts`.
 *
 * Falls back to `untitled` when metadata is missing, and keeps the suffix so the
 * tab always reads as a lyrics source file.
 */
export function lyricFileName(track: Pick<TrackSnapshot, "title" | "artist">): string {
  const title = slugify(track.title) || UNKNOWN;
  const artist = slugify(track.artist);
  const parts = artist ? [title, artist] : [title];
  return `${parts.join(".")}.lyrics.ts`;
}

/** Name shown when no track is active. */
export const IDLE_FILE_NAME = "no-session.lyrics.ts";
