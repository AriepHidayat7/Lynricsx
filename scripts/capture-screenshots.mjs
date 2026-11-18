// Captures the five README screenshots from the real application.
//
// AUTHENTICITY: every pixel comes from the shipped overlay/panel rendering. This
// script never draws, composites or retouches anything — it drives the running
// app and asks WebView2 for a real screenshot.
//
// HOW THE DEMO TRACK IS RENDERED: the backend normally emits `media:track` and
// `lyrics:context` from GSMTC + the lyric providers. Those are plain Tauri
// events, so this script pushes the *same* payload shapes into the live overlay
// through WebView2's DevTools protocol. The application code path that produces
// the pixels (composition, syntax highlighting, typewriter, cursor, gutter,
// terminal) is entirely the production one. No demo branch exists in app source,
// and no network call is made to Spotify or any lyric provider.
//
// Usage:
//   1. build:  npm run tauri:build
//   2. start:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
//              .\src-tauri\target\release\redlyrics.exe
//   3. run:    node scripts/capture-screenshots.mjs
//
// Output: docs/screenshots/*.png

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cdpConnect } from "./cdp.mjs";
import {
  DEMO_ARTIST,
  DEMO_TITLE,
  demoContext,
  demoTimeline,
  demoTrack,
} from "./demo-track.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });

// Console output is unreliable in this Windows shell, so every step is also
// appended to a log file that survives the run.
const LOG = join(here, "..", "cap.log");
const log = (msg) => {
  const line = `${msg}\n`;
  writeFileSync(LOG, line, { flag: "a" });
  process.stdout.write(line);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Emits a backend event into the live webview, exactly as Rust would. */
const emit = (session, event, payload) =>
  session.ev(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:${JSON.stringify(
      event,
    )},payload:${JSON.stringify(payload)}})`,
  );

/** Pushes the demo lyric context. */
const pushContext = (session, ctx = demoContext()) => emit(session, "lyrics:context", ctx);

/** Pushes a paused demo snapshot, which freezes the overlay's position clock. */
const atPosition = (session, ms, extra = {}) =>
  emit(session, "media:track", { ...demoTrack(ms), ...extra });

/** Frames the viewport, then screenshots it at 2x for a crisp README image. */
async function shoot(session, name, { width, height, setup, settle = 700 }) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait(250);
  await setup();
  await wait(settle);
  const res = await session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const data = res.result?.data;
  if (!data) throw new Error(`screenshot failed: ${name}`);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  log(`  wrote ${name}.png`);
}


const setSetting = (session, patch) =>
  session.ev(`window.__TAURI_INTERNALS__.invoke("update_settings",{patch:${JSON.stringify(patch)}})`);

async function main() {
  log("Connecting to the overlay…");
  const overlay = await cdpConnect(/Lynricsx Overlay/);
  await overlay.send("Page.enable", {});

  // Capturing requires switching appearance presets, which are real persisted
  // settings. Snapshot them now and restore them at the end so running this
  // script never changes the user's configuration.
  const panel = await cdpConnect(/^Lynricsx$/);
  await panel.send("Page.enable", {});
  const original = await panel.ev(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then(s=>({theme:s.theme,fontSize:s.fontSize,historyLines:s.historyLines}))`,
  );
  log(`Saved current settings: ${JSON.stringify(original)}`);

  log("Seeding the demo track…");
  await setSetting(overlay, { theme: "terminal", fontSize: 22, historyLines: 10 });
  await pushContext(overlay);
  await atPosition(overlay, demoTimeline()[4].startMs + 1500);
  await wait(1200);

  // 1. Hero: word-synchronized lyrics mid-track.
  await shoot(overlay, "main-overlay", {
    width: 1080,
    height: 700,
    setup: async () => {
      await pushContext(overlay);
      await atPosition(overlay, demoTimeline()[4].startMs + 1600);
    },
  });

  // 2. Composition styles: one frame whose visible window mixes flat, nested
  //    and comment lines, showing a single track renders several shapes.
  //    Positioned mid-track so the earlier groups are already rendered and the
  //    nested pair plus a comment line are on screen together.
  await shoot(overlay, "composition-styles", {
    width: 1080,
    height: 620,
    setup: async () => {
      await pushContext(overlay);
      await atPosition(overlay, demoTimeline()[4].startMs + 1200);
    },
  });

  // 3. Control panel.
  log("Opening the control panel…");
  await shoot(panel, "settings", {
    width: 1140,
    height: 800,
    setup: async () => {
      await panel.ev(
        `(()=>{const b=[...document.querySelectorAll("button,a")].find(x=>/^appearance$/i.test((x.textContent||"").trim()));if(b)b.click();})()`,
      );
      await wait(400);
    },
  });

  // 4. Live terminal session. The terminal shows while nothing is rendered yet,
  //    so the lyric context is cleared and a new track identity is announced.
  log("Capturing the terminal session…");
  await shoot(overlay, "terminal-session", {
    width: 1080,
    height: 640,
    setup: async () => {
      await pushContext(overlay, {
        lines: [],
        synced: false,
        wordSynced: false,
        wordGranularity: "",
        instrumental: false,
        source: "",
        title: DEMO_TITLE,
        artist: DEMO_ARTIST,
        album: "",
        durationMs: demoContext().durationMs,
      });
      await atPosition(overlay, 0, { trackSeq: 2 });
      await wait(700);
    },
  });

  // 5. Code snapshot: the app's own PNG export.
  log("Capturing the code snapshot export…");
  await pushContext(overlay);
  await atPosition(overlay, demoTimeline()[2].startMs + 1200);
  await wait(900);
  await captureSnapshot(overlay);

  // Restore the user's own appearance settings, then release the connections.
  await setSetting(overlay, original);
  log(`Restored settings: ${JSON.stringify(original)}`);

  overlay.close();
  panel.close();
  log(`\nDone. Files in ${OUT}`);
}

/**
 * Clicks the production "Save code snapshot" button and keeps the PNG the app
 * generated, rather than re-implementing `renderSnapshotPng` here.
 */
async function captureSnapshot(session) {
  // The click hands a Blob to an <a download>; intercept it before the browser
  // navigates so the app's own bytes can be read back.
  await session.ev(`
    window.__shotB64 = null;
    (() => {
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && this.href && this.href.startsWith("blob:")) {
          window.__shotName = this.download;
          fetch(this.href).then(r => r.blob()).then(async (b) => {
            const buf = new Uint8Array(await b.arrayBuffer());
            let s = ""; const CH = 0x8000;
            for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
            window.__shotB64 = btoa(s);
          });
          return;
        }
        return orig.apply(this, arguments);
      };
    })();
    true;
  `);
  await session.ev(`document.querySelector(".ov-icon-btn")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await session.ev(`!!window.__shotB64`)) break;
    await wait(150);
  }
  const b64 = await session.ev(`window.__shotB64`);
  if (!b64) throw new Error("the app did not produce a snapshot PNG");
  const name = await session.ev(`window.__shotName`);
  writeFileSync(join(OUT, "code-snapshot.png"), Buffer.from(b64, "base64"));
  log(`  wrote code-snapshot.png (app export: ${name})`);
}

main().catch(async (e) => {
  log(`Capture failed: ${e && e.stack}`);
  process.exit(1);
});
