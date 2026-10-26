import { useEffect, useState } from "react";
import { listenMany } from "../../lib/tauriListen";
import { callSilent } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import type {
  PetAsset,
  PetAssetsListOutput,
  PetPackage,
  PetPackageAssetOutput,
  PetPackagesListOutput,
} from "../../lib/commands.gen";
import { usePrefersReducedMotion } from "../../lib/ui";
import { CodexPetAtlas, CODEX_PET_ATLAS, type CodexPetClip } from "./CodexPetAtlas";
import type { PetActivity, PetSnapshot } from "./petBehavior";
import "./pet.css";

/** gen 전 PetPackage 에 dialect/clips 가 없을 수 있다 — 있을 때만 읽는다. */
function packageDialect(meta: PetPackage): string | undefined {
  return "dialect" in meta ? (meta as { dialect?: string }).dialect : undefined;
}

function packageClips(meta: PetPackage): CodexPetClip[] | undefined {
  return "clips" in meta ? (meta as { clips?: CodexPetClip[] }).clips : undefined;
}

/** 레거시 에셋/SVG 폴백 전용 무드 — Codex 패키지 경로는 snapshot.animation 을 직접 쓴다. */
export type PetMood = "idle" | "happy" | "alert";

/** activity → 레거시 PetMood 어댑터. 폴백 경로 전용이라 레거시 슬롯(PetMood)을 더 늘리지 않는다. */
const LEGACY_MOOD: Record<PetActivity, PetMood> = {
  resting: "idle",
  greeting: "happy",
  succeeded: "happy",
  failed: "alert",
  "needs-attention": "alert",
  listening: "idle",
  thinking: "idle",
  working: "idle",
  moving: "idle",
};

export interface PetSpriteProps {
  snapshot: PetSnapshot;
}

const SIZE = 120;

/**
 * 펫 비주얼. 기본은 코드 SVG "동글이"(시안 A, 2026-08-04 오너 선택) — 자산 파일 0.
 * 설정 > 펫 > 에셋 관리에서 동작별 애니메이션을 등록하면 그 동작만 등록 이미지로 대체된다.
 * 등록이 없거나 파일이 사라지면 **자동으로 SVG 로 돌아온다**(무설정 기본값 유지, 크래시 없음).
 *
 * 데이터 URL 로 받는 이유: asset: 프로토콜 스코프를 새로 열지 않기 위해(파일당 2MB 상한이
 * repo::pet 에 있다). 한 창에서 한 번 읽고 끝이라 비용이 문제되지 않는다.
 */
export function PetSprite({ snapshot }: PetSpriteProps) {
  // 훅은 전부 조기 반환 위에(CLAUDE.md 함정 1) — 패키지가 늦게 도착하면 렌더 간 훅 수가 달라져
  // "Rendered fewer hooks" 크래시가 났다(펫 창 백지). 패키지 사용 중에도 usePetAsset 구독이
  // 하나 남는 비용은 무시 가능.
  const mood = LEGACY_MOOD[snapshot.activity];
  const packageState = usePetPackage();
  const legacyAsset = usePetAsset(mood);
  const reducedMotion = usePrefersReducedMotion();

  // 어떤 스프라이트를 그릴지 확정되기 전엔 아무것도 그리지 않는다(빈 화면) — 예전엔 여기서
  // 무조건 PetSvg를 먼저 그리고 패키지/에셋이 도착하면 교체했는데, 그 첫 프레임이 "예전 아바타"
  // 로 눈에 들어왔다(핸드오프 2026-08-10). packageState가 아직 pending이면 그게 뭐가 될지
  // 모르므로 legacyAsset도 같이 기다린다.
  if (packageState === "pending") return null;
  if (packageState !== "none") {
    const { meta, dataUrl } = packageState;
    const label = `${meta.display_name} (${snapshot.activity})`;
    // idle-image: 단일 GIF/APNG/WebP/PNG — 아틀라스 슬라이서가 한 셀만 잘라 보여주면 안 된다.
    if (packageDialect(meta) === "idle-image") {
      const height = (SIZE * CODEX_PET_ATLAS.cellHeight) / CODEX_PET_ATLAS.cellWidth;
      return (
        <img
          data-testid="pet-idle-image"
          className="pet-asset"
          src={dataUrl}
          width={SIZE}
          height={height}
          alt={label}
          draggable={false}
          style={{ objectFit: "contain", width: SIZE, height }}
        />
      );
    }
    return (
      <CodexPetAtlas
        dataUrl={dataUrl}
        state={snapshot.animation !== "look" ? snapshot.animation : undefined}
        facing={snapshot.animation === "look" ? snapshot.facing : undefined}
        reducedMotion={reducedMotion}
        label={label}
        rows={typeof meta.rows === "number" && meta.rows > 0 ? meta.rows : undefined}
        clips={packageClips(meta)}
      />
    );
  }
  if (legacyAsset === "pending") return null;
  if (legacyAsset) return <PetAssetSprite asset={legacyAsset} mood={mood} />;
  return <PetSvg mood={mood} />;
}

