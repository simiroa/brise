import { describe, expect, it } from "vitest";
import { createPetBehavior } from "./petBehavior";

/** fake clock: t를 테스트가 직접 흐르게 한다 — createPetBehavior는 setTimeout을 쓰지 않는다. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

describe("createPetBehavior", () => {
  it("failed 활성 중 success가 와도 failed TTL 동안 유지된다", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    b.dispatch({ kind: "failure", at: 0 });
    expect(b.dispatch({ kind: "success", at: 1000 }).activity).toBe("failed");
    c.set(2000);
    expect(b.snapshot().activity).toBe("failed");
  });

  it("success 10연발은 전환 1개로 병합되고 history에 점프 10개가 쌓이지 않는다", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    for (let i = 0; i < 10; i++) {
      b.dispatch({ kind: "success", at: i * 100 });
    }
    expect(b.history()).toHaveLength(1);
    expect(b.history()[0]).toMatchObject({ activity: "succeeded", cause: "success" });
  });

  // 상한은 화면 저장의 비전 왕복(75s) + 감시 타이머(85s)보다 길어야 한다 — petBehavior.ts 주석.
  it("think-start 후 task-done 누락 시 90초 후 snapshot()이 resting으로 복귀한다", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    expect(b.dispatch({ kind: "think-start", at: 0 }).activity).toBe("thinking");
    c.set(86_000);
    // 감시 타이머(PetApp SHOT_TIMEOUT_MS = 85s)가 울릴 때까지는 thinking 이 살아 있어야 한다.
    expect(b.snapshot().activity).toBe("thinking");
    c.set(91_000);
    expect(b.snapshot().activity).toBe("resting");
  });

  it("우선순위: listening 중 attention은 덮지 못하고, attention 중 listen-start는 listening으로 전환한다", () => {
    const c1 = clock();
    const b1 = createPetBehavior(c1.now);
    b1.dispatch({ kind: "listen-start", at: 0 });
    expect(b1.dispatch({ kind: "attention", at: 1000 }).activity).toBe("listening");

    const c2 = clock();
    const b2 = createPetBehavior(c2.now);
    b2.dispatch({ kind: "attention", at: 0 });
    expect(b2.dispatch({ kind: "attention", at: 0 }).activity).toBe("needs-attention");
    expect(b2.dispatch({ kind: "listen-start", at: 1000 }).activity).toBe("listening");
  });

  it("지속 상태 해제 시 하위 활성 상태로 복귀한다 (listening+attention → listen-stop → needs-attention)", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    b.dispatch({ kind: "listen-start", at: 0 });
    b.dispatch({ kind: "attention", at: 1000 });
    const snap = b.dispatch({ kind: "listen-stop", at: 2000 });
    expect(snap.activity).toBe("needs-attention");
    expect(snap.animation).toBe("waiting");
  });

  it("전환 기록은 최근 32개로 제한된다", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    for (let i = 0; i < 20; i++) {
      const base = i * 10_000;
      b.dispatch({ kind: "think-start", at: base });
      b.dispatch({ kind: "task-done", at: base + 100 });
    }
    const h = b.history();
    expect(h).toHaveLength(32);
    expect(h[h.length - 1]).toMatchObject({ activity: "resting", cause: "task-done" });
  });

  it("burst 병합 경계: 지속 상태는 1500ms 안 재신호를 무시하고, 1500ms 밖 재신호는 상한을 늘린다", () => {
    const burst = clock();
    const bBurst = createPetBehavior(burst.now);
    bBurst.dispatch({ kind: "think-start", at: 0 });
    bBurst.dispatch({ kind: "think-start", at: 1499 }); // burst → 무시, 상한 그대로
    burst.set(90_001);
    expect(bBurst.snapshot().activity).toBe("resting");

    const fresh = clock();
    const bFresh = createPetBehavior(fresh.now);
    bFresh.dispatch({ kind: "think-start", at: 0 });
    bFresh.dispatch({ kind: "think-start", at: 1501 }); // burst 아님 → 상한 재시작(91501까지)
    fresh.set(90_001);
    expect(bFresh.snapshot().activity).toBe("thinking");
  });

  it("종료된 지속 상태는 burst 창 안이라도 재시작된다 (연속 클립 저장 2회)", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    b.dispatch({ kind: "think-start", at: 0 });
    b.dispatch({ kind: "task-done", at: 500 });
    expect(b.dispatch({ kind: "think-start", at: 1000 }).activity).toBe("thinking");
  });

  it("listening의 snapshot은 animation look, facing 90이다", () => {
    const c = clock();
    const b = createPetBehavior(c.now);
    const snap = b.dispatch({ kind: "listen-start", at: 0 });
    expect(snap).toMatchObject({ activity: "listening", animation: "look", facing: 90 });
    expect(b.snapshot()).toMatchObject({ activity: "listening", animation: "look", facing: 90 });
  });
});
