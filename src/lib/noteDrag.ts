// 앱 내부 노트 드래그 — 포인터 이벤트 기반.
//
// HTML5 DnD 를 쓰지 않는 이유: tauri.conf.json 의 창 설정 dragDropEnabled 가 기본값 true 라
// WebView2 의 드래그를 Tauri 가 OS 레벨에서 가로채고, 그러면 웹뷰 안에서는 dragover/drop 이
// 아예 발생하지 않는다. 이 설정을 끄면 앱 내부 드래그는 살아나지만 첨부 기능이 쓰는
// getCurrentWebview().onDragDropEvent (탐색기에서 파일을 끌어다 놓기) 가 죽는다 — 파일 경로를
// 받을 수 없게 되기 때문. 둘 중 하나를 포기하는 대신 우리 쪽 드래그만 포인터 이벤트로 구현해
// 그 설정과 무관하게 만든다.
//
// 구조: 드래그 소스(행)는 startNoteDrag 만 호출하고 훅을 쓰지 않는다 — 행 컴포넌트는
// react-window 가 인덱스마다 재사용하므로 분기 안에서 훅을 부르면 렌더 간 훅 개수가 달라져
// React 가 터진다. 드롭 대상은 DOM 속성(data-note-drop-target="<prefix>:<id>")으로만 표시하고,
// 실제 처리는 안정적인 컨테이너가 registerNoteDropHandler 로 한 번 등록한다.

// "누름이 드래그가 되는" 임계값의 출처는 lib/pointerContract.ts 다(W7-2 통합) — 이 값이
// 여기서 처음 정의돼 ReorderList·useListReorder·widgetDrag·attachmentImageDrag 로 퍼졌고,
// 이제 전부 그쪽에서 import 한다.
import { DETACH_DWELL_MS, DETACH_EDGE_PX, DRAG_THRESHOLD_PX } from "./pointerContract";

const TARGET_ATTR = "data-note-drop-target";

/**
 * 드래그가 이미지 정체를 들고 갈 때의 추가 짐. 갤러리 타일처럼 "노트에 속한 이미지"를 끌면
 * 노트 id 는 그대로 두고 이 필드가 함께 실린다 — 드롭 대상이 이미지로 받을 수 있으면
 * 이미지로, 아니면 노트로 떨어진다.
 *
 * sourceId 는 **원본 첨부의 rel 경로**다(썸네일이 아니다). 공간 이미지 아이템의 source_id 와
 * 같은 규약이라(`{rel}.thumb.jpg` = repo::attachments::thumb_rel_for) 그대로 넣으면 되고,
 * 파일을 다시 복사하지 않는다.
 */
export interface NoteDragImage {
  sourceId: string;
  title?: string;
}

/**
 * 드래그가 섹션 정체를 들고 갈 때의 추가 짐. 섹션 탭을 끌면 노트 id 는 그대로 두고(= 그 섹션이
 * 지금 속한 노트) 이 필드가 함께 실린다. 받는 쪽은 `section:` 대상이면 같은 노트 안 재정렬,
 * `note:` 대상이면 다른 노트로 이동(W3), `preview:` 대상이면 미리보기 카드에 고정이다.
 */
export interface NoteDragSection {
  id: string;
  noteId: string;
}

export type NoteDropHandler = (
  noteId: string,
  targetId: string,
  clientX: number,
  clientY: number,
  image?: NoteDragImage,
  section?: NoteDragSection,
) => void;

const handlers = new Set<NoteDropHandler>();

/** 컨테이너가 마운트 시 1회 등록. 반환된 함수로 해제한다. */
export function registerNoteDropHandler(h: NoteDropHandler): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

/** 드롭 대상 DOM 에 그대로 펼쳐 넣는 속성. prefix 로 어떤 종류의 대상인지 구분한다. */
export function noteDropTargetProps(targetId: string): Record<string, string> {
  return { [TARGET_ATTR]: targetId };
}

