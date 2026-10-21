// Arming delay of the inline menu: entries ignore clicks / Enter for a moment after the menu appeared
// or moved, so a page cannot slide the menu under a click the user aimed at something else.

export const ARMING_DELAY_MS = 500;

export interface ArmState {
  /** when the menu last became visible or moved (performance.now()) */
  shownAt: number;
  /** the browser reports the menu as covered / not fully visible (IntersectionObserver v2) */
  occluded: boolean;
}

export function isArmed(s: ArmState, now: number): boolean {
  return !s.occluded && now - s.shownAt >= ARMING_DELAY_MS;
}
