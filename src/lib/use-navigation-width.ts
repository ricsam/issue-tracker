import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const storageKey = "issue-tracker:navigation-width";
const minWidth = 210;
const maxWidth = 480;

function readWidth() {
  try {
    const value = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(value) && value >= minWidth && value <= maxWidth) return value;
  } catch {
    // Resizing remains available when browser storage is blocked.
  }
  return null;
}

export function useNavigationWidth(enabled: boolean) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  // Keep these breakpoints aligned with the navigation styles.
  const desktop = viewportWidth > 760;
  const defaultWidth = viewportWidth <= 1150 ? 210 : 240;
  // At the issue split-view breakpoint, reserve room for both its panes.
  const contentMinWidth = viewportWidth >= 1024 ? 740 : 520;
  const maximum = Math.max(minWidth, Math.min(maxWidth, viewportWidth - contentMinWidth));
  const width = Math.min(preferredWidth ?? defaultWidth, maximum);

  useEffect(() => {
    const measure = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!enabled || !desktop) {
      drag.current = null;
      setResizing(false);
    }
  }, [enabled, desktop]);

  function remember(next: number | null) {
    const value = next === null ? null : Math.round(Math.max(minWidth, Math.min(maximum, next)));
    setPreferredWidth(value);
    try {
      if (value === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(value));
    } catch {
      // Private browsing and quota errors must not prevent resizing.
    }
  }

  function stop() {
    drag.current = null;
    setResizing(false);
  }

  return {
    width,
    resizing,
    desktop,
    separatorProps: {
      role: "separator" as const,
      tabIndex: 0,
      "aria-label": "Resize navigation sidebar",
      "aria-controls": "workspace-navigation",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": minWidth,
      "aria-valuemax": maximum,
      "aria-valuenow": width,
      "aria-valuetext": `${width} pixels wide`,
      title: "Drag to resize. Use arrow keys to adjust; double-click to reset.",
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || !event.isPrimary || !enabled || !desktop) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        setResizing(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId !== event.pointerId) return;
        remember(drag.current.width + event.clientX - drag.current.x);
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        stop();
      },
      onLostPointerCapture: stop,
      onPointerCancel: stop,
      onDoubleClick() {
        remember(null);
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = event.shiftKey ? 50 : 10;
        const next = {
          ArrowLeft: width - step,
          ArrowRight: width + step,
          Home: minWidth,
          End: maximum,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        remember(next);
      },
    },
  };
}
