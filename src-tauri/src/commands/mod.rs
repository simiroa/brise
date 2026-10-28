// Tauri 커맨드 계층 — repo 위임만 하는 얇은 래퍼 (도메인당 1파일).
pub mod activity;
pub mod ai;
pub mod attachments;
pub mod audio_transcribe;
pub mod capture;
pub mod collect;
pub mod dashboard;
pub mod data_location;
pub mod diag;
pub mod emoji;
pub mod fonts;
pub mod geocode;
pub mod migrate;
pub mod notes;
pub mod notifications;
pub mod pet;
pub mod routine;
pub mod search;
pub mod sections;
pub mod settings;
pub mod slides;
pub mod snapshots;
pub mod sources;
pub mod suggestions;
pub mod sync;
pub mod taxonomy;
pub mod calendar_marks;
pub mod timeline_routine;
pub mod habits;
pub mod briefing;
pub mod transfer;
pub mod weather;
pub mod window;
pub mod workspaces;


use crate::models::NoteSummary;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
// parking_lot::Mutex: no poisoning on panic (std::sync::Mutex would brick the whole app after
// any single command panic — see Cargo.toml comment). lock() returns the guard directly.
use parking_lot::Mutex;

/// 앱 전역 상태: DB 연결(단일, R2 단일 인스턴스 전제) + 데이터 디렉토리.
pub struct AppState {
    /// Arc 인 이유(2026-08-09, SCALABILITY.md §3): 무거운 커맨드를 `async fn` +
    /// `spawn_blocking` 으로 옮기려면 워커가 **소유**할 수 있는 핸들이 필요하다 —
    /// `State<'_, AppState>` 는 빌림이라 `'static` 클로저에 못 들어간다. 호출부는 그대로다
    /// (`state.db.lock()` 은 Deref 로 동작), 옮길 때만 `Arc::clone(&state.db)` 를 쓴다.
    pub db: std::sync::Arc<Mutex<Connection>>,
    pub data_dir: PathBuf,
    /// Emoji 3D 스타일 패크 다운로드 진행 상태.
    pub emoji_state: std::sync::Arc<crate::repo::emoji::EmojiDownloadState>,
    /// 내려받기 글꼴 진행 상태(repo/fonts.rs).
    pub font_state: std::sync::Arc<crate::repo::fonts::FontDownloadState>,
    /// 같은 DB 파일의 읽기 전용 연결(db::open_read_only) — 채팅 근거 검색·프롬프트 합성처럼 오래
    /// 걸리는 읽기를 `db` 잠금 밖에서 돌려, 그동안 자동 저장 등 다른 커맨드가 기다리지 않게 한다.
    /// 자기 Mutex 는 이 연결을 쓰는 읽기끼리만 직렬화한다(쓰기 연결과는 무관, WAL).
    /// None(`new` 로 만든 상태 — 테스트·인메모리 DB, 부팅 때 열기 실패, 파일 교체 뒤 다시 열기 실패)이면
    /// `with_read` 가 `db` 로 폴백. DB 파일을 통째로 바꾸는 쪽은 `with_db_file_swap` 으로 이 연결을 닫았다 연다.
    pub read_db: Mutex<Option<Connection>>,
}

impl AppState {
    pub fn new(conn: Connection, data_dir: PathBuf) -> Self {
        Self {
            db: std::sync::Arc::new(Mutex::new(conn)),
            data_dir,
            emoji_state: std::sync::Arc::new(crate::repo::emoji::EmojiDownloadState::default()),
            font_state: std::sync::Arc::new(crate::repo::fonts::FontDownloadState::default()),
            read_db: Mutex::new(None),
        }
    }

