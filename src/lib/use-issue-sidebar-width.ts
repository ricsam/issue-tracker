import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

const storageKey = "issue-tracker:issue-sidebar-width";
const defaultWidth = 680;
const minWidth = 420;
const maxWidth = 1000;
const collectionMinWidth = 320;

function readWidth() {
  try {
    const value = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(value) && value >= minWidth && value <= maxWidth)
      return value;
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
  return defaultWidth;
}

export function useIssueSidebarWidth(
  sidebar: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [available, setAvailable] = useState(maxWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const container = sidebar.current?.parentElement;
    if (!enabled || !container) return;
    const measure = () =>
      setAvailable(Math.max(minWidth, container.clientWidth - collectionMinWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sidebar, enabled]);

  const maximum = Math.min(maxWidth, available);
  const width = Math.min(preferredWidth, maximum);
  function remember(next: number) {
    const value = Math.round(Math.max(minWidth, Math.min(maximum, next)));
    setPreferredWidth(value);
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // Private or restricted browsing should not break the split view.
    }
  }

  return {
    width,
    resizing,
    separatorProps: {
      role: "separator" as const,
      tabIndex: 0,
      "aria-label": "Resize issue details",
      "aria-controls": "issue-detail-sidebar",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": minWidth,
      "aria-valuemax": maximum,
      "aria-valuenow": width,
      "aria-valuetext": `${width} pixels wide`,
      title: "Drag to resize. Use arrow keys to adjust; double-click to reset.",
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        setResizing(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId !== event.pointerId) return;
        remember(drag.current.width + drag.current.x - event.clientX);
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setResizing(false);
      },
      onLostPointerCapture() {
        drag.current = null;
        setResizing(false);
      },
      onPointerCancel() {
        drag.current = null;
        setResizing(false);
      },
      onDoubleClick() {
        remember(defaultWidth);
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = event.shiftKey ? 50 : 10;
        const next = {
          ArrowLeft: width + step,
          ArrowRight: width - step,
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
