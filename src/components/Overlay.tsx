import "../styles/overlay.css";
import "../styles/terminal.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, events, overlaySettingsOf } from "../lib/tauri";
import {
  CLOCK_RESOLUTION_MS,
  activeLineIndex,
  clockStep,
  formatTime,
  interpolatePosition,
} from "../lib/sync";
import {
  codeComposition,
  lyricRole,
  pickSyntaxTheme,
  type CodeLine,
} from "../lib/codeview";
import { composeLayout, trackSeed } from "../lib/compose";
import {
  EMPTY_CONTEXT,
  EMPTY_TRACK,
  type CursorStyle,
  type LyricContext,
  type OverlaySettings,
  type TrackSnapshot,
} from "../types";
import { DEFAULT_HISTORY_LINES, completedLinesFor } from "../lib/history";
import { IDLE_FILE_NAME, lyricFileName } from "../lib/fileName";
import { formatClock, isSeekable, seekTargetForFraction, seekTargetForRow } from "../lib/seek";
import {
  initialReplayState,
  replayAction,
  replaySurvivesTrackChange,
  type ReplayState,
} from "../lib/replay";
import {
  extractRows,
  readSnapshotTheme,
  renderSnapshotPng,
  snapshotFileName,
} from "../lib/snapshot";
import {
  applyLyricsStatus,
  applyTrack,
  initialTerminalState,
  pushLine,
  runBoot,
  type TerminalState,
} from "../lib/terminal";
import { initialEggState, observeEgg, type EasterEggState } from "../lib/easterEggs";
import TerminalView from "./TerminalView";
import ActivityBars from "./ActivityBars";
import PlaybackControls, { type TransportAction } from "./PlaybackControls";
import SnapshotToast, { type ToastState } from "./SnapshotToast";

const DEFAULT_OVERLAY: OverlaySettings = {
  fontSize: 22,
  theme: "terminal",
  typewriter: true,
  cursorStyle: "block",
  historyLines: DEFAULT_HISTORY_LINES,
  showTrackSource: true,
  lockPosition: false,
  completedWordColor: "muted",
  terminalEffects: true,
  showTerminalActivity: true,
  easterEggs: true,
};

/** Duration of the cinematic track transition, in ms. Short by design. */
const TRACK_TRANSITION_MS = 420;

/** How long a snapshot notification stays on screen. */
const TOAST_MS = 3000;

/** The caret element; its shape comes from `.cursor-<style>` in CSS. */
function cursorClassFor(style: CursorStyle): string {
  return `cursor cursor-${style}`;
}

/**
 * One rendered code line: gutter number + the typed expression.
 *
 * The overlay now flattens the composition into one array of logical rows, and
 * every row here is exactly one line ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â delimiters included. Soft wrapping of a
 * long expression still paints on several physical rows; those continuation
 * rows are part of the SAME logical line, so they deliberately reuse this row's
 * gutter slot and keep the wrapped text under one number.
 */
