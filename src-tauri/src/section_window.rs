//! 섹션 분리 창(#/section) — 섹션 하나를 별도 OS 창으로 띄운다(1단계, 2026-09-30).
//!
//! 창 생성·포커스·왜 OS 창인지는 `aux_window.rs` 와 같다. 다른 점은 라벨이 섹션마다 다르다는 것
//! (`section-<sectionId>`) 하나뿐이다.
//!
//! **배타 소유**: 한 섹션은 항상 한 곳에서만 열린다. 분리 여부의 단일 진실은 "이 라벨의 창이
//! 존재하는가"다 — DB 나 설정에 아무것도 저장하지 않는다(앱이 비정상 종료돼도 다음 부팅에 꼬일
//! 상태가 없다). 프런트는 `section_window_list` 로 현재 집합을 읽고, `section-window-changed`
//! 이벤트(열림/닫힘)로 갱신한다. 닫힘은 창의 Destroyed 이벤트에서 낸다 — 어떤 경로로 닫혔든
//! (X·Alt+F4·본 창의 "되돌리기"·삭제로 인한 강제 파괴) 한 곳에서 한 번.

use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};

use crate::aux_window::{ensure_owned_window_placed, AuxWindowSpec};

/// capabilities/default.json 의 windows 에 `section-*` 글롭으로 등록돼 있다
/// (scripts/check-window-capabilities.mjs 가 `*_LABEL_PREFIX` 상수를 글롭과 대조한다).
pub const SECTION_LABEL_PREFIX: &str = "section-";

/// 열림/닫힘 통지 — payload `{ section_id, open }`. 프런트 `src/stores/sectionWindows.ts` 가 듣는다.
pub const SECTION_WINDOW_CHANGED_EVENT: &str = "section-window-changed";

/// id 는 라벨과 URL 쿼리로 그대로 나간다 — Tauri 라벨 허용 문자 중 uuid 가 쓰는 것만 통과시킨다.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn label_for(section_id: &str) -> Option<String> {
    valid_id(section_id).then(|| format!("{SECTION_LABEL_PREFIX}{section_id}"))
}

pub fn section_id_of(label: &str) -> Option<&str> {
    label.strip_prefix(SECTION_LABEL_PREFIX).filter(|id| valid_id(id))
}

/// 지금 분리돼 있는 섹션 id 들(정렬).
pub fn open_section_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|l| section_id_of(l).map(str::to_string))
        .collect();
    ids.sort();
    ids
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>, section_id: &str, open: bool) {
    let _ = app.emit(
        SECTION_WINDOW_CHANGED_EVENT,
        serde_json::json!({ "section_id": section_id, "open": open }),
    );
}

const WIDTH: f64 = 760.0;
const HEIGHT: f64 = 720.0;
/// 커서가 새 창 제목줄(AuxWindowChrome) 안에 오도록 좌상단을 이만큼 위로 둔다(논리 px).
const TITLE_GRAB_Y: f64 = 16.0;

/// 모니터 하나의 작업 영역 — (배율, 물리 x, y, w, h). tauri::Monitor 는 테스트에서 만들 수 없어 푼다.
type WorkArea = (f64, i32, i32, u32, u32);

