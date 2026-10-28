import { isBrowser } from "../../lib/env";
import { PastePolicyCard } from "./PastePolicyCard";
import { AttachmentStorageSection } from "./AttachmentStorageSection";
import { GalleryOptionsCard } from "./GalleryOptionsCard";

/**
 * 설정 > 첨부파일 (PLAN-2026-10-27 §1 신설). 첨부가 들어오고 머무는 길을 위에서 아래로 한 페이지에 모았다:
 *   1. 붙여넣기·드롭 정책 — 에디터 페이지에서 이사(원본 처리 + 붙여넣기 제안·변환 3종).
 *   2. 첨부 저장 방식·용량 — 데이터 관리 페이지에서 이사(AttachmentStorageSection).
 *   3. 갤러리 — 사이드패널 갤러리의 타일 크기·정렬·이름 표시(2026-10-28 신설, GalleryOptionsCard).
 * 브라우저(태블릿)에는 첨부 저장소 설정(로컬 경로·soffice)의 대응물이 없어 저장소 카드만 뺀다.
 */
export function AttachmentsSection() {
  return (
    <>
      <PastePolicyCard />
      {!isBrowser() && <AttachmentStorageSection />}
      <GalleryOptionsCard />
    </>
  );
}
