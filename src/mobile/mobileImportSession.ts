/**
 * 입력 화면 초안에 채워 둔 "가져온 내용"의 이미지 몫 — 아직 올리지 않은 파일 목록과 올리기/끝내기.
 *
 * 이미지는 노트가 있어야 올라간다(첨부는 노트 id 가 필요하다). 가져온 내용은 입력 화면을 떠날 때에야 노트가 되므로
 * (D1, 2026-10-10 — 그 전엔 [버리기]로 버릴 수 있다) **초안 단계에서는 올리지 않고** 셸에 둔 채 이 세션이 목록만 쥔다.
 * 노트가 만들어진 뒤(나가기, 또는 사용자가 글을 쳐서 자동 저장이 노트를 만든 뒤 나가기)에야 `uploadAll` 이 하나씩 올린다.
 *
 * 올리기는 이미 있는 폰 업로드 경로 `uploadAttachment`(서버가 EXIF 날짜·경유지 훅을 자동 적용)를 그대로 쓰고,
 * 성공하면 useMobileAttachUpload::runUpload 와 같은 방식으로 활성 노트의 첨부 목록에 낙관 반영한다.
 * 실패한 파일은 목록에 남아 다음 `uploadAll` 이 다시 올린다(다시 나가면 실패분만).
 */
import type { Attachment } from "../lib/commands.gen";
import { reportFallback } from "../lib/diag";
import { useNotesStore, isNoteBodyEmpty } from "../stores/notes";
import { uploadAttachment, AttachmentTooLargeError } from "./mobileApi";
import { ackImport, fetchImportFile } from "./mobileImportBridge";
import type { ImportFile } from "./mobileImport";

export interface ImportSessionDeps {
  fetchFile: (f: ImportFile) => Promise<File>;
  upload: (noteId: string, file: File) => Promise<Attachment>;
  ack: (importId: string) => Promise<void>;
  /** 올라간 첨부를 화면 상태에 반영한다 — 활성 노트일 때만(기본 구현 = 스토어 낙관 반영). */
  attached: (noteId: string, attachment: Attachment) => void;
}

export interface UploadOutcome {
  uploaded: number;
  /** 아직 목록에 남아 다시 시도할 수 있는 실패(네트워크 등). */
  failed: number;
  /** 다시 시도해도 소용없어 목록에서 뺀 것(25MB 초과·셸에서 못 읽음). */
  dropped: number;
}

/** useMobileAttachUpload::runUpload 와 같은 낙관 반영 — 활성 노트가 그새 바뀌었으면 건드리지 않는다. */
export function attachToActiveNote(noteId: string, attachment: Attachment): void {
  const n = useNotesStore.getState().activeNote;
  if (n && n.note.id === noteId) {
    useNotesStore.setState({ activeNote: { ...n, attachments: [...n.attachments, attachment] } });
  }
}

/**
 * 입력 화면의 **초안**(아직 노트가 아닌 상태)에 제목·본문을 채운다. 스토어 API(applyPreset·setTitle·updateSectionBody)는
 * 비어 있지 않은 본문·제목이면 곧바로 노트를 만들어(ensureMaterialized) 쓸 수 없다 — 그건 "저장은 사용자가 한다"는 규칙
 * 위반이다. 그래서 초안 객체를 직접 고친다(useMobileAttachUpload 가 activeNote 를 setState 하는 것과 같은 방식).
 * 나중에 노트가 만들어질 때 ensureMaterialized 가 초안의 제목·본문을 그대로 옮긴다.
 *
 * @returns 초안이 아니면(이미 노트거나 열린 노트가 없다) false — 아무것도 바꾸지 않는다.
 */
export function fillCaptureDraft(bodyMd: string, title: string | null): boolean {
  const s = useNotesStore.getState();
  const n = s.activeNote;
  if (!n || !s.activeDraft) return false;
  const sections = n.sections.map((sec, i) => (i === 0 ? { ...sec, body_md: bodyMd } : sec));
  useNotesStore.setState({
    activeNote: { ...n, note: title ? { ...n.note, title } : n.note, sections },
    activeBodyEmpty: isNoteBodyEmpty(sections),
  });
  return true;
}

