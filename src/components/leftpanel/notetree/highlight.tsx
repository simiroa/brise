import React from "react";

export type HighlightSegment = {
  text: string;
  hit: boolean;
};

/**
 * Splits text with STX (\u0002) and ETX (\u0003) sentinels inserted by FTS5 / backend snippet.
 */
export function splitSnippet(text: string): HighlightSegment[] {
  if (!text) return [];
  const segments: HighlightSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const startIdx = remaining.indexOf("\u0002");
    if (startIdx === -1) {
      segments.push({ text: remaining, hit: false });
      break;
    }
    if (startIdx > 0) {
      segments.push({ text: remaining.slice(0, startIdx), hit: false });
    }
    remaining = remaining.slice(startIdx + 1);

    const endIdx = remaining.indexOf("\u0003");
    if (endIdx === -1) {
      // Unclosed sentinel safety fallback
      segments.push({ text: remaining, hit: true });
      break;
    }
    segments.push({ text: remaining.slice(0, endIdx), hit: true });
    remaining = remaining.slice(endIdx + 1);
  }

  return segments;
}

/**
 * Case-insensitive substring split using indexOf scanning (no regex).
 * Used for note titles since the backend does not mark titles.
 */
export function splitByQuery(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const q = query.trim();
  if (!q) return [{ text, hit: false }];

  const segments: HighlightSegment[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      segments.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) {
      segments.push({ text: text.slice(cursor, idx), hit: false });
    }
    segments.push({ text: text.slice(idx, idx + q.length), hit: true });
    cursor = idx + q.length;
  }

  return segments;
}

/**
 * Render helper wrapping `hit` segments in a <mark>-like span styled with var(--sel)
 */
export function HighlightedText({ segments }: { segments: HighlightSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            style={{
              backgroundColor: "var(--sel)",
              color: "inherit",
              borderRadius: "2px",
              padding: "0 1px",
            }}
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </>
  );
}
