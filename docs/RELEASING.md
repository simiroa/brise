# Releasing — 릴리스 빌드·자동 업데이트

> 한 줄 요약: 릴리스 빌드는 `~/.tauri/brise_updater.key`(저장소 밖)로 업데이트 아티팩트에
> 서명한다. 이 키를 잃어버리면 기존 사용자에게 자동 업데이트를 더 보낼 수 없고(재설치를
> 유도해야 함), 유출되면 그 키로 서명된 가짜 업데이트를 배포당할 수 있다.

## 1. 기능 개요

`tauri-plugin-updater`(Rust) + `@tauri-apps/plugin-updater`(JS)로 배선된 자동 업데이트다.
흐름: 앱 부팅 15초 뒤(또는 설정 > 일반의 "업데이트 확인" 버튼) `src/lib/updater.ts`가
`plugins.updater.endpoints`(아래 `tauri.conf.json`)의 `latest.json`을 확인 → 새 버전이 있으면
`ask()` 확인창 → 수락 시 서명된 아티팩트를 내려받아 설치 후 재시작(`@tauri-apps/plugin-process`
의 `relaunch()`). 서명 검증은 `tauri.conf.json`의 `plugins.updater.pubkey`(공개키)가 맡는다 —
개인키로 서명되지 않은 아티팩트는 설치 전에 거부된다.

## 2. 서명 키

| | 경로 |
|---|---|
| 개인키 | `~/.tauri/brise_updater.key` (이 저장소 밖) |
| 공개키 | `~/.tauri/brise_updater.key.pub` — 내용이 그대로 `tauri.conf.json`의 `plugins.updater.pubkey`에 박혀 있다 |

생성 명령(이미 1회 실행됨, 재생성 금지 — 재생성하면 기존 사용자가 검증하는 공개키와 어긋나
자동 업데이트가 전부 끊긴다):

```bash
npx tauri signer generate -w "$HOME/.tauri/brise_updater.key" --password "" --ci
```

**규칙**:
- 개인키는 **절대 저장소 안에 두지 않는다**(git에 커밋되는 순간 폐기해야 하는 키가 된다).
  이 프로젝트는 `~/.tauri/`(홈 디렉터리)에 생성했고, 새로 생성하는 어떤 스크립트/CI도 저장소
  트리 안에 키를 쓰지 않아야 한다.
- **백업 필수**: 개인키(와 비밀번호를 걸었다면 그 비밀번호)를 안전한 곳(비밀번호 관리자 등)에
  최소 1부 백업한다. 잃어버리면 이후 릴리스를 기존 설치본이 신뢰하는 키로 서명할 수 없다 —
  자동 업데이트 체인이 그 시점에서 끊기고, 사용자는 새 키로 서명된 설치본을 수동으로 다시
  받아야 한다.
- **유출 금지**: 개인키가 유출되면 공격자가 임의 실행 파일을 "진짜 Brise 업데이트"로 서명해
  기존 사용자에게 배포할 수 있다(원격 코드 실행급 사고). 유출 의심 시 즉시 새 키를 생성하고
  `tauri.conf.json`의 `pubkey`를 교체한 뒤, 이전 키로 서명된 릴리스를 신뢰할 수 없다고
  공지해야 한다.
- 이 프로젝트는 키에 빈 비밀번호(`--password ""`)를 썼다 — 파일 자체의 접근 제어(홈 디렉터리
  권한)에 의존한다는 뜻. 더 강한 보장이 필요하면 비밀번호를 걸고
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`로 빌드 시 주입하면 된다(아래).

## 3. 릴리스 빌드 시 서명

`tauri build`(또는 `npm run tauri build`)가 번들링 단계에서 아래 환경 변수를 읽어 자동으로
서명한다 — 커맨드 인자로 키를 넘기지 않는다:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/brise_updater.key")"
# 또는 파일 경로만 넘겨도 된다:
# export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/brise_updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # 이 키는 빈 비밀번호로 생성했다
npm run build && npx tauri build
```

