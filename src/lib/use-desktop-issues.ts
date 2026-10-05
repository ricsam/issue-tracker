import { useSyncExternalStore } from "react";

// Leave enough room for both the collection and a usable editor alongside navigation.
// Keep this breakpoint in sync with the project split-view styles.
const query = "(min-width: 1024px)";
const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

export function useDesktopIssues() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
