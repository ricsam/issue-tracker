import { useEffect, useState } from "react";
import { X } from "lucide-react";
import "./snackbar.css";

export function Snackbar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!message) { setHovered(false); setFocused(false); return; }
    if (hovered || focused) return;
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, hovered, focused]);

  return (
    <div className="snackbar" data-open={!!message}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      {/* Keep the polite live region mounted before its text changes. */}
      <p role="status" aria-atomic="true">{message}</p>
      {message && <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={16} aria-hidden="true" />
      </button>}
    </div>
  );
}
