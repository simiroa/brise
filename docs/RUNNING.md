# 앱 실행 가이드 (RUNNING)

Brise는 **Tauri v2 데스크톱 앱**이다. vite 개발 서버는 프론트엔드 절반일 뿐이고,
실제 앱(Rust 백엔드 + WebView2 창)은 tauri CLI가 띄운다. 이 구분을 놓치면
"서버는 떴는데 앱이 안 뜨는" 상태가 된다 — 에이전트가 실제로 여러 번 반복한 실수라서
이 문서를 둔다.

## TL;DR

```bash
npm run tauri:dev
```

이 한 줄이 전부다. 내부적으로:
1. `beforeDevCommand`(= `npm run dev`)로 vite를 **5183 포트**에 띄우고,
2. `cargo build`(dev 프로필)를 돌린 뒤,
3. Brise 창(WebView2)을 띄워 `http://localhost:5183`을 로드한다.

vite를 따로 먼저 띄울 필요 없다. tauri가 알아서 띄우고, 종료 시 함께 정리한다.

## 하지 말 것 / 흔한 실패

| 증상 | 원인 | 해법 |
|---|---|---|
| "서버만 뜨고 앱이 안 뜸" | `npm run dev`만 실행함 — vite는 프론트 절반. 브라우저로 5183을 열어도 Tauri IPC(`invoke`)가 없어 데이터가 전부 실패한다 | `npm run tauri:dev` 사용 |
| 앱 창이 하얀 화면 | ① 5183에 **스테일 vite**가 이미 떠 있어 새 vite가 다른 포트로 밀렸는데 창은 5183을 로드 ② 큰 코드 웨이브 직후 HMR 모듈 그래프 꼬임 | ① 기존 node/vite 프로세스 종료 후 재실행 ② 앱 창에서 **Ctrl+R** (CLAUDE.md 함정 6) |
| 실행 직후 ~5초간 창이 안 보임 | 정상 — 창은 `visible: false`로 시작하고 프론트가 준비되면 `show()`를 부른다. 웹뷰가 죽어도 5초 후 failsafe가 강제로 창을 보여준다 | 기다리면 됨 |
| 창 관련 동작이 조용히 무반응 | capability(`core:window:allow-*`) 누락 — 권한은 **바이너리에 컴파일**되므로 HMR로 안 고쳐진다 | `capabilities/default.json` 수정 후 **재빌드**(tauri:dev 재시작), 떠 있는 창은 Alt+F4 (CLAUDE.md 함정 7) |
| `cargo test`(풀) 실패 | 앱 실행 중이면 exe 잠금 | `cargo test --lib`까지만 (커밋 게이트 규칙과 동일) |
| 첫 실행이 몇 분씩 걸림 | Rust 풀 빌드 — 이후는 증분 빌드라 수십 초 | 정상 |

## 개발 서버 서빙 검사 (`check:served`)

큰 변경 직후 vite 가 어떤 소스를 **빈 모듈로 캐시**해 서빙하는 일이 있다(실제 사례:
`src/briefing/view/style.ts` 가 빈 채 서빙). 증상은 브리핑/창이 **백지**, 콘솔에
`does not provide an export named ...`. 파일을 touch 하면 풀린다 — 그걸 자동화한 검사다.

```bash
npm run check:served              # 기본 http://localhost:5183
node scripts/check-served.mjs --url http://localhost:5184
node scripts/check-served.mjs --fix   # 빈 모듈 파일을 touch 해 vite 가 다시 읽게 한 뒤 재검사
```

- 서버가 안 떠 있으면 "서버 없음 — 건너뜀" 후 exit 0. 서버가 필요한 별도 검사라 `npm run check` 에는 없다.
- 로컬 소스에 런타임 export 가 있는데 서빙 본문이 비면 목록을 찍고 exit 1(타입 전용 파일은 제외).
- **큰 웨이브 뒤 `tauri:dev` 가 떠 있다면 한 번 돌리는 습관**을 들일 것 — Ctrl+R 로도 안 풀리는 백지의 흔한 원인이다.

## 백그라운드 실행 (에이전트용)

`tauri dev`는 포그라운드에서 계속 돌므로 **백그라운드로 실행**하고, 앱이 떴는지는
프로세스와 로그로 확인한다:

```bash
npm run tauri:dev
```

(에이전트라면 run_in_background로 실행할 것. 블로킹 셸에서 그냥 돌리면 타임아웃까지 멈춘다.)

확인 방법:
- 프로세스: PowerShell `Get-Process brise` (dev 빌드 exe 이름은 `brise`)
- 로그: tauri:dev 출력에 `Finished dev profile` 후 창이 뜬다. vite 출력(`Local: http://localhost:5183`)만 보이고 cargo 빌드 로그가 없으면 vite만 뜬 것이다.
- 이미 실행 중인데 또 실행하면 두 번째 인스턴스가 뜨거나 DB 잠금이 날 수 있다 — 먼저 `Get-Process brise`로 확인.

## dev와 release의 분리

`npm run tauri:dev`는 `src-tauri/tauri.dev.conf.json`을 오버레이해 identifier가
`com.brise.app.dev`가 된다 → **설치된 릴리즈 앱과 앱 데이터(DB·설정)가 분리**된다.
dev에서 뭘 해도 실제 사용 데이터는 안전하다. (`npm run tauri dev` — 콜론 없이 —
로 돌리면 릴리즈와 같은 identifier로 떠서 실데이터를 건드리니 **반드시 `tauri:dev`
스크립트를 쓸 것**.)

## 릴리즈 빌드

```bash
npm run tauri build
```

`beforeBuildCommand`(= `tsc && vite build`) 후 release 프로필로 번들(msi/exe)까지 만든다.
빌드 결과는 `src-tauri/target/release/`, 번들은 `src-tauri/target/release/bundle/`.

## 관련 문서

- 커밋 게이트·함정 목록: `.claude/CLAUDE.md`
- 브라우저 패널 미리보기(`.claude/launch.json`의 `dev` 항목)는 **vite 단독**이라
  IPC 없는 UI 확인용으로만 제한적으로 유효 — 기능 검증은 반드시 실제 앱으로.
