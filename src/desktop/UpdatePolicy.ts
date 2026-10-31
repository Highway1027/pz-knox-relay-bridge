// src/desktop/UpdatePolicy.ts

// Bridge 0.3.6 (Tim, 31-10-2026): when a downloaded update restarts the Bridge by itself.
// - open: the check right after the Bridge opens restarts at once, even while a game runs (the
//   game misses a few seconds of Bridge, nothing is lost). Not after a restart this rule made
//   itself, so an update that fails to start can never loop.
// - interval and game-closed: only while no game is running; a game closing checks again.
// - force (Settings > Force update): at once, also during a game (for a hotfix).

export type UpdateTrigger = "open" | "interval" | "game-closed" | "force";

// Director states in which no game is being played (BridgeDirector's DirectorStatus.state).
const NO_GAME_STATES = new Set(["idle", "no_game_folder", "stopped"]);

export function gameRunning(states: readonly string[]): boolean {
  return states.some((state) => !NO_GAME_STATES.has(state));
}

export function shouldRestart(input: { trigger: UpdateTrigger; pendingVersion?: string; gameRunning: boolean; afterUpdateRestart: boolean }): boolean {
  if (!input.pendingVersion) return false;
  if (input.trigger === "force") return true;
  if (input.trigger === "open" && !input.afterUpdateRestart) return true;
  return !input.gameRunning;
}

// The flag a restart made by an update carries, so the next open does not restart again.
export const AFTER_UPDATE_ARG = "--knox-after-update";
