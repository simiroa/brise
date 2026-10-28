import { useSettingsStore } from "../stores/settings";

/**
 * 저장 대화상자의 `defaultPath` — 설정 › 일반 › 내보내기 기본 폴더(`export_default_dir`)가 있으면 그 폴더 안의 파일명으로,
 * 없으면 파일명만(대화상자 기본 위치). 내보내기 경로가 여러 곳(노트 · 섹션 · 모달 · 시트 CSV · 다이어그램 PNG · 전체 백업)이라
 * 이 한 함수를 지나게 한다. 폴더가 사라졌어도 대화상자는 알아서 가까운 곳으로 물러나므로 존재 검사는 하지 않는다.
 */
export function withExportDir(fileName: string): string {
  const dir = (useSettingsStore.getState().exportDefaultDir ?? "").trim();
  if (!dir) return fileName;
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${fileName}`;
}
