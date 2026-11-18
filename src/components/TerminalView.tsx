import { useEffect, useRef, useState } from "react";
import type { TerminalLine, Phase } from "../lib/terminal";
import { linesThatFit, terminalMode, visibleTail, type TerminalMode } from "../lib/termFit";

/** Clock string for a log line, e.g. `20:31:04`. */
function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Boot / loading terminal.
 *
 * Used instead of the old static STANDBY text: it shows the real event log so
 * the user can see which stage the app is actually in. Lyrics, once available,
 * always take over immediately â€” this is only shown while there is nothing to
 * render yet.
 *
 * The log adapts to the space it actually has. It measures itself with a
 * `ResizeObserver` and derives how many lines fit, so the terminal can never
 * clip or overflow its container: as the overlay shrinks it shows fewer
 * historical lines, keeping the newest ones, and below a threshold it collapses
 * to a single-line status. The lyrics are never affected â€” this only ever
 * reduces the terminal's own footprint.
 */
export default function TerminalView({
  lines,
  phase,
  fileName,
  showLog,
  booting,
}: {
  lines: TerminalLine[];
  phase: Phase;
  fileName: string;
  showLog: boolean;
  booting: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  // How many log lines fit, and how the terminal should present itself.
  // `hidden` means there is not even room for one legible line: the terminal
  // yields entirely so the lyrics keep every pixel they need.
  const [fit, setFit] = useState(6);
  const [mode, setMode] = useState<TerminalMode>("log");

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      const h = root.clientHeight;
      const nextMode = terminalMode(h);
      setMode(nextMode);
      if (nextMode !== "log") return;
      // Derive the space left for rows from the real geometry: the container
      // minus its vertical padding and borders, minus the file and prompt rows,
      // minus the flex gaps between them. Measuring beats hardcoded constants,
      // which drift from the stylesheet and previously collapsed the log.
      const cs = getComputedStyle(root);
      const padY =
        (parseFloat(cs.paddingTop) || 0) +
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderTopWidth) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0);
      const gap = parseFloat(cs.rowGap || cs.gap) || 0;
      const fileH = root.querySelector<HTMLElement>(".term-file")?.offsetHeight ?? 0;
      const promptH = root.querySelector<HTMLElement>(".term-prompt")?.offsetHeight ?? 0;
      // Gap only counts between siblings that are actually rendered, so the
      // count is derived rather than assumed to be two.
      const gaps = gap * (showLog ? 2 : 1);
      const available = h - padY - fileH - promptH - gaps;
      const first = linesRef.current?.querySelector<HTMLElement>(".term-line");
      setFit(
        linesThatFit(available, {
          // Fall back to the computed line-height before the first row exists.
          // Rows are `flex: 0 0 auto`, so a rendered row's height is its true
          // height rather than a squashed remnant of the flex algorithm.
          rowHeight:
            first?.offsetHeight || Math.round(parseFloat(cs.lineHeight) || 0) || 16,
        }),
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The fixed chrome (file row, prompt) can reflow without the terminal's own
    // box changing — e.g. the prompt wrapping to two lines — so observe it too.
    const promptEl = el.querySelector<HTMLElement>(".term-prompt");
    if (promptEl) ro.observe(promptEl);
    const fileEl = el.querySelector<HTMLElement>(".term-file");
    if (fileEl) ro.observe(fileEl);
    return () => ro.disconnect();
  }, [lines.length, showLog, phase]);

  const compact = mode !== "log";
  // Newest lines win: keep only the tail that fits.
  const visible = mode === "log" && showLog ? visibleTail(lines, fit) : [];

  // Not enough room for anything legible: step out of the layout entirely.
  if (mode === "hidden") return null;

  return (
    <div
      ref={rootRef}
      className={`terminal phase-${phase}${compact ? " term-compact" : ""}`}
      role="log"
      aria-live="polite"
    >
      <div className="term-file">
        <span className="term-icon" aria-hidden="true">
          {"</>"}
        </span>
        <span className="term-filename">{fileName}</span>
      </div>

      {showLog && (
        <div className="term-lines" ref={linesRef}>
          {visible.map((l) => (
            <div className="term-line" key={l.id}>
              <span className="term-time">{clock(l.at)}</span>
              <span className={`term-tag tone-${l.tone}`}>[{l.tag}]</span>
              <span className="term-text">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="term-prompt">
        <span className="term-caret">&gt;_</span>
        <span className="term-pending">{pendingLabel(phase, booting)}</span>
        {!compact && <span className="cursor cursor-block term-cursor" />}
      </div>
    </div>
  );
}

/** Short, honest description of what the app is waiting on. */
function pendingLabel(phase: Phase, booting: boolean): string {
  if (booting) return "Boot sequence complete.";
  switch (phase) {
    case "searching":
      return "Searching lyric providers...";
    case "fetching":
      return "Retrieving lyrics...";
    case "processing":
      return "Preparing composition...";
    case "detecting":
      return "Reading track metadata...";
    case "ready":
    case "playing":
      return "Synchronizing...";
    case "paused":
      return "Execution suspended.";
    case "disconnected":
      return "Waiting for media session...";
    case "error":
      return "Waiting for the next track...";
    default:
      return "Waiting for media session...";
  }
}