/// 끌어 놓은 화면 좌표(`screenX/Y`, CSS 논리 px) → 새 창 좌상단(tao 규약의 논리 px).
///
/// 좌표 규약: Chromium 의 화면 DIP 는 모니터마다 "물리 = 논리 × 그 모니터 배율"로 맞춰져 있고,
/// tao 의 `with_position(Logical)` 도 모니터마다 자기 배율로 물리 변환해 들어맞는 모니터를 고른다
/// (tao platform_impl/windows/window.rs). 그래서 여기서도 같은 규칙으로 커서가 걸린 모니터를 찾고,
/// 그 모니터의 논리 좌표계 안에서 창이 작업 영역을 넘지 않게 붙잡는다. 좌상단이 같은 모니터 안에
/// 있으므로 tao 가 같은 배율로 되돌린다. 음수 좌표(왼쪽 모니터)도 같은 식이다.
/// 어느 모니터 작업 영역에도 안 걸리면 None → 호출자가 center 로 폴백.
/// ponytail: 작업표시줄 위(작업 영역 밖)에 놓으면 center 로 간다 — 필요하면 모니터 전체 영역으로 판정.
fn place_near_cursor(x: f64, y: f64, w: f64, h: f64, monitors: &[WorkArea]) -> Option<(f64, f64)> {
    monitors.iter().find_map(|&(s, mx, my, mw, mh)| {
        let (px, py) = (x * s, y * s);
        let inside = px >= mx as f64 && px < mx as f64 + mw as f64 && py >= my as f64 && py < my as f64 + mh as f64;
        if !inside {
            return None;
        }
        let (lx, ly, lw, lh) = (mx as f64 / s, my as f64 / s, mw as f64 / s, mh as f64 / s);
        let left = (x - w / 2.0).min(lx + lw - w).max(lx);
        let top = (y - TITLE_GRAB_Y).min(ly + lh - h).max(ly);
        Some((left, top))
    })
}

/// 이미 있으면 앞으로 가져오기만 한다(unminimize+show+focus — aux_window 와 같은 규칙). `at` 은
/// 새로 만들 때만 쓰인다(탭 끌어 놓기 좌표, place_near_cursor).
pub fn ensure_section_window<R: Runtime>(
    app: &AppHandle<R>,
    note_id: &str,
    section_id: &str,
    title: &str,
    at: Option<(f64, f64)>,
) -> Result<(), String> {
    let label = label_for(section_id).ok_or_else(|| "invalid section id".to_string())?;
    if !valid_id(note_id) {
        return Err("invalid note id".into());
    }
    // 같은 섹션 빠른 더블 오픈(메뉴 연타·끌어 놓기+메뉴)이 existed 확인~build 사이에서 겹치면 두 번째
    // build 가 "라벨 중복"으로 실패해 토스트가 뜬다. 커맨드가 async(워커 스레드)라 실제로 겹친다.
    // ponytail: 전역 잠금 하나 — 창 만들기는 드물고 짧다. 섹션별 잠금은 필요해질 때.
    let _open_guard = OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existed = app.get_webview_window(&label).is_some();
    // 쿼리는 해시 **앞** — main.tsx 의 해시 라우트가 `#/section` 정확 일치라서(settings_url 과 같은 규칙).
    let url = format!("index.html?note={note_id}&section={section_id}#/section");
    let title = if title.trim().is_empty() { "Brise" } else { title };
    let position = match (existed, at) {
        (false, Some((x, y))) => {
            let monitors: Vec<WorkArea> = app
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(|m| {
                    let r = m.work_area();
                    (m.scale_factor(), r.position.x, r.position.y, r.size.width, r.size.height)
                })
                .collect();
            let p = place_near_cursor(x, y, WIDTH, HEIGHT, &monitors);
            if p.is_none() {
                crate::diag::warn("section_window", "drop_off_monitor", &format!("{} monitors", monitors.len()));
            }
            p
        }
        _ => None,
    };
    ensure_owned_window_placed(
        app,
        &AuxWindowSpec {
            label: &label,
            title,
            url: &url,
            width: WIDTH,
            height: HEIGHT,
            min_width: 420.0,
            min_height: 320.0,
        },
        &url,
        position,
    )
    .map_err(|e| e.to_string())?;
    if !existed {
        if let Some(win) = app.get_webview_window(&label) {
            let app2 = app.clone();
            let sid = section_id.to_string();
            win.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    emit_changed(&app2, &sid, false);
                }
            });
        }
        emit_changed(app, section_id, true);
    }
    Ok(())
}

static OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 닫기 **요청** — 창의 onCloseRequested(src/lib/invoke.ts)가 flushAll 로 저장을 끝낸 뒤 스스로
/// destroy 한다. 그래서 여기서 destroy 하지 않는다(저장 전에 웹뷰가 사라지면 마지막 700ms 가 날아간다).
fn request_close<R: Runtime>(app: &AppHandle<R>, section_id: &str) -> bool {
    match label_for(section_id).and_then(|l| app.get_webview_window(&l)) {
        Some(win) => win.close().is_ok(),
        None => false,
    }
}

/// 닫기 요청 뒤 창이 저장을 끝내고 스스로 사라지기를 기다리는 상한. 넘기면 멈춘/크래시한 창으로
/// 보고 강제 파괴한다(그 창의 미저장 편집은 포기 — 진단에 남긴다).
/// ponytail: 고정 2초 — flush 는 로컬 IPC 몇 번이라 평소 수십 ms. 큰 시트에서 모자라면 늘린다.
const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// `ids` 중 `open` 에 아직 남은 것 — 순수(테스트용).
fn still_open(open: &[String], ids: &[String]) -> Vec<String> {
    ids.iter().filter(|id| open.contains(id)).cloned().collect()
}

/// 분리 창 닫기의 단일 경로 — 되돌리기(`section_window_close`), 스냅샷 복원 전 닫기, 앱 종료가 전부 여기로
/// 온다. 닫기 요청(= 그 창의 flushAll → destroy) → 사라질 때까지 대기 → 시간 초과면 destroy.
/// 반환 = 닫기 요청이 실제로 간 id(창이 있었던 것).
///
/// **락을 쥔 채 부르지 마라**: 기다리는 동안 분리 창의 flush 가 `section_update` 로 DB 락을 잡는다.
/// 메인 스레드에서 block_on 하지도 마라 — 창 닫기/파괴가 메인 스레드 이벤트 루프로 간다.
pub async fn close_and_wait<R: Runtime>(app: &AppHandle<R>, ids: Vec<String>, why: &str) -> Vec<String> {
    let requested: Vec<String> = ids.into_iter().filter(|id| request_close(app, id)).collect();
    let deadline = std::time::Instant::now() + CLOSE_TIMEOUT;
    let mut left = still_open(&open_section_ids(app), &requested);
    while !left.is_empty() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        left = still_open(&open_section_ids(app), &requested);
    }
    if !left.is_empty() {
        crate::diag::warn("section_window", "close_timeout", &format!("{why}: {} window(s) destroyed unsaved", left.len()));
        for id in &left {
            if let Some(win) = label_for(id).and_then(|l| app.get_webview_window(&l)) {
                let _ = win.destroy();
            }
        }
    }
    requested
}

/// 앱 종료 직전 — 모든 분리 창의 미저장 편집을 내보내게 한다. 종료 경로(트레이 "종료",
/// window_close_confirmed)는 본 창만 flushAll 하므로 이게 없으면 분리 창의 디바운스가 날아간다.
pub async fn close_all_before_exit<R: Runtime>(app: &AppHandle<R>) {
    let ids = open_section_ids(app);
    if !ids.is_empty() {
        close_and_wait(app, ids, "exit").await;
    }
}

/// 섹션이 아직 살아 있는가 — 행이 있고 노트가 휴지통에 있지 않다. DB 오류는 "살아 있음" 쪽으로
/// 넘긴다: 불확실할 때 사용자의 편집 창을 부수지 않는다.
fn section_alive(conn: &rusqlite::Connection, section_id: &str) -> bool {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT 1 FROM sections s JOIN notes n ON n.id = s.note_id WHERE s.id = ?1 AND n.deleted_at IS NULL",
        [section_id],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .unwrap_or(true)
}

