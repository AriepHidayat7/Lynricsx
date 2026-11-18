/**
 * Snapshot feedback toast.
 *
 * Appears only after a real export outcome: success once the PNG has been
 * handed to the browser's download pipeline, or an error when generation
 * failed. It never overlays the lyrics or the playback controls — it is
 * anchored to the header area and is `pointer-events: none`.
 *
 * A single instance is reused: capturing again replaces the content and
 * restarts the timer, so rapid clicks can never stack notifications.
 */
export type ToastState = {
  kind: "success" | "error";
  /** Primary line, e.g. "Snapshot saved successfully". */
  message: string;
  /** Secondary line, e.g. "lynricsx-….png · Downloads". */
  detail: string;
  /** Bumped on every show so the entrance animation replays. */
  nonce: number;
};

export default function SnapshotToast({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`ov-toast ${toast ? `ov-toast-${toast.kind} shown` : ""}`}
      // `polite` announces without interrupting playback reading.
      aria-live="polite"
      aria-atomic="true"
      role="status"
    >
      {toast && (
        <div className="ov-toast-body" key={toast.nonce} onClick={onDismiss}>
          <span className="ov-toast-icon" aria-hidden="true">
            {toast.kind === "success" ? "✓" : "!"}
          </span>
          <span className="ov-toast-text">
            <span className="ov-toast-msg">{toast.message}</span>
            {toast.detail && <span className="ov-toast-detail">{toast.detail}</span>}
          </span>
        </div>
      )}
    </div>
  );
}