    /// `new` + 쓰기 연결과 같은 파일의 읽기 전용 연결. 열 수 없으면(인메모리 DB, 파일 없음 등)
    /// 진단에 한 번 남기고 `read_db = None` — 동작은 예전(전부 `db` 잠금 안)과 같다.
    pub fn new_with_read_handle(conn: Connection, data_dir: PathBuf) -> Self {
        let path = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from);
        let read = match path {
            Some(p) => crate::db::open_read_only(&p).map_err(|e| e.to_string()),
            None => Err("in-memory or temporary database".to_string()),
        };
        let state = Self::new(conn, data_dir);
        match read {
            Ok(r) => *state.read_db.lock() = Some(r),
            Err(e) => crate::diag::warn("pet", "read_conn_unavailable", e),
        }
        state
    }

    pub fn has_read_handle(&self) -> bool {
        self.read_db.lock().is_some()
    }

    /// 쓰기가 필요 없는 무거운 읽기를 돌린다 — 읽기 연결이 있으면 그것으로(`db` 잠금을 쥐지 않음),
    /// 없으면 `db` 로. 신선도: 마지막으로 커밋된 상태를 본다 — `db` 잠금 안에서 읽던 예전과 같다
    /// (그때도 다른 커맨드의 트랜잭션은 잠금을 놓기 전에 커밋돼 있었다).
    /// 클로저 안에서 `self.db.lock()` 을 다시 잡지 말 것 — 폴백 경로에서 교착한다.
    pub fn with_read<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        {
            let read = self.read_db.lock();
            if let Some(r) = read.as_ref() {
                return f(r);
            }
        }
        // 읽기 잠금을 놓은 뒤에 `db` 를 잡는다 — 쥔 채로 잡으면 `with_db_file_swap`(db → read 순)과 교착한다.
        f(&self.db.lock())
    }

    /// DB 파일을 통째로 바꾸는 일(backup_restore)을 읽기 연결을 **닫은 채** 돌리고, 끝나면 성공·실패와
    /// 무관하게 같은 경로로 다시 연다. 읽기 연결이 파일·-wal·-shm 을 쥐고 있으면 Windows 는 지우기를 거부하고
    /// (os error 32 — 복원이 늘 실패했다), 다른 OS 에선 읽기 연결이 지워진 옛 파일을 계속 읽는다.
    /// 호출자는 `db` 잠금을 **먼저** 쥐고 부른다(잠금 순서 db → read). 다시 열기 실패는 진단에 남기고
    /// None 으로 둔다 — 이후 채팅 검색은 `db` 로 폴백(빈 DB 를 읽는 것보다 낫다).
    pub fn with_db_file_swap<R>(&self, f: impl FnOnce() -> R) -> R {
        let mut read = self.read_db.lock();
        // take 로 꺼낸 연결은 경로만 남기고 여기서 닫힌다(파일 핸들 해제).
        let path = read
            .take()
            .and_then(|c| c.path().filter(|p| !p.is_empty()).map(PathBuf::from));
        let out = f();
        if let Some(p) = path {
            match crate::db::open_read_only(&p) {
                Ok(c) => *read = Some(c),
                Err(e) => crate::diag::warn("pet", "read_conn_reopen_failed", e.to_string()),
            }
        }
        out
    }
}

// 공용 응답 셰이프 (commands/*.yaml output 계약).
#[derive(Serialize)]
pub struct Deleted {
    pub deleted: bool,
}
#[derive(Serialize)]
pub struct Okay {
    pub ok: bool,
}
#[derive(Serialize)]
pub struct FavoriteState {
    pub is_favorite: bool,
}
#[derive(Serialize)]
pub struct ContentLockState {
    pub content_locked: bool,
}
#[derive(Serialize)]
pub struct TrashCount {
    pub count: i64,
}
/// note_query output — one window of NoteSummary plus unwindowed total.
#[derive(Serialize)]
pub struct NoteQueryOutput {
    pub notes: Vec<NoteSummary>,
    pub total: i64,
}
#[derive(Serialize)]
pub struct TagsResult {
    pub tag_names: Vec<String>,
}
/// note_tags_index 출력 — folder_list 경량 로드 후 태그 필터/칩용.
#[derive(Serialize)]
pub struct NoteTagsIndex {
    pub tags_by_note: HashMap<String, Vec<String>>,
}
/// tag_counts 출력 — 워크스페이스 태그별 노트 수(사이드바 칩). soft-delete 제외.
#[derive(Serialize)]
pub struct TagCounts {
    pub counts: HashMap<String, i64>,
}
/// tag_colors 출력 — 워크스페이스 태그별 hue 맵. soft-delete 제외.
#[derive(Serialize)]
pub struct TagColors {
    pub colors: HashMap<String, i64>,
}
/// tag_rename / tag_merge / tag_delete 출력 — `affected` 는 태그 목록이 실제로 바뀐 노트 수.
#[derive(Serialize)]
pub struct TagAffected {
    pub ok: bool,
    pub affected: i64,
}
#[derive(Serialize)]
pub struct SectionUpdated {
    pub updated_at: String,
    /// 이 섹션의 새 버전 토큰 — 다음 `section_update` 의 `expected_updated_at` 으로 쓴다(D2②).
    /// `updated_at`(노트 시각)과 다르다.
    pub section_updated_at: String,
}

impl From<crate::repo::sections::SectionWrite> for SectionUpdated {
    fn from(w: crate::repo::sections::SectionWrite) -> Self {
        Self { updated_at: w.updated_at, section_updated_at: w.section_updated_at }
    }
}
/// Wave 7 (P30): note_related 출력 셰이프.
#[derive(Serialize)]
pub struct RelatedResult {
    pub notes: Vec<NoteSummary>,
}
