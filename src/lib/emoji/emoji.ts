/**
 * Emoji utilities re-export.
 *
 * Lightweight helpers live in `./emojiCore` (bundled SVG detection, state, src resolvers).
 * The full 109 kB browsable catalog lives in `./emojiManifest` and is loaded on-demand by the
 * emoji picker to prevent dragging the full manifest into the main application bundle.
 */
export * from "./emojiCore";
export type { EmojiEntry } from "./emojiManifest";
