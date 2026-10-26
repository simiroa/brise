import type { YearFilterMode } from "../stores/search";

/**
 * Filter modes the phone surface cannot open, even when the shared `filter_roster` has them on.
 * Empty since 2026-10-06: region became a view-only map (MobileRegionView, formerly D6) and chat
 * opened over HTTP by owner decision (MobileChatView, formerly D7 — specs/commands/pet.yaml header).
 * Kept as the one place to exclude a view again; Settings still shows a hint for anything listed.
 */
export const PHONE_EXCLUDED_MODES: ReadonlySet<YearFilterMode> = new Set<YearFilterMode>();

/** `aiEnabled=false` hides chat exactly like desktop's YearFilter (no AI → no chat tab). */
export function isPhoneUnavailableMode(mode: YearFilterMode, aiEnabled = true): boolean {
  return PHONE_EXCLUDED_MODES.has(mode) || (mode === "chat" && !aiEnabled);
}
