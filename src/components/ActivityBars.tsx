import type { PlaybackState } from "../types";

/**
 * Compact playback activity indicator.
 *
 * NOT a waveform or spectrum analyser: no audio data is available, so this is a
 * purely decorative activity animation. It is driven entirely by CSS keyframes
 * whose `animation-play-state` follows the real playback state, so a paused or
 * disconnected session leaves the bars static and costs no CPU.
 *
 * `phase` additionally reflects a real processing stage (searching, fetching,
 * processing). When present, the dot pulses to signal that work is genuinely in
 * flight rather than implying audio amplitude.
 */
export default function ActivityBars({
  state,
  visible,
  phase,
}: {
  state: PlaybackState;
  visible: boolean;
  /** Real terminal phase, when the overlay knows it. */
  phase?: string | null;
}) {
  const playing = state === "playing";
  const active = playing || state === "paused";
  const processing =
    phase === "searching" || phase === "fetching" || phase === "processing" || phase === "detecting";

  return (
    <span
      className={`activity ${playing ? "playing" : "idle"} ${processing ? "processing" : ""}`}
      aria-label={
        processing
          ? "Processing"
          : playing
            ? "Playing"
            : state === "paused"
              ? "Paused"
              : "Inactive"
      }
      title={
        processing
          ? "Processing"
          : playing
            ? "Playing"
            : state === "paused"
              ? "Paused"
              : "Inactive"
      }
    >
      {visible && (
        <>
          <span
            className={`activity-dot ${active ? "on" : ""} ${processing ? "busy" : ""}`}
            aria-hidden="true"
          />
          <span className="activity-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        </>
      )}
    </span>
  );
}
