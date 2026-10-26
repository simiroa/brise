// 공용 테스트 하네스 — tempfile DB 로 repo 계층 직접 호출.
#![allow(dead_code)]
use brise_lib::db;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub struct Ctx {
    pub tmp: TempDir,
    pub conn: Connection,
    pub data_dir: PathBuf,
    pub folder_id: String,
}

/// 부트스트랩된(마이그레이션+시드 완료) 임시 DB 컨텍스트.
pub fn setup() -> Ctx {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let conn = db::bootstrap(&data_dir).expect("bootstrap");
    let folder_id: String = conn
        .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
        .expect("seed folder");
    Ctx {
        tmp,
        conn,
        data_dir,
        folder_id,
    }
}

/// 외부(앱 데이터 디렉토리 밖) 임시 파일 생성 — 첨부 원본 시뮬레이션.
pub fn make_external_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

/// notes_fts 에 특정 note_id 행이 존재하는지 (직접 쿼리).
pub fn fts_has(conn: &Connection, note_id: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM notes_fts WHERE note_id=?1",
        [note_id],
        |r| r.get::<_, i64>(0),
    )
    .unwrap()
        > 0
}

pub fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

pub struct MockTransport {
    pub confidence: f32,
    pub title: String,
    pub year: i64,
    pub tags: Vec<String>,
    pub malformed: bool,
    // 폴더 추론 테스트용 — mock_provider()는 None(폴더 없음)으로 채운다. 폴더 제안이 필요한
    // 테스트는 MockTransport { ..mock_provider(...), folder: Some("...".into()) } 로 덮어쓴다.
    pub folder: Option<String>,
}

impl brise_lib::repo::ai::TextTransport for MockTransport {
    async fn send_text(
        &self,
        _provider: brise_lib::repo::ai::Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        _system_prompt: String,
        _user_text: String,
    ) -> brise_lib::error::AppResult<String> {
        if self.malformed {
            Ok("{ invalid }".to_string())
        } else {
            let proposal = brise_lib::repo::ai::AiProposal {
                title: Some(self.title.clone()),
                year: Some(self.year),
                tags: Some(self.tags.clone()),
                region: None,
                folder: self.folder.clone(),
                lat: None,
                lng: None,
                source_urls: None,
                confidence: self.confidence,
            };
            Ok(serde_json::to_string(&proposal).unwrap())
        }
    }
}

pub fn mock_provider(
    confidence: f32,
    title: &str,
    year: i64,
    tags: Vec<&str>,
    malformed: bool,
) -> MockTransport {
    MockTransport {
        confidence,
        title: title.to_string(),
        year,
        tags: tags.into_iter().map(|s| s.to_string()).collect(),
        malformed,
        folder: None,
    }
}
