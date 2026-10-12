// src/desktop/WindowFit.ts
// Bridge 0.3.2 (plan backlog "Bridge window fits its content", Tim 12-10-2026): the window is as tall as the page it
// shows (one connection: short; many, or Settings: taller), never shorter than the minimum, never taller than the
// screen (the page scrolls then). Once the player resizes by hand, the Bridge leaves the size alone for this run.

// Content height (inside the frame) the window never goes below: header, game status, one row and the add button.
export const MIN_CONTENT_HEIGHT = 240;

export interface WorkArea { x: number; y: number; width: number; height: number }
export interface Bounds { x: number; y: number; width: number; height: number }

// The content height for a page that wants `wanted` pixels, on a screen whose work area is `area`, with `frame` pixels of
// title bar and borders around the content.
export function fittedContentHeight(wanted: number, area: WorkArea, frame: number): number {
  const most = Math.max(MIN_CONTENT_HEIGHT, area.height - Math.max(0, frame));
  if (!Number.isFinite(wanted)) return MIN_CONTENT_HEIGHT;
  return Math.min(most, Math.max(MIN_CONTENT_HEIGHT, Math.ceil(wanted)));
}

// Where the window goes after growing: moved up just enough to keep its bottom on the screen, never above the top.
export function keptOnScreen(bounds: Bounds, area: WorkArea): { x: number; y: number } {
  const bottom = area.y + area.height;
  if (bounds.y + bounds.height <= bottom) return { x: bounds.x, y: bounds.y };
  return { x: bounds.x, y: Math.max(area.y, bottom - bounds.height) };
}