export const defaultImportSessionDeps: ImportSessionDeps = {
  fetchFile: fetchImportFile,
  upload: (noteId, file) => uploadAttachment(noteId, file),
  ack: ackImport,
  attached: attachToActiveNote,
};

export class ImportSession {
  private staged: ImportFile[];
  /** dropFiles 가 불린 횟수 — 올리는 도중 "사진 빼기"가 눌렸는지 알아본다. */
  private dropEpoch = 0;
  private acked = false;
  private uploading: Promise<UploadOutcome> | null = null;

  constructor(
    readonly importId: string,
    files: ImportFile[],
    private readonly deps: ImportSessionDeps = defaultImportSessionDeps,
    /** 파일 하나를 마칠 때마다(올렸거나 버렸다) 남은 목록을 알린다 — 내구 기록(mobileImportLedger)이 줄어든 목록을 쥐게. */
    private readonly onProgress?: (remaining: ImportFile[]) => void,
  ) {
    this.staged = [...files];
  }

  /** 아직 올리지 않은 이미지 수. */
  get pending(): number {
    return this.staged.length;
  }

  /** 아직 올리지 않은 이미지 목록(복사본). */
  get files(): ImportFile[] {
    return [...this.staged];
  }

  /** 사용자가 "사진 빼기"를 눌렀다 — 올리지 않는다(셸의 파일은 끝낼 때 같이 지워진다). */
  dropFiles(): void {
    this.staged = [];
    this.dropEpoch++;
  }

  /**
   * 목록의 이미지를 순서대로 올린다(한 줄 — 폰 업링크가 병목이라 동시에 올리지 않는다). 던지지 않는다.
   * 동시에 두 번 불리면 같은 호출을 공유한다(나가기 연타가 같은 파일을 두 번 올리지 않게).
   */
  uploadAll(noteId: string): Promise<UploadOutcome> {
    if (!this.uploading) {
      this.uploading = this.run(noteId).finally(() => {
        this.uploading = null;
      });
    }
    return this.uploading;
  }

  private async run(noteId: string): Promise<UploadOutcome> {
    const out: UploadOutcome = { uploaded: 0, failed: 0, dropped: 0 };
    const epoch = this.dropEpoch;
    const todo = this.staged;
    const left: ImportFile[] = [];
    for (const [i, f] of todo.entries()) {
      try {
        const file = await this.deps.fetchFile(f);
        const attachment = await this.deps.upload(noteId, file);
        this.deps.attached(noteId, attachment);
        out.uploaded++;
      } catch (e) {
        // 25MB 초과는 다시 해도 같다. 셸에서 못 읽은 것(HTTP 404 = 이미 ack 됐거나 파일이 사라짐)도 마찬가지.
        const permanent = e instanceof AttachmentTooLargeError || (e instanceof Error && /^HTTP 4(04|10)$/.test(e.message));
        reportFallback("mobile-import", permanent ? "upload_dropped" : "upload_failed", e instanceof Error ? e.message.slice(0, 40) : "error");
        if (permanent) out.dropped++;
        else {
          out.failed++;
          left.push(f);
        }
      }
      // 이 파일까지 마친 시점의 남은 목록 — 도중에 앱이 죽어도 올린 사진을 다시 올리지 않게. "사진 빼기"가 끼었으면 알리지 않는다.
      if (epoch === this.dropEpoch) this.onProgress?.([...left, ...todo.slice(i + 1)]);
    }
    // 올리는 사이 사용자가 "사진 빼기"를 눌렀다면 실패분도 목록에 되살리지 않는다.
    this.staged = epoch === this.dropEpoch ? left : [];
    return out;
  }

  /** 이 가져오기를 끝낸다(저장됐거나 버렸다) — 셸에 알려 임시 파일을 지우게 한다. 한 번만. */
  async finish(): Promise<void> {
    if (this.acked) return;
    this.acked = true;
    await this.deps.ack(this.importId);
  }
}