function CodeRow({
  line,
  isActive,
  cursorClass,
  typewriter,
  onSeek,
  seekable,
  inReplay,
}: {
  line: CodeLine;
  isActive: boolean;
  /** True for the single row that owns the caret at any moment. */
  cursorClass: string;
  typewriter: boolean;
  /** Invoked with the lyric line index when the row is clicked. */
  onSeek?: (lyricIndex: number, extend: boolean) => void;
  /** False when the backing lyric has no usable timestamp. */
  seekable?: boolean;
  /** True when this row falls inside the active replay range. */
  inReplay?: boolean;
}) {
  const clickable = !!onSeek && !!seekable;
  const handleClick = (e: ReactMouseEvent) => {
    // Clicks belong to the lyric, not to the window drag handler.
    e.stopPropagation();
    if (!clickable) return;
    // Shift extends the selection into a replay range.
    onSeek!(line.lyricIndex, e.shiftKey);
  };
  return (
    <div
      className={
        (isActive ? "code-line active" : "code-line prev") +
        (clickable ? " seekable" : "") +
        (inReplay ? " in-replay" : "")
      }
      onClick={handleClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Seek to lyric line ${line.lyricIndex + 1}` : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSeek!(line.lyricIndex, e.shiftKey);
              }
            }
          : undefined
      }
    >
      <span className="code-gutter" aria-hidden="true">
        <span className="gutter-row">{line.index + 1}</span>
      </span>
      <span className="code-text">
        <CodeFragment
          line={line}
          isActive={isActive}
          cursorClass={cursorClass}
          typewriter={typewriter}
        />
      </span>
    </div>
  );
}

/**
 * Renders one syntax-highlighted code line as it is being typed.
 *
 * Only the characters up to `line.revealedChars` are emitted ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no hidden
 * suffix, placeholder or dimmed ghost text is ever placed in the DOM. The
 * glowing block cursor sits immediately after the last revealed character.
 */
function CodeFragment({
  line,
  isActive,
  cursorClass,
  typewriter = true,
}: {
  line: CodeLine;
  isActive: boolean;
  cursorClass: string;
  /** When false, complete words are shown at once instead of letter by letter. */
  typewriter?: boolean;
}) {
  // With the typewriter off the line is revealed up to the end of the word
  // currently being sung, so words never appear before their timestamp but are
  // not typed out character by character either.
  let budget = typewriter ? line.revealedChars : line.wholeWordChars;
  const parts: React.ReactNode[] = [];
  let cursorPlaced = false;
  // Empty for rows that do not own the caret: they render text but never a
  // second cursor block. Keeps the caret a single-source-of-truth decision made
  // once per frame in `cursorRow`.
  const showCursor = isActive && cursorClass.length > 0;
  // Mirrors the `leading` flag in `codeLineRevealedText`: true until the first
  // lyric character. Only indentation and block delimiters before that point
  // are editor chrome; every other separator (`.`, `(`, `"`, `;`) belongs to
  // the frontier and must wait for the text before it to be typed.
  let leading = true;
  // Tracks whether the word before the current separator is fully typed, so a
  // half-typed word never trails punctuation (`dream(` instead of `dreaming(`).
  let wordDone = true;
  let lastWord: number | undefined;
  let typedInWord = 0;
  let wordLen = 0;
  let lastRunEnd = 0;

  line.tokens.forEach((tok, i) => {
    if (tok.lyric) {
      leading = false;
      // Unrevealed lyric content is not emitted: nothing future may leak.
      if (budget <= 0) return;
      const take = Math.min(tok.text.length, budget);
      const visible = tok.text.slice(0, take);
      budget -= take;

      // A word may be split into several tokens (state runs), so completion is
      // measured across the whole source span of that word.
      if (tok.word !== lastWord) {
        typedInWord = take;
        wordLen = (tok.sourceEnd ?? 0) - (tok.sourceStart ?? 0);
        lastWord = tok.word;
        lastRunEnd = tok.sourceEnd ?? 0;
      } else {
        typedInWord += take;
        wordLen += (tok.sourceEnd ?? 0) - Math.max(tok.sourceStart ?? 0, lastRunEnd);
        lastRunEnd = tok.sourceEnd ?? 0;
      }
      wordDone = wordLen > 0 && typedInWord >= wordLen;

      if (visible) {
        // Semantic colour: primary identifier, member after the dot, or the
        // quoted argument. Comment lines use the single neutral comment colour.
        if (tok.kind === "comment") {
          parts.push(
            <span key={i} className={`tk tk-comment st-${tok.state}`}>
              {visible}
            </span>,
          );
        } else {
          const role =
            tok.word !== undefined ? ` r-${lyricRole(tok) ?? "head"}` : "";
          parts.push(
            <span key={i} className={`tk tk-str st-${tok.state}${role}`}>
              {visible}
            </span>,
          );
        }
      }

      // Cursor goes right after the last character revealed on this token.
      if (showCursor && !cursorPlaced && budget <= 0) {
        parts.push(<span key={`${i}c`} className={cursorClass} />);
        cursorPlaced = true;
      }
      return;
    }

    // Generated decoration: indentation, block delimiters and the `//` prefix
    // render whenever they lead the line; other separators only once the text
    // before them is complete. This mirrors `codeLineRevealedText` exactly.
    //
    // Closing syntax (a `"` or `);` with no lyric after it) is gated on the line
    // being complete. Without that, the closer was emitted as soon as the last
    // typed word finished, while the opener was still withheld because its
    // argument had not started ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â producing a stray `");` on a partial line.
    // Opener and closer must always appear together, so the whole call wrapper
    // is treated as one unit: it exists only when the argument is fully typed.
    const chrome = tok.kind === "comment" || (tok.kind === "syntax" && leading);
    if (!chrome) {
      let introducesLyric = false;
      for (let j = i + 1; j < line.tokens.length; j++) {
        if (line.tokens[j].lyric) {
          introducesLyric = true;
          break;
        }
      }
      if (introducesLyric) {
        // Opening syntax grows with the text: it appears once the lyric it
        // introduces has started, so the wrapper opens like a typed call.
        if (!(line.complete || (wordDone && budget > 0))) return;
      } else if (!line.complete) {
        // Closing syntax has no lyric after it and may only appear once the whole
        // expression is revealed; otherwise it renders as a stray `");` while the
        // opener is still withheld.
        return;
      }
    }

    const cls =
      tok.kind === "space"
        ? "tk tk-space"
        : tok.kind === "comment"
          ? "tk tk-comment"
          : `tk tk-${tok.tok}`;
    parts.push(
      <span key={i} className={cls}>
        {tok.text}
      </span>,
    );
  });

  // Nothing typed yet, or the statement is complete: keep the cursor attached
  // to the frontier so it never floats away from the text.
  if (showCursor && !cursorPlaced) {
    parts.push(<span key="endc" className={cursorClass} />);
  }

  return <>{parts}</>;
}

export default function Overlay() {
  const [track, setTrack] = useState<TrackSnapshot>(EMPTY_TRACK);
  const [context, setContext] = useState<LyricContext>(EMPTY_CONTEXT);
  const [cfg, setCfg] = useState<OverlaySettings>(DEFAULT_OVERLAY);
  const [position, setPosition] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Live-code terminal presentation state (pure reducer, see lib/terminal.ts).
  const [term, setTerm] = useState<TerminalState>(initialTerminalState);
  const eggsRef = useRef<EasterEggState>(initialEggState());

  const activeIndexRef = useRef(-1);
  const trackRef = useRef<TrackSnapshot>(EMPTY_TRACK);
  const contextRef = useRef<LyricContext>(EMPTY_CONTEXT);
  const positionRef = useRef(0);
  // Latest overlay config, read from event callbacks without re-subscribing.
  const cfgRef = useRef<OverlaySettings>(DEFAULT_OVERLAY);

  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);

  useEffect(() => {
    trackRef.current = track;
  }, [track]);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  // The boot sequence runs exactly once per application launch (this effect has
  // an empty dependency list and the overlay is created once at startup).
  useEffect(() => {
    setTerm((s) => (s.booted ? s : runBoot(s)));
  }, []);

  useEffect(() => {
    let mounted = true;
    const un: (() => void)[] = [];
    (async () => {
      const fns = await Promise.all([
        events.onMediaTrack((t) => {
          if (!mounted) return;
          setTrack(t);
          // Terminal feedback is derived from the same real snapshot the lyrics
          // engine uses; it never feeds back into playback or synchronization.
          setTerm((s) => {
            const name = t.hasSession ? lyricFileName(t) : IDLE_FILE_NAME;
            let next = applyTrack(s, t, name);
            // Easter eggs react to real events (first track, replays, repeated
            // seeking, completion, long listening). Permanently enabled, and they
            // never interrupt lyrics or playback controls.
            const eggRes = observeEgg(eggsRef.current, {
              trackKey: next.trackKey,
              title: t.title,
              artist: t.artist,
              playbackState: t.playbackState,
              positionMs: t.positionMs,
              durationMs: t.durationMs,
              seekSeq: t.seekSeq ?? 0,
              now: Date.now(),
            });
            eggsRef.current = eggRes.state;
            if (eggRes.egg) {
              next = pushLine(next, eggRes.egg.tag, eggRes.egg.text);
            }
            return next;
          });
        }),
        events.onLyricsContext((c) => mounted && setContext(c)),
        events.onLyricsStatus((s) => {
          if (!mounted) return;
          setTerm((prev) =>
            cfgRef.current.terminalEffects ? applyLyricsStatus(prev, s) : prev,
          );
        }),
        events.onOverlaySettings((s) => mounted && setCfg(s)),
      ]);
      un.push(...fns);
      // Pull the persisted settings once as well as subscribing. The backend
      // emits `overlay:settings` during startup, which can fire before this
      // listener exists — the overlay then stayed on `DEFAULT_OVERLAY` (e.g. a
      // saved "balanced" past-lyric fade rendered as "subtle") until the user
      // touched a control. Fetching closes that race.
      api
        .getSettings()
        .then((s) => {
          if (mounted) setCfg(overlaySettingsOf(s));
        })
        .catch(() => {
          /* keep defaults; the subscription still delivers later changes */
        });
    })();
    return () => {
      mounted = false;
      un.forEach((f) => f && f());
    };
  }, []);

  // Startup pull: the overlay can mount after the worker already published the
  // current session (e.g. Spotify was playing before Lynricsx launched). Events
  // emitted before the listener attached are not replayed, so the initial
  // snapshot is fetched explicitly. This is a one-shot read, not a poll.
  useEffect(() => {
    let mounted = true;
    api
      .getTrack()
      .then((t) => {
        if (!mounted) return;
        // Always adopt the pulled snapshot: it carries the real current
        // position, which a previously-received (possibly stale) event may not.
        setTrack(t);
        if (t.hasSession) {
          setTerm((s) => applyTrack(s, t, lyricFileName(t), Date.now()));
        }
      })
      .catch(() => {
        /* no session yet: the event stream will deliver one */
      });
    return () => {
      mounted = false;
    };
  }, []);

  //
  // `clockStep` decides throttling vs. seek; a seek is applied on the very next
  // frame in both directions, so scrubbing never waits for a pause/resume.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = interpolatePosition(trackRef.current, Date.now());
      const step = clockStep(positionRef.current, pos);

      if (step.update) {
        positionRef.current = pos;
        setPosition(pos);
      }

      // The active line is recomputed from the *sample*, not from the throttled
      // state, so a seek always lands on the correct line on the same frame.
      const idx = activeLineIndex(contextRef.current.lines, pos);
      if (idx !== activeIndexRef.current) {
        activeIndexRef.current = idx;
        setActiveIndex(idx);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Backend-confirmed seek: the worker bumped `seekSeq`, meaning it observed a
  // real discontinuity rather than playback progress. Re-anchor the render
  // position from the new sample immediately so the reveal, caret and history
  // window all jump together ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â without waiting for the next animation frame and
  // without any lyric reload.
  const seekSeqRef = useRef(track.seekSeq ?? 0);
  useEffect(() => {
    const seq = track.seekSeq ?? 0;
    if (seq === seekSeqRef.current) return;
    seekSeqRef.current = seq;

    // Use the snapshot itself (not a ref) so the freshly broadcast position is
    // applied even if `trackRef` has not been flushed yet in this commit.
    const pos = interpolatePosition(track, Date.now());
    positionRef.current = pos;
    setPosition(pos);
    const idx = activeLineIndex(contextRef.current.lines, pos);
    activeIndexRef.current = idx;
    setActiveIndex(idx);
  }, [track]);

  // A plain position update (no seek counter, e.g. the first snapshot after
  // attaching, or a resumed stream) must also re-anchor the render clock.
  // Without this the overlay can sit on a stale position until the next
  // animation frame decides the delta is large enough.
  useEffect(() => {
    if (!track.hasSession) return;
    const pos = interpolatePosition(track, Date.now());
    if (Math.abs(pos - positionRef.current) < CLOCK_RESOLUTION_MS) return;
    positionRef.current = pos;
    setPosition(pos);
    const idx = activeLineIndex(contextRef.current.lines, pos);
    if (idx !== activeIndexRef.current) {
      activeIndexRef.current = idx;
      setActiveIndex(idx);
    }
  }, [track.sampledAtMs, track.positionMs, track.hasSession]);

  const lines = context.lines;
  const synced = context.synced && lines.length > 0 && lines[0].startMs >= 0;
  const wordSynced = context.wordSynced;

  // Random-but-stable code composition. The seed comes from the track identity
  // (title + artist + album), so a song always renders the same structure while
  // different songs differ. It is memoised on the seed alone, so pausing,
  // resuming, seeking or re-rendering never reshuffles the layout.
  const seed = useMemo(
    () => trackSeed(track.title, track.artist, track.album),
    [track.title, track.artist, track.album],
  );
  const layout = useMemo(
    () => (lines.length > 0 ? composeLayout(lines, seed) : []),
    [lines, seed],
  );

  // Deterministic syntax palette for this song. Drawn from the same stable seed
  // as the layout, so the colours never change during playback, on pause, on
  // seek or on re-render ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only when a different track starts.
  const syntaxTheme = useMemo(() => pickSyntaxTheme(seed), [seed]);

  // Code-visualization composition: an editor viewport that keeps receiving
  // text. The number of completed expressions kept above the active line comes
  // from the **Lyric History** setting (`historyLines - 1`), so the visible
  // total equals `historyLines`, active line included. Upcoming expressions are
  // never built.
  const historyBefore = completedLinesFor(cfg.historyLines);
  // --- Cinematic track transition -----------------------------------------
  // A short fade keyed on track identity. It NEVER delays lyrics: the reveal
  // clock keeps running underneath, so a track that loads instantly shows its
  // first line immediately and simply fades in with everything else.
  //
  // `transitionKey` changes only on a real identity change (title+artist), so
  // seeks and position updates cannot retrigger it.
  const transitionKey = `${track.title}\u0000${track.artist}`;
  const [transitionOn, setTransitionOn] = useState(false);
  const prevTransitionKey = useRef("");
  useEffect(() => {
    if (!track.title && !track.artist) return;
    if (prevTransitionKey.current === transitionKey) return;
    const first = prevTransitionKey.current === "";
    prevTransitionKey.current = transitionKey;
    // No fade on the very first track: nothing is being replaced.
    if (first) return;
    setTransitionOn(true);
    const t = window.setTimeout(() => setTransitionOn(false), TRACK_TRANSITION_MS);
    return () => window.clearTimeout(t);
  }, [transitionKey, track.title, track.artist]);

  const composition = useMemo(
    () =>
      synced
        ? codeComposition(lines, activeIndex, position, historyBefore, layout)
        : [],
    [lines, activeIndex, position, synced, layout, historyBefore],
  );

  /**
   * The single row that owns the caret.
   *
   * Flattening can give one lyric several rows (`{`, its statement, `}`), all
   * sharing a `lyricIndex`. Marking every one of them active drew a caret per
   * row, so a block showed two blocks at once. The caret belongs to exactly one
   * row: the statement row when the lyric has one, otherwise the last row.
   */
  const cursorRow = useMemo(() => {
    if (composition.length === 0) return -1;
    const carry = composition.filter((cl) => cl.lyricIndex === activeIndex);
    const statement = carry.find((cl) => cl.kind === "statement");
    return (statement ?? carry[carry.length - 1] ?? composition[composition.length - 1]).index;
  }, [composition, activeIndex]);

  // Keep the active line visible when the composition is taller than the
  // viewport (long or wrapped lines). Without this the active row could sit
  // below the fold and the user would be reading along while nothing moved.
  const codeViewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = codeViewRef.current;
    if (!view) return;
    const row = view.querySelector<HTMLElement>(".code-line.active");
    if (!row) return;
    const vTop = view.scrollTop;
    const vBottom = vTop + view.clientHeight;
    const rTop = row.offsetTop;
    const rBottom = rTop + row.offsetHeight;
    // Only scroll when the row is actually out of view, so steady playback does
    // not fight the user's manual scrolling.
    if (rBottom > vBottom) view.scrollTop = rBottom - view.clientHeight;
    else if (rTop < vTop) view.scrollTop = rTop;
  }, [cursorRow, activeIndex, composition]);

  // Dragging is performed by the Rust backend via a native Win32 caption drag
  // (ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION), which is more reliable than
  // the webview `startDragging()` path on frameless/transparent windows. The
  // Rust command also refuses to drag when position is locked.
  const allowDrag = !cfg.lockPosition;
  const handleDrag = (e: ReactMouseEvent) => {
    if (!allowDrag || e.button !== 0) return;
    // Never start a window drag from an interactive control. `drag_overlay`
    // performs a native `WM_NCLBUTTONDOWN` caption drag, which hands the press
    // to the window manager and swallows the click â€” React then never
    // synthesises it, so every button inside the overlay became inert.
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, select, textarea, [role='button'], [role='slider'], .code-line.seekable, .ov-progress"
      )
    ) {
      return;
    }
    e.preventDefault();
    invoke("drag_overlay").catch(() => {});
  };

  const style = useMemo(
    () =>
      ({
        fontSize: cfg.fontSize,
      }) as React.CSSProperties,
    [cfg.fontSize],
  );

  const noMedia = !track.hasSession;

  // --- Lyric replay -------------------------------------------------------
  // A replay is a lyric line range loop enforced through `mediaSeek`. It is
  // cleared on track change so a previous song's range can never apply here.
  const [replay, setReplay] = useState<ReplayState>(initialReplayState);
  const replayRef = useRef<ReplayState>(initialReplayState());
  const replaySeekAt = useRef(0);
  const replayTrackKey = useRef("");

  useEffect(() => {
    replayRef.current = replay;
  }, [replay]);

  // Drop the replay when the track changes (range indexes are per-track).
  useEffect(() => {
    const key = `${track.title}\u0000${track.artist}`;
    if (replayTrackKey.current && replayTrackKey.current !== key) {
      setReplay((prev) => replaySurvivesTrackChange(prev, replayTrackKey.current, key));
    }
    replayTrackKey.current = key;
  }, [track.title, track.artist]);

  // Enforcement runs on the same clock the lyrics use, so looping never fights
  // the reveal: it only asks for a seek when playback leaves the range.
  useEffect(() => {
    if (!replay.range) return;
    const res = replayAction(lines, replay, position, Date.now(), replaySeekAt.current);
    if (res.seekTo !== null) {
      replaySeekAt.current = Date.now();
      positionRef.current = res.seekTo;
      setPosition(res.seekTo);
      const idx = activeLineIndex(lines, res.seekTo);
      activeIndexRef.current = idx;
      setActiveIndex(idx);
      api.mediaSeek(res.seekTo).catch(() => {});
    } else if (res.ended) {
      setReplay(initialReplayState());
    }
  }, [position, replay, lines]);

  const startReplay = useCallback((from: number, to: number, loop: boolean) => {
    setReplay({ range: { from, to, loop } });
    replaySeekAt.current = 0;
  }, []);
  // --- Click to seek ------------------------------------------------------
  // A click resolves through the composition's `lyricIndex` back to the original
  // lyric line, so tapping a brace, indent or comment seeks exactly like tapping
  // the statement it belongs to. The timestamp always comes from the lyric data;
  // nothing is inferred from where the row sits on screen.
  const seekBusyRef = useRef(0);
  const handleSeekToLine = useCallback(
    (lineIndex: number, extend = false) => {
      const target = seekTargetForRow({ lyricIndex: lineIndex }, contextRef.current.lines);
      if (!target) return;

      // Shift-click extends the current replay selection instead of seeking:
      // that is how a range is chosen without introducing an editor UI.
      if (extend) {
        const anchor = replayRef.current.range?.from ?? activeIndexRef.current;
        if (anchor >= 0 && anchor !== lineIndex) {
          startReplay(Math.min(anchor, lineIndex), Math.max(anchor, lineIndex), true);
          return;
        }
        startReplay(lineIndex, lineIndex, true);
        return;
      }

      // A plain click clears any active replay so playback is not dragged back.
      if (replayRef.current.range) setReplay(initialReplayState());

      // Guard against a burst of clicks issuing overlapping seeks.
      const now = Date.now();
      if (now - seekBusyRef.current < 180) return;
      seekBusyRef.current = now;

      // Re-anchor locally at once so the reveal and caret jump on this frame
      // instead of waiting for the poll to confirm the new position.
      positionRef.current = target.ms;
      setPosition(target.ms);
      const idx = activeLineIndex(contextRef.current.lines, target.ms);
      activeIndexRef.current = idx;
      setActiveIndex(idx);

      api.mediaSeek(target.ms).catch(() => {
        /* a refused seek is corrected by the next poll */
      });
    },
    [startReplay],
  );


  // --- Mini progress indicator -------------------------------------------
  const durationMs = track.durationMs || context.durationMs || 0;
  const progressFraction =
    durationMs > 0 ? Math.min(1, Math.max(0, position / durationMs)) : 0;

  const seekFraction = useCallback((fraction: number) => {
    const target = seekTargetForFraction(fraction, trackRef.current.durationMs || 0);
    if (target === null) return;
    positionRef.current = target;
    setPosition(target);
    api.mediaSeek(target).catch(() => {});
  }, []);

  const handleProgressClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const box = e.currentTarget.getBoundingClientRect();
      if (box.width <= 0) return;
      seekFraction((e.clientX - box.left) / box.width);
    },
    [seekFraction],
  );

  // Keyboard nudging reads the latest fraction from a ref so the callback stays
  // stable (and the bar is not re-bound on every animation frame).
  const fractionRef = useRef(0);
  fractionRef.current = progressFraction;
  const nudgeProgress = useCallback(
    (delta: number) => seekFraction(fractionRef.current + delta),
    [seekFraction],
  );

  // --- Code snapshot ------------------------------------------------------
  // Clones the live `.code-view`, so the export is the real composition with its
  // real syntax colours rather than a text reconstruction.
  const [snapshotting, setSnapshotting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastNonce = useRef(0);

  /** Shows one toast, replacing any current one and restarting its timer. */
  const showToast = useCallback((kind: ToastState["kind"], message: string, detail: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastNonce.current += 1;
    setToast({ kind, message, detail, nonce: toastNonce.current });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const handleSnapshot = useCallback(async () => {
    if (snapshotting) return;
    const view = document.querySelector<HTMLElement>(".code-view");
    const root = document.querySelector<HTMLElement>(".overlay");
    setSnapshotting(true);
    try {
      if (!view || !root) throw new Error("overlay not ready");
      const theme = readSnapshotTheme(root);
      // Draw from the live token colours with canvas `fillText`. An SVG +
      // foreignObject path taints the canvas in WebView2, which made the export
      // throw `SecurityError` and look like a dead button.
      const rows = extractRows(view);
      if (rows.length === 0) throw new Error("nothing to capture");
      const { blob } = await renderSnapshotPng({
        rows,
        theme,
        fileName: lyricFileName(trackRef.current),
        title: trackRef.current.title,
        artist: trackRef.current.artist,
      });
      const name = snapshotFileName(lyricFileName(trackRef.current));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      // Only reached once the blob was built and the download was dispatched.
      showToast("success", "Snapshot saved successfully", `${name} · Downloads`);
    } catch (err) {
      // A failed export must never disturb playback or rendering. Report it to
      // the console and tell the user, so the button never looks dead.
      console.error("snapshot failed", err);
      const reason = err instanceof Error ? err.message : String(err);
      showToast("error", "Snapshot failed", reason || "Unknown error");
    } finally {
      setSnapshotting(false);
    }
  }, [snapshotting, showToast]);

  // --- Playback transport -------------------------------------------------
  // `pending` guards against rapid repeat clicks producing conflicting
  // commands; the returned state is authoritative, so the icon is reconciled
  // from GSMTC rather than flipped optimistically.
  const [pending, setPending] = useState<TransportAction | null>(null);

  const handleTransport = useCallback(
    async (action: TransportAction) => {
      if (pending) return;
      setPending(action);
      try {
        const res = await api.mediaTransport(action);
        // Adopt the state the session reported after the action. On failure we
        // leave the snapshot alone: the next poll re-syncs the truth.
        if (res.ok) {
          setTrack((prev) =>
            prev.playbackState === res.state
              ? prev
              : { ...prev, playbackState: res.state },
          );
        }
      } catch {
        // A failed command must not leave the UI showing a wrong icon; the
        // poll-driven snapshot restores the real state on the next tick.
      } finally {
        setPending(null);
      }
    },
    [pending],
  );
  const instrumental = context.instrumental;
  const cursorClass = cursorClassFor(cfg.cursorStyle);
  const fileName = noMedia ? IDLE_FILE_NAME : lyricFileName(track);
  const sourceLabel = wordSynced
    ? `${context.source.toUpperCase()} / ${(context.wordGranularity || "word").toUpperCase()} SYNC`
    : synced
      ? `${context.source.toUpperCase()} / LINE SYNC`
      : "PLAIN LYRICS / NO SYNC";

  return (
    <div
      data-syntax={syntaxTheme.id}
      className={`overlay theme-${cfg.theme} ${
        cfg.lockPosition ? "locked" : ""
      } completed-${cfg.completedWordColor}`}
      style={style}
      onMouseDown={handleDrag}
    >
      {noMedia ? (
        <TerminalView
          lines={term.log}
          phase="disconnected"
          fileName={fileName}
          showLog={cfg.showTerminalActivity}
          booting={false}
        />
      ) : (
        <>
          <div className="ov-header">
            <span className="ov-prompt">&gt;</span>
            <span className="ov-brand">LYNRICSX_</span>
            <span className="ov-tab" title={fileName}>
              <span className="ov-tab-icon" aria-hidden="true">
                {"</>"}
              </span>
              <span className="ov-tab-name">{fileName}</span>
            </span>
            <span className="ov-right">
              <button
                type="button"
                className="ov-icon-btn"
                title="Save code snapshot (PNG)"
                aria-label="Save code snapshot as PNG"
                disabled={snapshotting}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleSnapshot();
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <rect x="1" y="2.5" width="10" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.1" />
                  <circle cx="6" cy="6" r="1.9" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </button>
              {cfg.showTrackSource && (
                <>
                  <span className="ov-source">
                    {track.sourceAppName || "Spotify"}
                  </span>
                </>
              )}
              <ActivityBars state={track.playbackState} visible={true} phase={term.phase} />
              <span className="ov-time">
                {formatTime(position)} / {formatTime(track.durationMs || context.durationMs)}
              </span>
            </span>
          </div>

          {/* Song information: real GSMTC metadata only. Hidden when absent. */}
          {(track.title || track.artist) && (
            <div className="ov-song">
              <div className={`ov-song-info${transitionOn ? " track-in" : ""}`}>
                {track.title && <div className="ov-song-title">{track.title}</div>}
                {track.artist && <div className="ov-song-artist">{track.artist}</div>}
              </div>
              <PlaybackControls
                state={track.playbackState}
                available={!noMedia}
                pending={pending}
                onAction={handleTransport}
              />
            </div>
          )}

          <div className="ov-body">
            {instrumental ? (
              <div className="ov-notice">INSTRUMENTAL ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â NO LYRICS</div>
            ) : !synced && lines.length > 0 ? (
              <div className="ov-plain">
                {lines.slice(0, 5).map((l, i) => (
                  <div key={i} className="ov-plain-line">
                    {l.text || "\u00a0"}
                  </div>
                ))}
              </div>
            ) : !synced && lines.length === 0 ? (
              <TerminalView
                lines={term.log}
                phase={term.phase}
                fileName={fileName}
                showLog={cfg.showTerminalActivity}
                booting={term.phase === "booting"}
              />
            ) : activeIndex < 0 ? (
              <TerminalView
                lines={term.log}
                phase={term.phase}
                fileName={fileName}
                showLog={cfg.showTerminalActivity}
                booting={false}
              />
            ) : (
              <div className={`code-view${transitionOn ? " track-in" : ""}`} ref={codeViewRef}>
                {composition.map((cl) => (
                  <CodeRow
                    key={cl.index}
                    line={cl}
                    isActive={cl.lyricIndex === activeIndex}
                    cursorClass={cl.index === cursorRow ? cursorClass : ""}
                    typewriter={cfg.typewriter}
                     onSeek={synced ? handleSeekToLine : undefined}
                     seekable={isSeekable(lines[cl.lyricIndex])}
                     inReplay={
                       !!replay.range &&
                       cl.lyricIndex >= Math.min(replay.range.from, replay.range.to) &&
                       cl.lyricIndex <= Math.max(replay.range.from, replay.range.to)
                     }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Surplus height collapses here instead of padding the lyrics. */}
          <div className="ov-spacer" />

          {/* Mini progress: a thin line whose length is the real playback
              fraction. Clicking it seeks via the same clamped backend path. */}
          <div
            className={`ov-progress ${track.playbackState === "paused" ? "paused" : ""}`}
            role="slider"
            aria-label="Playback position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressFraction * 100)}
            tabIndex={0}
            title={`${formatClock(position)} / ${formatClock(track.durationMs || context.durationMs)}`}
            onClick={handleProgressClick}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") nudgeProgress(-0.02);
              if (e.key === "ArrowRight") nudgeProgress(0.02);
            }}
          >
            <span className="ov-progress-track" aria-hidden="true">
              <span
                className="ov-progress-fill"
                style={{ width: `${Math.min(100, progressFraction * 100)}%` }}
              />
            </span>
          </div>

          <div className="ov-footer">
            <span
              className={`sync-tag ${wordSynced ? "word" : synced ? "line" : "plain"}`}
            >
              {sourceLabel}
            </span>
            {replay.range && (
              <button
                type="button"
                className="ov-replay-tag"
                title="Stop replay"
                onClick={(e) => {
                  e.stopPropagation();
                  setReplay(initialReplayState());
                }}
              >
                <span aria-hidden="true">Ã¢Å¸Â³</span> REPLAY {replay.range.loop ? "LOOP" : ""} Ã‚Â· STOP
              </button>
            )}
          </div>
        </>
      )}

      {/* Snapshot feedback: one reusable toast, never overlapping. */}
      <SnapshotToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
