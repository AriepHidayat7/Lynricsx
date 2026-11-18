# Configuration

Lynricsx has no environment variables and no config file to hand-edit for
normal use. Everything is configured through the control panel and persisted to
a single JSON file.

## Where settings live

| Purpose | Path |
| --- | --- |
| Settings | `%APPDATA%\com.redlyrics.app\settings.json` |
| Lyrics cache | `%LOCALAPPDATA%\com.redlyrics.app\lyrics\` |
| Diagnostic log | `%LOCALAPPDATA%\Lynricsx\logs\gsmtc.log` |
| Autostart entry | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` |

`com.redlyrics.app` is the **frozen bundle identifier**, kept so upgrades do not
lose user data (see [ARCHITECTURE.md](./ARCHITECTURE.md#identifiers-and-backward-compatibility)).
The About page displays these paths with the identifier collapsed to
`Roaming\…` / `Local\…`.

## Settings reference

The file is pretty-printed JSON with camelCase keys. Defaults below are from
`impl Default for Settings` in `settings.rs`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `overlayVisible` | bool | `true` | Show the overlay window |
| `overlayX` | int | `80` | Overlay X, **logical** screen coordinates |
| `overlayY` | int | `420` | Overlay Y, **logical** screen coordinates |
| `overlayWidth` | int | `760` | Overlay width in logical px |
| `overlayHeight` | int | `440` | Overlay height in logical px |
| `anchor` | enum | `bottomleft` | Corner the position resolves against: `topleft`, `topright`, `bottomleft`, `bottomright`, `custom` |
| `fontSize` | int | `22` | Lyric font size |
| `theme` | enum | `terminal` | Appearance preset: `terminal`, `cyberpunk`, `minimal` |
| `typewriter` | bool | `true` | Typewriter reveal animation |
| `historyLines` | int | `10` | Visible lyric lines, `1`–`20` (active line included) |
| `cursorStyle` | string | `"block"` | `block`, `line`, `underline`, `bar`, `hollow`, `off` |
| `clickThrough` | bool | `false` | **Retired.** Accepted for compatibility but always forced to `false` on load. |
| `alwaysOnTop` | bool | `true` | Keep the overlay above other windows |
| `linesBefore` | int | `1` | History lines kept above the active line |
| `linesAfter` | int | `2` | Upcoming lines shown below the active line |
| `startWithWindows` | bool | `false` | Launch at login |
| `showTrackSource` | bool | `true` | Show the source app in the overlay header |
| `lockPosition` | bool | `false` | Prevent dragging |
| `terminalEffects` | bool | `true` | Terminal boot/transition/track messages |
| `showTerminalActivity` | bool | `true` | Animated activity bars in the header |
| `easterEggs` | bool | `true` | Occasional cosmetic asides |
| `completedWordColor` | string | `"muted"` | Past-lyric appearance: `muted` (**SUBTLE**), `dim` (**BALANCED**), `accent` (**STRONG**) |

### Notes on specific keys

- **`completedWordColor`** stores the legacy values `muted` / `dim` / `accent`,
  but the UI labels them **SUBTLE** / **BALANCED** / **STRONG**. The stored
  values were kept so existing installs keep their look.
- **Overlay geometry** is stored in logical pixels and converted with the active
  monitor's DPI factor; `anchor` is resolved against that monitor's work area
  (taskbar excluded), so placement works on scaled and negative-origin monitors.
- **Fonts** are never bundled. The overlay uses
  `"Cascadia Code", Consolas, "Cascadia Mono", "Courier New", monospace` and the
  panel uses `"Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, …`,
  whatever is installed. On a stock Windows 11 install that means Consolas.

## Editing the file by hand

Safe, with caveats:

- **Stop Lynricsx first.** The app rewrites `settings.json` when settings
  change, so hand edits made while it runs can be overwritten.
- **Missing keys fall back to defaults.** The struct is
  `#[serde(rename_all = "camelCase", default)]`, so a partial file is valid.
- **Unknown keys are ignored.** There is no `deny_unknown_fields`, so leftovers
  from older versions (for example `focusMode`, or the removed `opacity` /
  `scanlines` / `scanlineIntensity`) are dropped silently on the next save. If
  the file ever fails to parse, Lynricsx starts from defaults rather than
  refusing to launch.
- **Invalid enum values** fall back to the default for that field.

## Resetting

Delete `%APPDATA%\com.redlyrics.app\settings.json` while the app is closed.
Lynricsx recreates it with defaults on next launch. To also drop cached lyrics,
use **Settings → System → Clear cache**, or delete
`%LOCALAPPDATA%\com.redlyrics.app\lyrics\`.

## Network access

Lynricsx makes outbound HTTPS requests to exactly two lyric services:

| Service | Endpoint | Purpose |
| --- | --- | --- |
| LiriQo | `https://api.liriqo-alfarrizi.my.id/v1/lyrics` | Preferred provider; word/syllable timing |
| LRCLIB | `https://lrclib.net` | Fallback; line-synced LRC |

Both requests send a descriptive `User-Agent`
(`Lynricsx/0.1.0 (...)`) as those services require, and responses are cached
locally. No account, API key or credential is used or stored, and no telemetry
is sent anywhere.
