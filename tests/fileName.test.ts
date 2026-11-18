import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, lyricFileName, IDLE_FILE_NAME } from "../src/lib/fileName.ts";

test("filename is title.artist.lyrics.ts, lowercased", () => {
  assert.equal(
    lyricFileName({ title: "Backburner", artist: "NIKI" }),
    "backburner.niki.lyrics.ts",
  );
});

test("spaces and punctuation collapse into single hyphens", () => {
  assert.equal(
    lyricFileName({ title: "Sailor Song", artist: "Gigi Perez" }),
    "sailor-song.gigi-perez.lyrics.ts",
  );
  assert.equal(
    lyricFileName({ title: "Midnight City", artist: "M83" }),
    "midnight-city.m83.lyrics.ts",
  );
});

test("special characters are normalized safely", () => {
  // Accents fold to ASCII.
  assert.equal(slugify("Café Déjà"), "cafe-deja");
  // Ampersand reads as "and".
  assert.equal(slugify("Simon & Garfunkel"), "simon-and-garfunkel");
  // Apostrophes are dropped, not hyphenated.
  assert.equal(slugify("Don't Stop"), "dont-stop");
  // No leading/trailing/double hyphens, no filesystem-unsafe characters.
  assert.equal(slugify("  ///Hello---World!!!  "), "hello-world");
  assert.equal(slugify("A/B: C?"), "a-b-c");
  // Path separators cannot escape a directory.
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
});

test("missing metadata degrades gracefully", () => {
  assert.equal(lyricFileName({ title: "", artist: "" }), "untitled.lyrics.ts");
  assert.equal(lyricFileName({ title: "Song", artist: "" }), "song.lyrics.ts");
  assert.equal(lyricFileName({ title: "", artist: "Artist" }), "untitled.artist.lyrics.ts");
});

test("the filename is stable for the same metadata", () => {
  const a = lyricFileName({ title: "Same Song", artist: "Same Artist" });
  const b = lyricFileName({ title: "Same Song", artist: "Same Artist" });
  assert.equal(a, b);
});

test("the idle filename is a valid lyrics source name", () => {
  assert.match(IDLE_FILE_NAME, /\.lyrics\.ts$/);
});

test("non-latin titles fall back instead of producing an empty name", () => {
  // Cyrillic/CJK normalise away entirely -> untitled, never bare ".lyrics.ts".
  const name = lyricFileName({ title: "東京", artist: "" });
  assert.ok(name.startsWith("untitled"), name);
});