type PetPackageState = "pending" | "none" | { meta: PetPackage; dataUrl: string };

/** Codex v2 패키지가 있으면 선택된 프리셋을 우선한다. 기존 동작별 에셋은 마이그레이션 동안만
 *  폴백으로 남고, 패키지 1개가 설치되는 순간 실제 펫은 단일 8x11 아틀라스를 사용한다.
 *
 *  목록은 metadata만 싣는다(pet_packages_list) — 아틀라스(최대 8MiB)는 선택된 패키지 하나만
 *  pet_package_asset으로 따로 받는다. id를 생략하면 백엔드가 pet_selected_package 설정값을
 *  스스로 읽어 해석하므로(repo::pet::resolve_package_id), list 응답을 기다리지 않고 두 호출을
 *  동시에 쏠 수 있다 — 직렬 워터폴을 없애려고 새 커맨드를 추가하는 대신 이미 있는 이 fallback을
 *  쓴다. 선택이 빠르게 바뀌면(설정 화면에서 프리셋을 연달아 고르는 경우 등) 먼저 보낸 요청이
 *  나중에 도착할 수 있어, 매 load() 호출마다 순번 토큰을 찍어 최신 호출의 결과만 반영한다. */
function usePetPackage(): PetPackageState {
  const [state, setState] = useState<PetPackageState>("pending");
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const load = () => {
      const token = ++seq;
      void Promise.all([
        callSilent<PetPackagesListOutput>("pet_packages_list", {}),
        callSilent<PetPackageAssetOutput>("pet_package_asset", {}).catch(() => null),
      ])
        .then(([r, asset]) => {
          if (cancelled || token !== seq) return;
          // 선택값이 없으면 패키지를 쓰지 않는다(레거시 에셋/SVG 폴백) — 예전 `?? r.items[0]` 는
          // 선택한 적 없는 프리셋이 임의로 나타나는 원인이었다(핸드오프 2026-08-10 주의사항).
          const selected = r.items.find((item) => item.selected) ?? null;
          setState(selected && asset ? { meta: selected, dataUrl: asset.data_url } : "none");
        })
        .catch((e) => {
          if (!cancelled && token === seq) {
            // A(AUDIT-2026-09-26): 패키지 로딩 실패 → 레거시 에셋/SVG 폴백(무설정 기본값). 조용한
            // 것 자체는 의도된 동작이지만(펫이 절대 크래시하면 안 된다), 얼마나 자주 폴백으로
            // 떨어지는지는 지금까지 흔적이 없었다.
            reportFallback("pet", "sprite_package_failed", e instanceof Error ? e.message : String(e));
            setState("none");
          }
        });
    };
    load();
    const unlisten = listenMany([["pet-packages-changed", load]]);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
  return state;
}

/** 등록된 에셋 목록. 설정에서 바꾸면 pet-assets-changed 로 즉시 반영된다. */
function usePetAsset(mood: PetMood): PetAsset | null | "pending" {
  const [assets, setAssets] = useState<PetAsset[] | "pending">("pending");
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void callSilent<PetAssetsListOutput>("pet_assets_list", {})
        .then((r) => {
          if (!cancelled) setAssets(r.items ?? []);
        })
        .catch(() => {
          if (!cancelled) setAssets([]);
        });
    };
    load();
    // listenMany 가 listen() reject 를 삼킨다(.catch) — 테스트 환경(jsdom, Tauri IPC 없음)에서는
    // listen() 이 reject 한다. 예전엔 여기 없어서 무관한 테스트 파일(SettingsModal.test.tsx 등)
    // 에서 "Unhandled Rejection" 노이즈가 났다(테스트를 깨뜨리진 않지만 false positive 위험 경고).
    const unlisten = listenMany([["pet-assets-changed", load]]);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
  if (assets === "pending") return "pending";
  return assets.find((a) => a.mood === mood) ?? null;
}

/** 스프라이트 시트 한 바퀴 길이(ms) 기본값 — 에셋에 cycle_ms 가 없으면(구버전 등록) 이 값을 쓴다.
 *  settings > 펫에서 등록 시(200~5000ms) 조정 가능 — repo::pet::PET_ASSET_CYCLE_MS_DEFAULT 와 동일. */
export const SHEET_CYCLE_MS_DEFAULT = 900;

