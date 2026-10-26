/**
 * Screen vocabulary of the phone shell (MobileApp) — shared by MobileApp and MobileTabBar so the
 * tab bar never imports the component that renders it.
 */
export type Screen = "home" | "capture" | "settings" | "note" | "search" | "postsave";
export type TabScreen = "home" | "capture" | "settings";

/** Left-to-right order the bottom tab bar renders in — the two-layer slide's direction is derived
 *  from this (higher index = forward/slide-in-from-right, lower = back). */
export const TAB_ORDER: TabScreen[] = ["home", "capture", "settings"];

/** History entry shape. `idx` = how many entries sit above the home root (home = 0). See
 *  MobileApp.tsx for the stack invariant. */
export type HistState = { screen: Screen; idx: number };
