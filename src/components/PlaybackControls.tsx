/**
 * Playback transport controls, shown beside the track title/artist.
 *
 * Drives the Windows GSMTC session that Lynricsx already monitors, so these
 * buttons act on exactly the session whose lyrics are on screen. No Spotify Web
 * API, no credentials, no synthetic key presses.
 *
 * Clickability note: the overlay root is a drag surface (`onMouseDown` ->
 * native WM_NCLBUTTONDOWN), and `.overlay > *` sets `pointer-events: none` so
 * the whole window can be dragged. Both would swallow a press here, so the
 * buttons re-enable pointer events in CSS and stop the press from reaching the
 * drag handler. Without either, the buttons render but cannot be clicked.
 */
import type { PlaybackState } from "../types";

export type TransportAction = "toggle" | "next" | "previous";

const LABELS: Record<TransportAction, string> = {
  previous: "Previous track",
  toggle: "Play or pause",
  next: "Next track",
};

function Icon({ action, playing }: { action: TransportAction; playing: boolean }) {
  // 12x12 viewBox, currentColor so the surrounding palette drives the colour.
  if (action === "previous") {
    return (
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M1.6 1h1.3v10H1.6z" />
        <path fill="currentColor" d="M10 1.4v9.2L3.6 6z" />
      </svg>
    );
  }
  if (action === "next") {
    return (
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M2 1.4v9.2L8.4 6z" />
        <path fill="currentColor" d="M9.1 1h1.3v10H9.1z" />
      </svg>
    );
  }
  // Pause bars while playing, triangle while paused/stopped — driven purely by
  // the real playback state, never by a local toggle.
  return playing ? (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M2.6 1.2h2.5v9.6H2.6zM6.9 1.2h2.5v9.6H6.9z" />
    </svg>
  ) : (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M2.8 1.2v9.6L10.4 6z" />
    </svg>
  );
}

export default function PlaybackControls({
  state,
  available,
  pending,
  onAction,
}: {
  state: PlaybackState;
  /** False when there is no usable media session. */
  available: boolean;
  /** True while a command is in flight; all buttons are disabled. */
  pending: TransportAction | null;
  onAction: (action: TransportAction) => void;
}) {
  const playing = state === "playing";
  // "changing" means the player is mid-transition: transport is unreliable.
  const busy = pending !== null || state === "changing";
  const disabled = !available || busy;

  const button = (action: TransportAction) => {
    const title = action === "toggle" ? (playing ? "Pause" : "Play") : LABELS[action];
    const label =
      action === "toggle" ? (playing ? "Pause playback" : "Resume playback") : LABELS[action];
    return (
      <button
        type="button"
        className={`pc-btn pc-${action}${pending === action ? " pending" : ""}`}
        title={title}
        aria-label={label}
        aria-pressed={action === "toggle" ? playing : undefined}
        disabled={disabled}
        // Stop the press before it reaches the overlay's drag handler, which
        // would otherwise begin a native window drag and eat the click.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onAction(action);
        }}
      >
        <Icon action={action} playing={playing} />
      </button>
    );
  };

  return (
    <span className={`pc${available ? "" : " pc-off"}`} role="group" aria-label="Playback controls">
      {button("previous")}
      {button("toggle")}
      {button("next")}
    </span>
  );
}
