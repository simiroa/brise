import type { NoteSummary } from "./commands.gen";

export interface WorkspaceCandidate {
  noteId: string;
  title: string;
  reason: string;
  score: number;
}

export interface WorkspaceFilterResult {
  candidates: WorkspaceCandidate[];
  totalEvaluated: number;
  truncatedCount: number;
}

const MAX_CANDIDATES_CAP = 30;

/**
 * 2-Pass Filter Step 1: Local compressed signal detection on NoteSummary rows.
 *
 * Available signals on NoteSummary today (no extra IPC):
 *   - duplicate / near-duplicate titles
 *   - tag overlaps (tag_names; hydrateTagNames when the query path returns empty tags)
 *   - event-date collisions (year+month+day)
 *
 * Not available here: V24 `attachments.content_hash` lives on attachment rows and is used by
 * note_related scoring — NoteSummary has no content_hash field, so this pass cannot claim
 * hash-based duplicate detection without a dedicated query. Do not document otherwise.
 *
 * Produces a capped candidate set without loading full note bodies (docs/SCALABILITY.md).
 */
export function filterWorkspaceCandidates(notes: NoteSummary[]): WorkspaceFilterResult {
  const totalEvaluated = notes.length;
  if (totalEvaluated === 0) {
    return { candidates: [], totalEvaluated: 0, truncatedCount: 0 };
  }

  const candidateMap = new Map<string, { note: NoteSummary; reasons: string[]; score: number }>();

  const addSignal = (note: NoteSummary, reason: string, points: number) => {
    const existing = candidateMap.get(note.id);
    if (existing) {
      existing.reasons.push(reason);
      existing.score += points;
    } else {
      candidateMap.set(note.id, { note, reasons: [reason], score: points });
    }
  };

  // Signal 1: Title exact match (normalized)
  const titleGroups = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    const norm = n.title.trim().toLowerCase();
    if (!norm || norm === "untitled note" || norm === "untitled" || norm === "제목 없음") continue;
    const group = titleGroups.get(norm) || [];
    group.push(n);
    titleGroups.set(norm, group);
  }

  for (const [title, group] of titleGroups.entries()) {
    if (group.length > 1) {
      for (const n of group) {
        addSignal(n, `Duplicate title "${title}" (${group.length} notes)`, 30);
      }
    }
  }

  // Signal 2: Tag overlaps — notes that share at least one real tag with another note
  // (single-note-only tags are not a signal). Score by number of shared peer tags.
  const tagToNotes = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    const seen = new Set<string>();
    for (const raw of n.tag_names ?? []) {
      const tag = raw.trim().toLowerCase();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const group = tagToNotes.get(tag) || [];
      group.push(n);
      tagToNotes.set(tag, group);
    }
  }

  const tagOverlapScore = new Map<string, { peers: number; tags: string[] }>();
  for (const [tag, group] of tagToNotes.entries()) {
    if (group.length < 2) continue;
    for (const n of group) {
      const cur = tagOverlapScore.get(n.id) || { peers: 0, tags: [] };
      cur.peers += group.length - 1;
      cur.tags.push(tag);
      tagOverlapScore.set(n.id, cur);
    }
  }
  for (const [noteId, info] of tagOverlapScore.entries()) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) continue;
    const tagList = info.tags.slice(0, 3).join(", ");
    addSignal(
      note,
      `Tag overlap (${tagList}${info.tags.length > 3 ? "…" : ""}; ~${info.peers} peer links)`,
      Math.min(25, 8 + info.peers * 2),
    );
  }

  // Signal 3: Event date collisions (same year + month + day), 3+ notes on one day
  const dateGroups = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    if (n.year && n.month && n.day) {
      const key = `${n.year}-${n.month}-${n.day}`;
      const group = dateGroups.get(key) || [];
      group.push(n);
      dateGroups.set(key, group);
    }
  }

  for (const [dateStr, group] of dateGroups.entries()) {
    if (group.length > 2) {
      for (const n of group) {
        addSignal(n, `Same date collision (${dateStr}, ${group.length} notes)`, 15);
      }
    }
  }

  const allCandidates: WorkspaceCandidate[] = Array.from(candidateMap.values())
    .map((item) => ({
      noteId: item.note.id,
      title: item.note.title,
      reason: item.reasons.join(" · "),
      score: item.score,
    }))
    .sort((a, b) => b.score - a.score);

  const truncatedCount = Math.max(0, allCandidates.length - MAX_CANDIDATES_CAP);
  const candidates = allCandidates.slice(0, MAX_CANDIDATES_CAP);

  return {
    candidates,
    totalEvaluated,
    truncatedCount,
  };
}
