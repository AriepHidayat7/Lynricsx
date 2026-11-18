import { useCallback, useEffect, useRef, useState } from "react";
import { api, events } from "./lib/tauri";
import { formatTime } from "./lib/sync";
import { Section } from "./components/controls";
import SettingsPanel from "./components/SettingsPanel";
import {
  EMPTY_CONTEXT,
  EMPTY_TRACK,
  type AppInfo,
  type CacheInfo,
  type LyricContext,
  type LyricsStatusEvent,
  type Settings,
  type TrackSnapshot,
} from "./types";

function playbackLabel(s: TrackSnapshot["playbackState"]): string {
  switch (s) {
    case "playing":
      return "PLAYING";
    case "paused":
      return "PAUSED";
    case "stopped":
      return "STOPPED";
    case "opened":
      return "OPEN";
    case "changing":
      return "CHANGING";
    default:
      return "IDLE";
  }
}

function statusLabel(s: LyricsStatusEvent | null): { text: string; tone: string } {
  if (!s) return { text: "AWAITING MEDIA", tone: "idle" };
  switch (s.state) {
    case "loading":
      return { text: "FETCHING LYRICS…", tone: "working" };
    case "ready":
      if (s.wordSynced) {
        const g = (s.granularity || "word").toUpperCase();
        return { text: `${g} SYNC`, tone: "ok" };
      }
      return {
        text: s.synced ? "LINE SYNC" : "PLAIN LYRICS",
        tone: s.synced ? "ok" : "warn",
      };
    case "instrumental":
      return { text: "INSTRUMENTAL", tone: "warn" };
    case "not_found":
      return { text: "NO LYRICS FOUND", tone: "warn" };
    case "unsynced":
      return { text: "UNSYNCHRONIZED", tone: "warn" };
    case "error":
      return { text: s.message.toUpperCase(), tone: "error" };
    case "no_media":
      return { text: "NO MEDIA DETECTED", tone: "idle" };
    default:
      return { text: s.message.toUpperCase(), tone: "idle" };
  }
}

/** Provider attribution line, e.g. "LIRIQO / WORD SYNC". */
function providerLine(s: LyricsStatusEvent | null, context: LyricContext): string {
  const src = (s?.source || context.source || "").toUpperCase();
  if (!src) return "—";
  if (s?.wordSynced || context.wordSynced) {
    const g = (s?.granularity || context.wordGranularity || "word").toUpperCase();
    return `${src} / ${g} SYNC`;
  }
  if (s?.synced ?? context.synced) return `${src} / LINE SYNC`;
  return `${src} / PLAIN LYRICS`;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [track, setTrack] = useState<TrackSnapshot>(EMPTY_TRACK);
  const [context, setContext] = useState<LyricContext>(EMPTY_CONTEXT);
  const [status, setStatus] = useState<LyricsStatusEvent | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const pendingPatch = useRef<Partial<Settings>>({});
  const flushTimer = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    const patch = pendingPatch.current;
    pendingPatch.current = {};
    if (Object.keys(patch).length) {
      try {
        const merged = await api.updateSettings(patch);
        setSettings(merged);
      } catch (e) {
        console.error("update_settings failed", e);
      }
    }
  }, []);

  const patch = useCallback(
    (p: Partial<Settings>) => {
      setSettings((prev) => (prev ? { ...prev, ...p } : prev));
      pendingPatch.current = { ...pendingPatch.current, ...p };
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(flush, 140);
    },
    [flush],
  );

  useEffect(() => {
    let mounted = true;
    const un: (() => void)[] = [];

    (async () => {
      try {
        const [s, t, c, a, ai] = await Promise.all([
          api.getSettings(),
          api.getTrack(),
          api.getCacheInfo(),
          api.getAutostart(),
          api.getAppInfo(),
        ]);
        if (!mounted) return;
        // The registry is the source of truth for "start with Windows", so the
        // locally cached flag is reconciled with the real registration.
        setSettings({ ...s, startWithWindows: a.enabled });
        setTrack(t);
        setCache(c);
        setAppInfo(ai);
      } catch (e) {
        console.error("initial load failed", e);
      }

      await Promise.all([
        events.onMediaTrack((t) => mounted && setTrack(t)),
        events.onLyricsContext((c) => mounted && setContext(c)),
        events.onLyricsStatus((s) => mounted && setStatus(s)),
      ]).then((fns) => un.push(...fns));
    })();

    return () => {
      mounted = false;
      un.forEach((f) => f && f());
    };
  }, []);

  const clearCache = async () => setCache(await api.clearCache());

  const st = statusLabel(status);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <div>
            <h1>LYNRICSX</h1>
            <p className="subtitle">CODE-STYLED LYRICS OVERLAY</p>
          </div>
        </div>
        <div className="header-status">
          <span className={`badge tone-${st.tone}`}>{st.text}</span>
        </div>
      </header>
      {settings && (
        <main className="app-main">
          <Section title="NOW PLAYING">
            <div className="now-playing">
              <span className={`status-dot state-${track.playbackState}`} />
              <div className="np-info">
                <div className="np-title">{track.title || "No media detected"}</div>
                <div className="np-artist">
                  {track.artist || "—"}
                  {track.album && <span className="np-album"> · {track.album}</span>}
                </div>
                <div className="np-meta">
                  <span className={`state-tag state-${track.playbackState}`}>
                    {playbackLabel(track.playbackState)}
                  </span>
                  {track.sourceAppName && <span>{track.sourceAppName}</span>}
                  {track.hasSession && (
                    <span>
                      {formatTime(track.positionMs)} / {formatTime(track.durationMs)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </Section>

          <SettingsPanel
            settings={settings}
            patch={patch}
            onStartWithWindows={async (v) => {
              const info = await api.setAutostart(v);
              setSettings((prev) =>
                prev ? { ...prev, startWithWindows: info.enabled } : prev,
              );
            }}
            cache={cache}
            onClearCache={clearCache}
            appInfo={appInfo}
            lyricsInfo={
              <div className="lyrics-status">
                <span className={`badge tone-${st.tone}`}>{st.text}</span>
                <span className="lyrics-meta">{providerLine(status, context)}</span>
                {context.lines.length > 0 && (
                  <span className="lyrics-meta">
                    {context.lines.length} lines
                    {context.wordSynced
                      ? ` · ${context.lines.reduce(
                          (n, l) => n + (l.words?.length ?? 0),
                          0,
                        )} timed words`
                      : ""}
                  </span>
                )}
                <button className="btn" onClick={() => api.refreshLyrics()}>
                  REFETCH
                </button>
              </div>
            }
          />
        </main>
      )}
    </div>
  );
}

// __NEXT__