CI(GitHub Actions 등)에서는 위 두 값을 저장소 Secrets(`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)로 등록해 워크플로 환경 변수로 주입하는 것이 표준이다.

## 4. `createUpdaterArtifacts`가 만드는 산출물

`src-tauri/tauri.conf.json`의 `bundle.createUpdaterArtifacts: true`는 일반 설치 파일(Windows
NSIS/MSI 등)과 별개로 **업데이트 전용 아티팩트 + 그 서명(`.sig`)** 을 함께 만든다
(`src-tauri/target/release/bundle/` 아래, 플랫폼별 하위 폴더). `.sig` 파일은 minisign
서명(base64 텍스트) — 개인키로 만들어지고, 클라이언트가 `pubkey`로 검증한다.

이 `.sig`+아티팩트만으로는 앱이 자동으로 새 버전을 찾지 못한다 — `plugins.updater.endpoints`가
가리키는 위치에 아래 형식의 **`latest.json`** 매니페스트를 올려야 한다:

```json
{
  "version": "v0.6.0",
  "notes": "이번 릴리스 요약",
  "pub_date": "2026-08-29T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<빌드가 만든 .sig 파일 내용>",
      "url": "https://github.com/simiroa/brise/releases/download/v0.6.0/brise_0.6.0_x64-setup.nsis.zip"
    }
  }
}
```

`platforms`의 키는 타깃 트리플 기반 식별자(예: `windows-x86_64`, `darwin-aarch64`,
`linux-x86_64`)이고, 여러 OS를 지원할수록 이 매니페스트는 여러 플랫폼 빌드의 결과물을
한곳에 모아야 한다 — 단일 `tauri build` 실행은 그 OS 하나의 아티팩트/서명만 만든다. Windows
단일 플랫폼이라면 위 파일을 릴리스 산출물과 함께 수동으로 조립해 올려도 되지만, 플랫폼이
늘어나면 공식 GitHub Action [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action)
이 매트릭스 빌드 후 `latest.json` 조립·릴리스 업로드까지 자동화해준다 — 이 프로젝트는 아직
그 CI를 구성하지 않았다(§5).

## 5. 엔드포인트는 현재 자리표시자

```json
"endpoints": ["https://github.com/simiroa/brise/releases/latest/download/latest.json"]
```

레포(`simiroa/brise`)가 **현재 private**이라 이 URL은 인증 없이는 아무것도 반환하지 않는다 —
`check()` 호출은 항상 실패하고, `src/lib/updater.ts`가 그 실패를 조용히 삼켜 "error"로 되돌릴
뿐이다(수동 확인이면 설정 화면에 실패 문구가 뜨고, 자동 확인이면 완전 무음 — 의도된 동작).
실제로 자동 업데이트를 켜려면 둘 중 하나가 먼저 필요하다:

1. **레포를 public으로 전환**하고 이 GitHub Releases 엔드포인트를 그대로 쓴다(가장 단순).
2. **레포는 private으로 유지**하고, `latest.json`을 자체 도메인(또는 공개 오브젝트 스토리지)에
   올린 뒤 `endpoints`를 그 URL로 교체한다. 여러 URL을 배열에 나열하면 순서대로 폴백된다.

어느 쪽이든 `tauri.conf.json`의 `endpoints` 배열을 갱신하고 재빌드해야 한다 — 이 값은
바이너리에 컴파일되므로(CLAUDE.md 함정 §7과 같은 이유) 기존 설치본은 재시작만으로는 새
엔드포인트를 알 수 없다(그 설치본이 스스로를 업데이트해야 새 엔드포인트를 갖게 된다 — 최초
전환 시점에는 기존 사용자에게 별도 공지/수동 배포가 필요할 수 있다).

## 6. 핵심 코드 경로

| 관심사 | 파일 |
|---|---|
| 확인/설치 로직, 세션당 1회·동시 실행 가드 | `src/lib/updater.ts` |
| 설정 화면 배선(수동 확인 버튼 + 자동 확인 토글) | `src/components/settings/SettingsNavFooter.tsx` |
| 부팅 15초 후 무음 자동 확인 | `src/App.tsx` |
| endpoints·pubkey·설치 모드 | `src-tauri/tauri.conf.json` (`plugins.updater`) |
| `createUpdaterArtifacts` 플래그 | `src-tauri/tauri.conf.json` (`bundle`) |
| Rust 플러그인 등록 | `src-tauri/src/lib.rs` |
| capability(check/download/install/relaunch 허용) | `src-tauri/capabilities/default.json` |

## 7. 서드파티 고지문 (THIRD-PARTY-NOTICES)

유료 판매 전제 — MIT/BSD/Apache/OFL/MPL 의존성은 전부 "저작권 고지 + 라이선스 전문 동봉"을
요구한다. `scripts/gen-notices.mjs`가 npm(`license-checker`, production만) + Rust(`cargo
metadata`, src-tauri) 의존성 전부를 훑어 `src-tauri/resources/THIRD-PARTY-NOTICES.html`을
만든다. 동일 라이선스 전문(정규화 후 해시)은 한 번만 수록하고 그 사본을 쓰는 패키지 목록을
같이 나열한다 — 저작권자별로 텍스트가 다르면 자동으로 따로 수록된다(고지 보존).

```bash
npm run gen:notices
```

**언제 다시 돌려야 하나** — npm/Rust 의존성을 추가·제거·업그레이드할 때마다. 산출물은
빌드 재현성 때문에 **커밋 대상**이다(런타임에 생성하지 않는다). 재실행 후
`src-tauri/resources/THIRD-PARTY-NOTICES.html`의 diff를 리뷰하고 함께 커밋한다.

동봉 경로:
- **설치본**: `tauri.conf.json`의 `bundle.resources`가 이 파일을 리소스 디렉터리에 그대로
  복사한다. 설정 > 일반의 "오픈소스 라이선스" 버튼이 `resolveResource()`로 실제 경로를 얻어
  `plugin-opener`의 `openPath()`로 기본 브라우저에 연다(capability:
  `opener:allow-open-path`, scope `$RESOURCE/**` — `opener:default`엔 `open_path`가 없다).
- **저장소**: `docs/RELEASING.md`(이 문서)와 스크립트 자체가 SSOT.

cargo metadata·license-checker로 자동 스캔되지 않는 항목(지도/지오코딩/날씨 외부 서비스,
meteocons 아이콘, Fluent UI Emoji, yt-dlp, SQLite)은 스크립트 안에 정적 목록으로 박혀 있다 —
새 외부 서비스/번들 자산을 추가하면 `scripts/gen-notices.mjs`의 `collectStatic()`에도 추가할 것.

## 8. 알려진 한계 / 결정

- **CI 미구성** — 서명 빌드는 현재 수동(§3). 릴리스 빈도가 늘면 `tauri-apps/tauri-action`
  도입을 검토한다.
- **엔드포인트는 자리표시자** — §5의 결정(public 전환 또는 자체 latest.json) 전까지 자동
  업데이트는 항상 "error"로 조용히 실패한다. 유료 판매 전 반드시 해결해야 하는 항목이다.
- **dev 빌드도 실제 네트워크 요청을 보낸다** — `tauri.dev.conf.json`은 `identifier`만
  덮어쓰고 `plugins.updater`는 그대로 병합되므로, `npm run tauri:dev` 중에도 15초 뒤 실제
  엔드포인트로 확인 요청이 나간다. 실패는 무음이라 개발 중 눈에 띄는 부작용은 없다.

## 9. 릴리스 전 성능 기준선 (`docs/PLAN-2026-10-23-perf-baselines.md`)

태그 전에 이 PC 에서 시간 지표를 돌려 기준선과 비교하고, 결과를 이력에 한 줄 남긴다. 앱(`brise.exe`)을 끄고,
다른 빌드·테스트를 돌리지 않은 상태에서.

```bash
npm run bench -- --record
```
```bash
npm run bench:app -- --record
```

- REGRESSED 가 나오면 먼저 같은 명령을 한 번 더(잡음 확인). 그래도면 원인 커밋을 찾거나, 의도한 비용이면
  `--update --reason "<이유>"` 로 기준선을 옮기고 그 이유를 커밋 메시지에 적는다(계획서 §6).
- `--record` 는 `scripts/bench/history/<machine-id>.jsonl` 에 한 줄을 더한다 — 릴리스 커밋에 같이 넣는다.
- 부팅 번들 크기(`npm run check:bundle`)는 CI 가 커밋마다 본다.