function findTargetAt(
  clientX: number,
  clientY: number,
  kind: "note" | "image" | "section",
): HTMLElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const target = (el as HTMLElement).closest(`[${TARGET_ATTR}]`) as HTMLElement | null;
  if (!target) return null;
  const targetId = target.getAttribute(TARGET_ATTR) ?? "";
  // 섹션은 섹션 탭(재정렬)·노트 행(다른 노트로 이동)·미리보기 카드(고정)만 받는다 —
  // 폴더·칸반·지도 위에 놓으면 아무 일도 일어나지 않아야 한다. 반대로 섹션 탭은 섹션 드래그만
  // 받는다(노트를 탭 위로 끌었을 때 엉뚱한 탭에 하이라이트가 들어오지 않게).
  if (kind === "section") {
    return targetId.startsWith("section:") || targetId.startsWith("note:") ||
      targetId.startsWith("preview:")
      ? target
      : null;
  }
  // 반대 방향도 막는다: `note:`/`preview:` 대상(트리 노트 행, 미리보기 카드)은 섹션만 받는다 —
  // 노트를 그 위로 끌면 핸들러가 무시하는데 하이라이트만 들어와 "여기 놓을 수 있다"고
  // 거짓말하던 자리.
  if (targetId.startsWith("section:") || targetId.startsWith("note:") || targetId.startsWith("preview:")) return null;
  if (!targetId.startsWith("widget:")) return target;
  const accepts = target.closest<HTMLElement>("[data-composition-accepts]")?.dataset.compositionAccepts
    ?.split(",") ?? [];
  // 이미지를 끌고 있으면 이미지를 받는 위젯만 대상이다. 여기서 note 로 폴백하면 오너가 본
  // "이미지를 끌었는데 노트 링크가 꽂힌다"가 그대로 돌아온다.
  return accepts.includes(kind) ? target : null;
}

function clearHover(): void {
  document.querySelectorAll(".note-drop-over").forEach((el) => el.classList.remove("note-drop-over"));
}

/** 커서를 따라다니는 고스트. pin 이면 "여기에 꽂는다"는 의미가 커서에서 읽히도록 핀 아이콘을 붙인다. */
function makeGhost(label: string, pin: boolean): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "overlay note-drag-ghost";
  ghost.style.cssText = [
    "position:fixed",
    "z-index:var(--z-drag)",
    "pointer-events:none",
    "display:flex",
    "align-items:center",
    "gap:6px",
    "padding:4px 10px",
    "max-width:220px",
    "font-family:var(--font-body)",
    "font-size:var(--text-xs)",
    "color:var(--text)",
    "white-space:nowrap",
    "overflow:hidden",
    "box-shadow:var(--shadow-lg)",
  ].join(";");
  if (pin) {
    ghost.innerHTML =
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" ` +
      `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>` +
      `<circle cx="12" cy="10" r="3"/></svg>`;
  }
  const text = document.createElement("span");
  text.textContent = label;
  text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
  ghost.appendChild(text);
  return ghost;
}

/**
 * "창 밖" 판정(섹션 탭 끌어내 분리, 2단계). 뷰포트 밖이거나 가장자리 `edge` px 이내면 밖이다 —
 * 최대화된 단일 모니터에서는 커서가 창 밖으로 나갈 수 없어서 가장자리 체류를 밖으로 인정한다.
 * 가장자리에 붙은 드롭 대상(사이드바 트리 행 등)과 겹치지 않게 하는 우선순위는 호출자가 건다
 * (드롭 대상이 잡히면 밖이 아니다).
 */
export function isOutsideViewport(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
  edge: number = DETACH_EDGE_PX,
): boolean {
  return clientX <= edge || clientY <= edge || clientX >= width - edge || clientY >= height - edge;
}

export interface NoteDragOpts {
  pin?: boolean;
  image?: NoteDragImage;
  section?: NoteDragSection;
  /**
   * 창 밖에 DETACH_DWELL_MS 머문 뒤 놓으면 드롭 핸들러 대신 이것을 부른다(좌표 = PointerEvent 의
   * screenX/Y, CSS 논리 px). 섹션 탭만 건다 — 없으면 드래그 동작은 예전과 같다.
   */
  onOutsideDrop?: (screenX: number, screenY: number) => void;
  /** 무장 상태 고스트 문구("놓으면 새 창"). */
  outsideLabel?: string;
}

