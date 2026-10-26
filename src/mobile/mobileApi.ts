/**
 * Phone-side REST helpers against the sync server that serves this page: `/api/v1/ping` (the
 * settings screen's read-only "연결 정보") and the raw-bytes attachment upload. Everything else the
 * phone does goes through `call()` (lib/invoke.ts -> lib/httpBridge.ts), not through here.
 *
 * A plain `fetch()` with relative URLs is enough: the page itself is served by that server (see
 * docs/SYNC.md), so no isBrowser()/isTauri() branch is needed (contrast lib/httpBridge.ts, which
 * fronts the Tauri-invoke path too). The old REST note feed (`GET /api/v1/notes`, the checklist
 * toggle, the feed cache) and its card were removed — the 필터 tab reads `note_query` through the
 * shared stores now.
 */
import { authHeaders } from "../lib/env";
import { fetchWithTimeout } from "../lib/httpBridge";
import type { Attachment } from "../lib/commands.gen";

export interface MobilePing {
  app_version: string;
  schema_version: number;
  device_id: string;
  workspace_count: number;
}

/** GET /api/v1/ping — read-only "연결 정보" for the mobile settings screen. Optional by nature:
 *  never throws, a failed/unreachable ping just leaves the row blank. */
export async function fetchPing(): Promise<MobilePing | null> {
  try {
    const res = await fetchWithTimeout("/api/v1/ping", { headers: authHeaders() }, 5_000);
    if (!res.ok) return null;
    return (await res.json()) as MobilePing;
  } catch {
    return null;
  }
}

/** Client-side mirror of the sync server's ~25MB attachment cap — an instant, correct-message
 *  rejection instead of burning the whole upload before the server's own 413. The server is still
 *  the authoritative check (413 branch in uploadAttachment). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** 업로드 상한: 크기에 비례(50KB/s 가정), 최소 30초·최대 10분. 멈춘 업로드가 영영 안 끝나는 것만 막는다. */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(10 * 60_000, Math.max(30_000, Math.ceil(bytes / 50_000) * 1000));
}

/** Thrown by uploadAttachment when the file is over the cap (client-side check or the server's
 *  413) — the one failure callers tell apart from a generic network/HTTP error, which surfaces as
 *  a plain Error. */
export class AttachmentTooLargeError extends Error {}

/** 업로드에 얹는 첨부 메타(S2) — 서버 훅(repo::attachments::exif_region)이 노트 날짜·경유지에
 *  `photo_meta_mode` 정책대로 반영한다. 전부 선택이고, 깨진 값은 서버가 버린다(첨부는 그대로 받는다).
 *  이미지는 EXIF 가 우선이고 여기 값은 EXIF 에 없는 것만 채운다. */
export interface UploadMeta {
  /** 촬영/녹음 시작 시각 — RFC3339(오프셋 포함, 서버는 찍힌 곳의 벽시계 날짜를 쓴다). */
  recordedAt?: string;
  lat?: number;
  lng?: number;
}

/** 쿼리스트링 조각 — 값이 있는 것만 붙인다(숫자가 아니거나 유한하지 않은 좌표는 버린다). */
export function uploadMetaQuery(meta?: UploadMeta): string {
  if (!meta) return "";
  let q = "";
  if (meta.recordedAt) q += `&recorded_at=${encodeURIComponent(meta.recordedAt)}`;
  if (Number.isFinite(meta.lat) && Number.isFinite(meta.lng)) q += `&lat=${meta.lat}&lng=${meta.lng}`;
  return q;
}

/**
 * POST /api/v1/notes/:note_id/attachments?filename=... — single-file upload, returns the created
 * attachment row (`Attachment` shape, verified against src-tauri/src/models.rs: {id, name, kind,
 * rel_path, url, size_bytes, position}, no `mime` field). 201 on success.
 *
 * Contract confirmed against the landed src-tauri/src/sync_server/handlers/attachments.rs::attachment_upload
 * (2026-07-30) — NOT multipart: the filename travels as a query param and the request body is the
 * raw file bytes (`body: axum::body::Bytes` server-side).
 */
export async function uploadAttachment(
  noteId: string,
  file: File,
  meta?: UploadMeta,
  uploadId?: string,
): Promise<Attachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentTooLargeError("file too large");
  const url = `/api/v1/notes/${encodeURIComponent(noteId)}/attachments?filename=${encodeURIComponent(file.name)}${uploadMetaQuery(meta)}`;
  const headers = authHeaders();
  if (uploadId) {
    headers["X-Upload-Id"] = uploadId;
  }
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: file, // raw bytes — fetch streams a File/Blob body directly, no FormData wrapper
    },
    uploadTimeoutMs(file.size),
  );
  if (res.status === 413) throw new AttachmentTooLargeError("file too large");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Attachment;
}
