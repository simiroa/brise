/**
 * 다른 앱에서 "가져오기"로 넘어온 내용(텍스트·이미지)의 순수 모델 — 셸 응답 검증, 상한, 입력 화면 초안 계획.
 * 브리지 호출은 mobileImportBridge.ts, 화면·저장 규칙은 useMobileImport.ts / MobileApp.tsx.
 *
 * 셸(mobile-shell ShellImport.kt)이 보내는 모양(`getPendingImport` 응답의 `import`):
 *   { importId, text?, subject?, textError?, omitted, items: [{idx, name, mime, size} | {idx, name, error}] }
 * 이미지 바이트는 이 메시지에 싣지 않는다 — 항목마다 `/__shell/import/<importId>/<idx>` 로 따로 받는다
 * (25MB 한 장이 base64 로 33MB 문자열이 되어 WebMessage 와 JSON.parse 를 지나는 것을 피한다).
 *
 * 상한은 셸이 한 번, 여기서 한 번 더 건다(셸과 페이지는 서로 다른 버전일 수 있다). 상한을 넘은 것은 조용히
 * 버리지 않고 `skipped` 로 세어 사용자에게 알린다.
 */
import type { NativeReply } from "../lib/nativeBridge";
import { ATTACHMENT_MAX_BYTES } from "./mobileApi";

/** 서버 첨부 상한(25MB)과 같다 — mobileApi.ATTACHMENT_MAX_BYTES 를 재사용한다. */
export const IMPORT_MAX_FILE_BYTES = ATTACHMENT_MAX_BYTES;
/** 한 번 가져오기의 이미지 총량·개수 상한. 셸 ShellImport.kt 의 MAX_TOTAL_BYTES·MAX_FILES 와 같은 값. */
export const IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const IMPORT_MAX_FILES = 20;
/** 텍스트 상한(문자). 이걸 넘는 텍스트는 자르지 않고 통째로 거절한다(잘린 본문이 저장되는 것보다 낫다). */
export const IMPORT_MAX_TEXT_CHARS = 1_000_000;
/** 셸 응답 항목 수 방어선(셸이 20개로 자르지만 오래된/다른 셸을 믿지 않는다). */
const MAX_PARSED_ITEMS = 200;
const TITLE_MAX_CHARS = 120;
const NAME_MAX_CHARS = 120;

/** 셸이 이미지 바이트를 내주는 same-origin 경로(ShellImport.ROUTE_PREFIX 와 같다). */
export const IMPORT_FILE_ROUTE = "/__shell/import";

export type ImportItemError = "too_large" | "unsupported" | "read_failed" | "too_many";
const ITEM_ERRORS: ImportItemError[] = ["too_large", "unsupported", "read_failed", "too_many"];

export interface ImportItem {
  idx: number;
  name: string;
  mime: string;
  size: number;
  error?: ImportItemError;
}

export interface ShellImportBatch {
  importId: string;
  text: string;
  subject: string;
  /** 텍스트를 읽지 못했거나 상한을 넘어 버려졌다. */
  textError: boolean;
  items: ImportItem[];
  /** 항목 목록에 담기지도 못하고 버려진 개수(셸의 개수 상한 초과분). */
  omitted: number;
}

export interface ImportFile {
  idx: number;
  /** 업로드에 쓸 파일명(확장자 보정됨). */
  name: string;
  mime: string;
  size: number;
  /** 셸이 바이트를 내주는 same-origin 경로. */
  url: string;
}

