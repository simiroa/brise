    use crate::db;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(crate::commands::AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    fn inbox_folder_id(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let state = app.state::<crate::commands::AppState>();
        let mut conn = state.db.lock();
        let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
        crate::repo::folders::ensure_inbox_folder_id(&mut conn, &ws).unwrap()
    }

    /// 이 note_id 로 온 이벤트만 골라 (origin, created) 목록으로. 개수 = 그 쓰기가 낸 이벤트 수.
    fn drain_for(rx: &mut tokio::sync::broadcast::Receiver<String>, note_id: &str) -> Vec<(String, bool)> {
        let mut out = vec![];
        while let Ok(payload) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
            if v["note_id"] == note_id {
                out.push((
                    v["origin"].as_str().unwrap_or_default().to_string(),
                    v["created"].as_bool().unwrap_or(false),
                ));
            }
        }
        out
    }

    /// 경로 (1) 데스크톱 Tauri IPC — 커맨드 함수를 직접 부른다(IPC 가 하는 일이 이것뿐이다).
    #[tokio::test]
    async fn a_desktop_command_write_publishes_exactly_one_local_event() {
        let (_dir, app) = mock_app_with_state();
        let folder_id = inbox_folder_id(&app);
        let mut rx = crate::events::subscribe();

        let detail = crate::commands::notes::note_create(
            app.state::<crate::commands::AppState>(),
            folder_id,
            Some("데스크톱 IPC 쓰기".to_string()),
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            drain_for(&mut rx, &detail.note.id),
            vec![("local".to_string(), true)],
            "a desktop IPC write must publish exactly one event, tagged local"
        );
    }

    /// 경로 (2) POST /api/v1/invoke — handlers::invoke 가 하는 일과 동일하게 dispatch 를
    /// events::scope_remote 로 감싼다. 개수 1 이 곧 "두 경로로 이중 emit 되지 않는다"의 증거다
    /// (invoke 핸들러 자체는 publish 하지 않는다 — 커맨드가 이미 낸다, events.rs 헤더 규칙).
    #[tokio::test]
    async fn the_same_command_over_invoke_publishes_exactly_one_remote_event() {
        let (_dir, app) = mock_app_with_state();
        let folder_id = inbox_folder_id(&app);
        let mut rx = crate::events::subscribe();

        let out = crate::events::scope_remote(None, super::dispatch::dispatch(
            app.handle(),
            "note_create",
            serde_json::json!({ "folder_id": folder_id, "title": "폰에서 쓴 노트" }),
        ))
        .await
        .unwrap();
        let note_id = out["note"]["id"].as_str().unwrap().to_string();

        assert_eq!(
            drain_for(&mut rx, &note_id),
            vec![("remote".to_string(), true)],
            "the HTTP path must publish exactly one event (no second emit from the HTTP layer), tagged remote"
        );
    }

    /// 커맨드 계층에 걸었으므로 note_create 뿐 아니라 섹션 저장(에디터 디바운스)도 통지된다 —
    /// 이게 데스크톱→폰 실시간 반영의 실제 주 경로다.
    #[tokio::test]
    async fn a_section_save_publishes_the_owning_note_id() {
        let (_dir, app) = mock_app_with_state();
        let folder_id = inbox_folder_id(&app);
        let state = app.state::<crate::commands::AppState>();
        let detail =
            crate::commands::notes::note_create(state, folder_id, None, None, None, None).unwrap();
        assert!(!detail.sections.is_empty(), "a new note is seeded with one section");
        let section_id = detail.sections[0].id.clone();
        let mut rx = crate::events::subscribe();

        crate::commands::sections::section_update(
            app.state::<crate::commands::AppState>(),
            section_id,
            None,
            Some("<p>데스크톱에서 타이핑</p>".to_string()),
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            drain_for(&mut rx, &detail.note.id),
            vec![("local".to_string(), false)],
            "section_update must publish exactly one event carrying the note it belongs to"
        );
    }

    /// **예전엔 구조적으로 불가능했던 방향**: 데스크톱 IPC 쓰기 → 폰의 SSE 스트림.
    /// SSE 채널이 서버 안에서만 만들어졌기 때문에 커맨드 계층의 쓰기는 애초에 닿을 수 없었다.
    /// 실제로 포트를 열고(포트 0) EventSource 대신 바이트 스트림으로 프레임을 읽어 확인한다.
    #[tokio::test]
    async fn sse_subscribers_receive_a_desktop_ipc_write() {
        use futures_util::StreamExt;

        let (dir, app) = mock_app_with_state();
        let folder_id = inbox_folder_id(&app);
        let (addr, handle) =
            super::start(dir.path().to_path_buf(), 0, "tok-sse-local".to_string(), None).unwrap();
        tokio::task::yield_now().await;

        let client = reqwest::Client::new();
        let sse = client
            .get(format!("http://{addr}/api/v1/events?token=tok-sse-local"))
            .send()
            .await
            .unwrap();
        assert_eq!(sse.status(), 200);
        let mut byte_stream = sse.bytes_stream();
        // subscribe() 가 등록될 틈을 준다(브로드캐스트는 구독자 0이면 그냥 버려진다).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // 데스크톱 IPC 경로: 커맨드를 직접 부른다. HTTP 서버는 이 쓰기를 전혀 알지 못한다.
        let detail = crate::commands::notes::note_create(
            app.state::<crate::commands::AppState>(),
            folder_id,
            Some("데스크톱에서 만든 노트".to_string()),
            None,
            None,
            None,
        )
        .unwrap();

        let found = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut buf = String::new();
            while let Some(chunk) = byte_stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                // 프레임 이름(event: ...)은 웹 클라이언트가 라우팅에 쓰는 값 — 회귀 가드로 함께 본다.
                if buf.contains("event: remote-note-write") && buf.contains(&detail.note.id) {
                    return buf.contains("\"origin\":\"local\"");
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(
            found,
            "a desktop IPC write must reach SSE subscribers as a named remote-note-write frame tagged origin=local"
        );

        handle.abort();
    }