/// 분리 중인 섹션(또는 그 노트)이 삭제됐으면 그 창을 닫는다. `events::publish` 가 모든 쓰기 뒤에
/// 부르는 초크포인트라 섹션 삭제·노트 휴지통·영구 삭제·원격(폰) 삭제가 전부 여기로 온다 —
/// 호출자마다 따로 닫는 코드를 두지 않는다.
///
/// 저장(flush) 없이 **destroy** 한다: 대상 섹션이 이미 없으니 저장은 NOT_FOUND 로 실패할 뿐이다.
/// 분리 창이 하나도 없으면(평소) DB 를 건드리지 않는다. 호출자가 DB 락을 쥔 채 publish 할 수 있어
/// 비동기 태스크로 넘겨 락이 풀린 뒤에 조회한다(parking_lot 뮤텍스는 재진입 불가).
pub fn close_orphans(app: &AppHandle) {
    let ids = open_section_ids(app);
    if ids.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::commands::AppState>() else { return };
        let gone: Vec<String> = {
            let conn = state.db.lock();
            ids.into_iter().filter(|id| !section_alive(&conn, id)).collect()
        };
        for id in gone {
            if let Some(win) = label_for(&id).and_then(|l| app.get_webview_window(&l)) {
                let _ = win.destroy();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    #[test]
    fn label_roundtrip_rejects_unsafe_ids() {
        assert_eq!(label_for("a1-b2").as_deref(), Some("section-a1-b2"));
        assert_eq!(section_id_of("section-a1-b2"), Some("a1-b2"));
        assert_eq!(label_for(""), None);
        assert_eq!(label_for("../x"), None);
        assert_eq!(label_for("a b"), None);
        assert_eq!(section_id_of("settings"), None);
        assert_eq!(section_id_of("section-"), None);
    }

    #[test]
    fn still_open_keeps_only_requested_ids_that_remain() {
        let open = vec!["a".to_string(), "c".to_string()];
        assert_eq!(still_open(&open, &["a".into(), "b".into()]), vec!["a".to_string()]);
        assert!(still_open(&open, &[]).is_empty());
        assert!(still_open(&[], &["a".into()]).is_empty());
    }

    #[test]
    fn place_near_cursor_per_monitor_scale_clamp_and_fallback() {
        // 주 모니터 3072×1728 물리 @2.0(작업 영역 높이 1680) + 왼쪽 1920×1080 @1.0(음수 좌표).
        let mons: Vec<WorkArea> = vec![(2.0, 0, 0, 3072, 1680), (1.0, -1920, 0, 1920, 1040)];
        // 주 모니터 가운데: 커서가 제목줄 가운데.
        assert_eq!(place_near_cursor(700.0, 100.0, 760.0, 720.0, &mons), Some((320.0, 84.0)));
        // 오른쪽 아래 구석 → 작업 영역(논리 1536×840) 안으로 붙잡힘.
        assert_eq!(place_near_cursor(1530.0, 830.0, 760.0, 720.0, &mons), Some((776.0, 120.0)));
        // 왼쪽 모니터(음수) 왼쪽 위 구석 → 그 모니터 좌상단.
        assert_eq!(place_near_cursor(-1910.0, 5.0, 760.0, 720.0, &mons), Some((-1920.0, 0.0)));
        // 어느 모니터에도 안 걸림 → None(center 폴백).
        assert_eq!(place_near_cursor(5000.0, 400.0, 760.0, 720.0, &mons), None);
        // 작업 영역보다 큰 창은 좌상단에 붙는다.
        assert_eq!(place_near_cursor(500.0, 300.0, 2000.0, 1000.0, &mons), Some((0.0, 0.0)));
    }

    #[test]
    fn section_alive_follows_section_row_and_note_trash() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let now = crate::util::now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        let sec = crate::repo::sections::create(&mut conn, "n1", None).unwrap();
        assert!(section_alive(&conn, &sec.id));
        assert!(!section_alive(&conn, "missing"));
        conn.execute("UPDATE notes SET deleted_at = ?1 WHERE id = 'n1'", [now]).unwrap();
        assert!(!section_alive(&conn, &sec.id), "note in trash → detached window must close");
    }
}