/** PNG 스프라이트 시트 재생. 실제 펫(PetAssetSprite, 아래)과 설정 화면의 등록 전 미리보기
 *  (PetSection.tsx)가 같은 CSS 로직을 공유한다 — 두 곳이 따로 구현하면 나중에 "미리보기랑 실제가
 *  다르게 논다"는 불일치가 생긴다. */
export function PetSheetSprite({
  dataUrl,
  frames,
  cycleMs,
  label,
  size = SIZE,
  className,
}: {
  dataUrl: string;
  frames: number;
  cycleMs: number;
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={`pet-asset pet-asset--sheet${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${dataUrl})`,
        backgroundSize: `${frames * 100}% 100%`,
        // animation 을 인라인 문자열로 넣는 이유: steps(var(--x)) 는 브라우저별 지원이 갈린다.
        animation: `pet-sheet ${cycleMs / 1000}s steps(${frames}) infinite`,
        // 키프레임이 -100% 까지 가면 마지막 프레임 하나를 못 보여준다 — 시트 전체 폭으로 민다.
        ["--pet-sheet-end" as string]: `-${frames * 100}%`,
      }}
    />
  );
}

function PetAssetSprite({ asset, mood }: { asset: PetAsset; mood: PetMood }) {
  // GIF/APNG/WebP 는 컨테이너가 타이밍을 갖고 있어 그냥 걸어두면 알아서 돈다.
  if (asset.kind !== "png" || !asset.frames) {
    return (
      <img
        className={`pet-asset pet--${mood}`}
        src={asset.data_url}
        width={SIZE}
        height={SIZE}
        alt={`펫 (${mood})`}
        draggable={false}
      />
    );
  }
  return (
    <PetSheetSprite
      dataUrl={asset.data_url}
      frames={asset.frames}
      cycleMs={asset.cycle_ms ?? SHEET_CYCLE_MS_DEFAULT}
      label={`펫 (${mood})`}
      className={`pet--${mood}`}
    />
  );
}

/** 기본 캐릭터(코드 SVG). 설정 > 펫 갤러리의 "기본 캐릭터" 타일도 이것을 그린다 — 타일이 다른
 *  아이콘을 그리면 고른 것과 펫 창에 뜨는 것이 달라 보인다(2026-10-16 디자인 보드). */
export function PetSvg({ mood, size = SIZE }: { mood: PetMood; size?: number }) {
  const eyeR = mood === "alert" ? 5.4 : 4.6;
  return (
    <svg
      className={`pet pet--${mood}`}
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label={`펫 (${mood})`}
    >
      <g className="pet-root">
        <ellipse className="pet-shadow" cx="60" cy="106" rx="22" ry="5" fill="rgba(0,0,0,.18)" />
        <g className="pet-body">
          <circle cx="60" cy="62" r="34" fill="#5b8def" />
          <circle cx="60" cy="62" r="34" fill="url(#petShine)" opacity=".35" />
          <ellipse cx="60" cy="74" rx="20" ry="14" fill="#f4f6fb" />
          <g className="pet-wing">
            <ellipse cx="34" cy="64" rx="10" ry="15" fill="#4a76d6" />
          </g>
          {mood === "happy" ? (
            // 기쁨: 감은 웃는 눈(^^) — 깜박임 없음
            <g>
              <path d="M45 55 q5 -7 10 0" stroke="#1c2230" strokeWidth="3.2" fill="none" strokeLinecap="round" />
              <path d="M66 55 q5 -7 10 0" stroke="#1c2230" strokeWidth="3.2" fill="none" strokeLinecap="round" />
            </g>
          ) : (
            <g>
              <g className="pet-eye pet-eye--l">
                <circle cx="50" cy="54" r={eyeR} fill="#1c2230" />
                <circle cx="51.6" cy="52.4" r="1.5" fill="#fff" />
              </g>
              <g className="pet-eye pet-eye--r">
                <circle cx="71" cy="54" r={eyeR} fill="#1c2230" />
                <circle cx="72.6" cy="52.4" r="1.5" fill="#fff" />
              </g>
            </g>
          )}
          <path d="M57 62 L64 62 L60.5 68 Z" fill="#f6b73c" />
          <path
            d="M46 96 l-3 7 M50 97 l0 7 M74 96 l3 7 M70 97 l0 7"
            stroke="#f6b73c"
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
          />
          <g className="pet-tuft">
            <path
              d="M43 36 q4 -9 10 -4 M60 30 q1 -10 8 -6"
              stroke="#4a76d6"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </g>
        </g>
      </g>
      <defs>
        <radialGradient id="petShine" cx=".35" cy=".25" r="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
