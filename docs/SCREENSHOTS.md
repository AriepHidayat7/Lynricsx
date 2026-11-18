# Screenshots

The README screenshots in `docs/screenshots/` are **unretouched captures of the
shipping application**. Nothing is composited, painted over or mocked up.

They all show one fictional demo track:

| Field | Value |
| --- | --- |
| Title | `Midnight Syntax` |
| Artist | `Lynricsx Demo` |
| Album | `Demo Sessions` |

The lyrics are original content written for this project
(`scripts/demo-track.mjs`). No commercial lyric is reproduced in any image.

## Current files

| File | Shows |
| --- | --- |
| `main-overlay.png` | Hero: word-synchronized lyrics as highlighted code, typewriter cursor mid-word |
| `composition-styles.png` | One track rendering a nested block (lines 1–5) *and* flat statements (6–7) |
| `terminal-session.png` | Live terminal log with real event tags while lyrics load |
| `code-snapshot.png` | The PNG exported by the app's own snapshot renderer |
| `settings.png` | Control panel: appearance presets, font size, past-lyric fade |

## How they are produced

Rendering a demo track requires no code in the application. The backend normally
publishes two Tauri events — `media:track` and `lyrics:context` — which the
overlay consumes. `scripts/capture-screenshots.mjs` pushes payloads of the same
shape into the running overlay through WebView2's DevTools protocol, then asks
the browser to screenshot the viewport.

That means everything visible is produced by the **production** code path:
composition (`compose.ts`), syntax highlighting (`codeview.ts`), the typewriter,
the cursor, the gutter, the terminal and its responsive line fitting. There is no
demo branch, flag or user-facing feature anywhere in `src/` or `src-tauri/src/`,
and no request is made to Spotify or any lyric provider.

`code-snapshot.png` is not a screenshot of the overlay: the script clicks the real
"save snapshot" button and keeps the PNG the app generated.

### Regenerating

```powershell
npm run tauri:build
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
.\src-tauri\target\release\redlyrics.exe
node scripts\capture-screenshots.mjs
```

The script saves the current appearance settings first and restores them at the
end, so running it does not change your configuration.

## Capture settings

- Viewport emulated at 2× device pixel ratio for crisp text.
- Overlay preset `TERMINAL RED`, font size 22, 10 history lines.
- Timeline frozen on a paused snapshot, so a frame is reproducible.

## Adding new screenshots

Follow the same rules: real renders only, the demo track only, no commercial
lyrics, no personal data, and no manual painting. Add the file here and reference
it from the README `## Screenshots` section.

Keep `docs/screenshots/` committed — these are project assets, not build output.