export interface ImportPlan {
  importId: string;
  /** 초안 제목으로 쓸 제목(공유 주제). 없으면 null. */
  title: string | null;
  /** 초안 본문 원문(일반 텍스트). 본문 모양(마크다운) 변환은 mobileImportBody.ts. */
  text: string;
  files: ImportFile[];
  /** 가져오지 못한 것의 개수(상한 초과·지원 안 하는 형식·읽기 실패·텍스트 거절). */
  skipped: number;
  hasContent: boolean;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 셸 응답 → 배치. 가져올 것이 없거나(import 없음·구형 셸의 위치 응답) 모양이 틀리면 null. */
export function parseImportReply(reply: NativeReply): ShellImportBatch | null {
  if (!reply.ok) return null; // `unknown_type` 포함 — 가져오기를 모르는 구형 셸
  const raw = reply.import;
  if (!raw || typeof raw !== "object") return null; // 구형 LegacyBridge 는 어떤 요청에도 위치({ok,lat,lng})로 답한다
  const r = raw as Record<string, unknown>;
  const importId = str(r.importId);
  if (!SAFE_ID.test(importId)) return null;
  const items: ImportItem[] = [];
  if (Array.isArray(r.items)) {
    for (const it of r.items.slice(0, MAX_PARSED_ITEMS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      if (typeof o.idx !== "number" || !Number.isInteger(o.idx) || o.idx < 0) continue;
      const error = ITEM_ERRORS.find((e) => e === o.error) ?? (o.error ? "unsupported" : undefined);
      items.push({
        idx: o.idx,
        name: str(o.name),
        mime: str(o.mime),
        size: typeof o.size === "number" && Number.isFinite(o.size) ? o.size : 0,
        ...(error ? { error } : {}),
      });
    }
  }
  const text = str(r.text);
  const overLong = Array.isArray(r.items) && r.items.length > MAX_PARSED_ITEMS ? r.items.length - MAX_PARSED_ITEMS : 0;
  return {
    importId,
    text,
    subject: str(r.subject),
    textError: r.textError === true || text.length > IMPORT_MAX_TEXT_CHARS,
    items,
    omitted: Math.max(0, Math.floor(Number(r.omitted) || 0)) + overLong,
  };
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * 업로드 파일명 — 경로 구분자·제어문자를 걷고 길이를 줄이되 확장자는 지킨다. 서버는 확장자로 종류(이미지)를 정하므로
 * 확장자가 없으면 MIME 에서 붙인다. 비면 `imported-<idx>`(용어 규칙: share 금지).
 */
export function sanitizeImportName(name: string, mime: string, idx: number): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  const dot = n.lastIndexOf(".");
  let ext = dot > 0 && dot < n.length - 1 ? n.slice(dot + 1) : "";
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext)) ext = "";
  let base = ext ? n.slice(0, dot) : n;
  if (!ext) ext = MIME_EXT[mime.toLowerCase()] ?? "";
  base = base.slice(0, NAME_MAX_CHARS).trim() || `imported-${idx}`;
  n = ext ? `${base}.${ext}` : base;
  return n;
}

/** 제목: 공백·줄바꿈을 한 칸으로, 길이 제한. 본문과 같으면(앱이 주제에 본문을 되풀이하는 경우) 제목으로 쓰지 않는다. */
function titleFrom(subject: string, text: string): string | null {
  const t = subject.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
  if (!t) return null;
  if (text.replace(/\s+/g, " ").trim() === t) return null;
  return t;
}

/**
 * 셸이 준 배치 → 입력 화면 초안 계획. 이미지는 항목별 오류·종류·크기 상한(개별 25MB, 총 100MB, 20장)을 거르고,
 * 걸러진 것은 `skipped` 로 센다. 텍스트가 상한을 넘었으면 통째로 버리고 `skipped` 에 센다.
 */
export function buildImportPlan(batch: ShellImportBatch): ImportPlan {
  const files: ImportFile[] = [];
  let skipped = batch.omitted + (batch.textError ? 1 : 0);
  let total = 0;
  for (const it of batch.items) {
    const isImage = it.mime.toLowerCase().startsWith("image/");
    if (it.error || !isImage || it.size > IMPORT_MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    if (files.length >= IMPORT_MAX_FILES || total + it.size > IMPORT_MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    total += it.size;
    files.push({
      idx: it.idx,
      name: sanitizeImportName(it.name, it.mime, it.idx),
      mime: it.mime,
      size: it.size,
      url: `${IMPORT_FILE_ROUTE}/${batch.importId}/${it.idx}`,
    });
  }
  const text = batch.textError ? "" : batch.text;
  const title = titleFrom(batch.subject, text);
  return {
    importId: batch.importId,
    title,
    text,
    files,
    skipped,
    hasContent: !!(text.trim() || title || files.length),
  };
}
