import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, CircleAlert, X } from "lucide-react";
import "./snackbar.css";

type Variant = "success" | "error";
/** Reusable, persistent content. Keep dialog actions here, inside its focus trap. */
export function Notification({ message, children, onDismiss, variant = "success", className = "" }: {
  message: string; children?: ReactNode; onDismiss?: () => void; variant?: Variant; className?: string;
}) {
  return <div className={`notification ${className}`} data-variant={variant}>
    {variant === "error" ? <CircleAlert size={18} aria-hidden="true" /> : <CircleCheck size={18} aria-hidden="true" />}
    <div className="notification-content"><p role={variant === "error" ? "alert" : "status"} aria-atomic="true">{message}</p>{children}</div>
    {onDismiss && <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>}
  </div>;
}

function ToastViewport({ message, onDismiss, variant = "success", announcementId }: { message: string; onDismiss: () => void; variant?: Variant; announcementId?: number }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!message) { setHovered(false); setFocused(false); return; }
    if (hovered || focused) return;
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, hovered, focused, announcementId]);
  return createPortal(<div className="snackbar" data-open={!!message} aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {message ? <Notification key={announcementId} message={message} variant={variant} onDismiss={onDismiss} /> : <p role="status" aria-atomic="true" className="sr-only" />}
  </div>, document.body);
}

/** Legacy local messages share one viewport but retain their own lifetime:
 * clearing a message or unmounting its owner removes only that owner's toast. */
export function Snackbar({ message, onDismiss, variant = "success" }: { message: string; onDismiss: () => void; variant?: Variant }) {
  const notify = useNotification();
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!message) return;
    return notify(message, variant, () => dismiss.current());
  }, [message, variant, notify]);
  return null;
}

const NotificationContext = createContext<(message: string, variant?: Variant, onDismiss?: () => void) => () => void>(() => () => {});
export const useNotification = () => useContext(NotificationContext);
export function NotificationProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [notice, setNotice] = useState<{ id: number; message: string; variant: Variant; onDismiss?: () => void } | null>(null);
  const notify = useCallback((message: string, variant: Variant = "success", onDismiss?: () => void) => {
    const id = ++sequence.current;
    setNotice({ id, message, variant, onDismiss });
    return () => setNotice((current) => current?.id === id ? null : current);
  }, []);
  const dismiss = useCallback(() => {
    notice?.onDismiss?.();
    setNotice((current) => current?.id === notice?.id ? null : current);
  }, [notice]);
  return <NotificationContext.Provider value={notify}>{children}<ToastViewport announcementId={notice?.id ?? 0} message={notice?.message ?? ""} variant={notice?.variant} onDismiss={dismiss} /></NotificationContext.Provider>;
}
