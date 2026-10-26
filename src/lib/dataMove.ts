import { create } from "zustand";
import { flushAll, call } from "./invoke";

/**
 * 데이터 이동의 단일 관문(오너 규칙: 유사 기능은 같은 경로) — 온보딩 요약 화면의
 * "내 노트 시작하기"와 설정 > 일반 "위치 변경" 둘 다 이 함수 하나로 들어온다. **MAIN 창에서만**
 * 실행된다(설정은 별도 OS 창이라 App.tsx 의 리스너에게 요청만 보낸다, GeneralSection.tsx 참고).
 *
 * 계약(병렬 Rust 작업): data_location_apply 는 성공하면 **Rust 가 앱 자체를 재시작**한다 —
 * 이 프라미스는 그 전까지 resolve 하지 않는다. 실패하면 reject(call() 이 이미 토스트했다) —
 * moving 플래그만 내리고 다시 던져 호출자가 반응하게 한다.
 */
interface DataMoveState {
  moving: boolean;
}

export const useDataMoveStore = create<DataMoveState>(() => ({ moving: false }));

export async function runDataMove(path: string): Promise<void> {
  // 이미 옮기는 중이면 무시 — 인앱 설정(같은 창)에서는 요청이 window·Tauri 두 채널로 함께 도착한다.
  // 플래그를 flushAll 보다 **먼저** 세워야 두 호출이 동시에 flush 단계에 들어가는 틈이 없다.
  if (useDataMoveStore.getState().moving) return;
  useDataMoveStore.setState({ moving: true });
  try {
    // 대기 중인 에디터 저장을 먼저 끝낸다 — 그 뒤에야 복사할 데이터가 확정된다.
    await flushAll();
    await call("data_location_apply", { path });
    // 성공 — Rust 가 프로세스를 재시작한다. 여기서 moving 을 내리지 않는다(재시작이 대신 끝낸다).
  } catch (e) {
    useDataMoveStore.setState({ moving: false });
    throw e;
  }
}