/**
 * 행의 onPointerDown 에서 호출. 임계값(4px)을 넘겨 실제로 움직였을 때만 드래그가 시작되므로
 * 단순 클릭(노트 열기)은 그대로 동작한다.
 */
export function startNoteDrag(
  e: React.PointerEvent,
  noteId: string,
  label: string,
  opts?: NoteDragOpts
): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const dragKind = opts?.section ? "section" : opts?.image ? "image" : "note";
  const onOutsideDrop = opts?.onOutsideDrop;
  let ghost: HTMLElement | null = null;
  // 창 밖 분리(onOutsideDrop 이 있을 때만 쓰인다). 창은 **놓는 순간**에만 만든다 — 누른 채 만들면
  // 새 창이 포커스를 가져가 진행 중인 포인터 드래그가 끊긴다.
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;

  const setArmed = (on: boolean) => {
    armed = on;
    if (!ghost) return;
    (ghost.lastElementChild as HTMLElement).textContent = on ? (opts?.outsideLabel ?? label) : label;
    ghost.style.color = on ? "var(--accent)" : "var(--text)";
    ghost.style.outline = on ? "1.5px solid var(--accent)" : "";
  };
  const disarm = () => {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
    if (armed) setArmed(false);
  };

  const onMove = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      ghost = makeGhost(label, opts?.pin ?? false);
      document.body.appendChild(ghost);
      document.body.style.cursor = "grabbing";
      // 드래그 중 텍스트 선택이 따라붙지 않도록.
      document.body.style.userSelect = "none";
    }
    // 핀 끝이 커서에 오도록 살짝 위로 띄운다.
    let left = ev.clientX + 8;
    let top = ev.clientY - ghost.offsetHeight - 4;
    if (onOutsideDrop) {
      // 가장자리·창 밖에서도 무장 문구가 보이도록 고스트를 뷰포트 안에 붙잡아 둔다.
      left = Math.max(0, Math.min(left, window.innerWidth - ghost.offsetWidth));
      top = Math.max(0, Math.min(top, window.innerHeight - ghost.offsetHeight));
    }
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;

    clearHover();
    const target = findTargetAt(ev.clientX, ev.clientY, dragKind);
    if (target) target.classList.add("note-drop-over");

    if (onOutsideDrop) {
      const outside = !target && isOutsideViewport(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
      if (!outside) disarm();
      else if (!armed && armTimer === null) {
        armTimer = setTimeout(() => {
          armTimer = null;
          setArmed(true);
        }, DETACH_DWELL_MS);
      }
    }
  };

  // ev = null → 취소(드롭 없음). 창 blur·Escape 도 여기로 온다: 창 밖에서 놓아 pointerup 을 못 받거나
  // 포인터 캡처를 잃으면 리스너·무장 타이머·고스트가 남아 다음 움직임에 엉뚱한 드롭이 난다.
  const finish = (ev: PointerEvent | null) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
    window.removeEventListener("keydown", onKey, true);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    clearHover();
    const wasArmed = armed;
    disarm();
    if (!ghost) return; // 임계값을 못 넘겼다 = 그냥 클릭
    ghost.remove();
    ghost = null;
    if (!ev) return;
    if (wasArmed && onOutsideDrop) {
      onOutsideDrop(ev.screenX, ev.screenY);
      return;
    }
    const targetId = findTargetAt(ev.clientX, ev.clientY, dragKind)?.getAttribute(TARGET_ATTR);
    if (!targetId) return;
    for (const h of handlers) h(noteId, targetId, ev.clientX, ev.clientY, opts?.image, opts?.section);
  };
  const onUp = (ev: PointerEvent) => finish(ev);
  const onCancel = () => finish(null);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") finish(null);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onCancel);
  window.addEventListener("keydown", onKey, true);
}
