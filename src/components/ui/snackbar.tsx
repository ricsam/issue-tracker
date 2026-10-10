import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
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

export function ToastViewport({ message, onDismiss, variant = "success", announcementId, children, inline = false, paused = false }: { message: string; onDismiss: () => void; variant?: Variant; announcementId?: number; children?: ReactNode; inline?: boolean; paused?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!message) { setHovered(false); setFocused(false); return; }
    if (hovered || focused || paused) return;
    const timer = window.setTimeout(onDismiss, children ? 10000 : 5000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, hovered, focused, announcementId, paused, !!children]);
  const content = <div className={inline ? "dialog-snackbar" : "snackbar"} data-open={!!message}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {message ? <Notification key={announcementId} message={message} variant={variant} onDismiss={paused ? undefined : onDismiss}>{children}</Notification> : <p role="status" aria-atomic="true" className="sr-only" />}
  </div>;
  return inline ? content : createPortal(content, document.body);
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

const NotificationContext = createContext<(message: string, variant?: Variant, onDismiss?: () => void, action?: ReactNode) => () => void>(() => () => {});
export const useNotification = () => useContext(NotificationContext);
export function NotificationProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const sequence = useRef(0);
  const [notice, setNotice] = useState<{ id: number; message: string; variant: Variant; onDismiss?: () => void; action?: ReactNode } | null>(null);
  // Route-owned actions must never call an unmounted page, including after back navigation.
  useEffect(() => { setNotice((current) => current?.action ? null : current); }, [location.key]);
  const notify = useCallback((message: string, variant: Variant = "success", onDismiss?: () => void, action?: ReactNode) => {
    const id = ++sequence.current;
    setNotice({ id, message, variant, onDismiss, action });
    return () => setNotice((current) => current?.id === id ? null : current);
  }, []);
  const dismiss = useCallback(() => {
    notice?.onDismiss?.();
    setNotice((current) => current?.id === notice?.id ? null : current);
  }, [notice]);
  return <NotificationContext.Provider value={notify}>{children}<ToastViewport announcementId={notice?.id ?? 0} message={notice?.message ?? ""} variant={notice?.variant} onDismiss={dismiss}>{notice?.action}</ToastViewport></NotificationContext.Provider>;
}
