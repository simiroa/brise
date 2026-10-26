    // 드릴 3 (docs/DRILLS-2026-10-06.md) — 두 클라이언트(phone-1/phone-2) + 데스크톱 IPC 가 같은 노트를
    // 동시에 편집할 때의 **실제 동작**을 단언한다. 기대와 다른 동작은 고치지 않고 그대로 단언하며,
    // "DEFECT:" 주석으로 표시한다(보고서 표와 1:1).
    //
    // 하네스: events_wiring_tests 와 같다 — mock 앱 + `dispatch` 를 `events::scope_remote(client, ..)` 로
    // 감싸면 handlers::invoke 가 하는 일(X-Brise-Client -> origin=remote,client=id)과 동일하다.
    // 데스크톱은 커맨드 함수를 직접 부른다(Tauri IPC 가 하는 일이 그것뿐). DB 는 AppState.db 의 단일
    // Mutex 하나라 쓰기는 항상 **통째로 직렬화**된다 — 여기서 "동시"는 두 쓰기의 도착 순서가 뒤섞인다는
    // 뜻이고, join! 은 첫 번째 future 를 먼저 끝낸다(결정적).
    use super::dispatch::{dispatch, DispatchError};
    use crate::db;
    use serde_json::{json, Value};
    use tauri::Manager;

    type App = tauri::App<tauri::test::MockRuntime>;

    fn setup() -> (tempfile::TempDir, App, String, Vec<String>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(crate::commands::AppState::new(conn, data_dir.path().to_path_buf()));
        let ids;
        let note_id;
        {
            let state = app.state::<crate::commands::AppState>();
            let mut conn = state.db.lock();
            let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
            let folder = crate::repo::folders::ensure_inbox_folder_id(&mut conn, &ws).unwrap();
            let detail = crate::repo::notes::create_today_default(&mut conn, &folder, Some("drill3".into()), None, None, None).unwrap();
            note_id = detail.note.id.clone();
            let s0 = detail.sections[0].id.clone();
            crate::repo::sections::update(&mut conn, &s0, None, Some("base".into()), None).unwrap();
            let s1 = crate::repo::sections::create_with_body(&mut conn, &note_id, Some("Second".into()), "second-base".into()).unwrap();
            ids = vec![s0, s1.id];
        }
        (data_dir, app, note_id, ids)
    }

    /// 폰 쓰기 = invoke 와 같은 경로. 결과: Ok(json) | Err((AppError 코드, 메시지)).
    async fn phone(app: &App, client: &str, cmd: &str, args: Value) -> Result<Value, (String, String)> {
        match crate::events::scope_remote(Some(client.to_string()), dispatch(app.handle(), cmd, args)).await {
            Ok(v) => Ok(v),
            Err(DispatchError::Command(e)) => Err((e.code().to_string(), e.to_string())),
            Err(DispatchError::BadArgs(m)) => Err(("BAD_ARGS".into(), m)),
            Err(DispatchError::UnknownCommand) => Err(("UNKNOWN".into(), cmd.into())),
        }
    }

    fn bodies(app: &App, note_id: &str) -> Vec<String> {
        let state = app.state::<crate::commands::AppState>();
        let conn = state.db.lock();
        crate::repo::sections::load_for_note(&conn, note_id).unwrap().into_iter().map(|s| s.body_md).collect()
    }

    fn desktop_set(app: &App, section_id: &str, body: &str) {
        crate::commands::sections::section_update(
            app.state::<crate::commands::AppState>(),
            section_id.to_string(),
            None,
            Some(body.to_string()),
            None,
            None,
        )
        .unwrap();
    }

    /// (a) 같은 섹션을 같은 읽기 토큰으로 동시에 — 먼저 실행된 쪽만 성공, 늦은 쪽은 CONFLICT 이고 본문은
    /// 먼저 쓴 값 그대로(D2② W1 이전엔 둘 다 Ok, 조용한 LWW 였다). 토큰을 안 보내면 여전히 LWW(단계 1).
    #[tokio::test]
    async fn a_same_section_concurrent_writes_late_one_conflicts() {
        let (_d, app, note_id, ids) = setup();
        let got = phone(&app, "phone-1", "note_get", json!({ "id": note_id })).await.unwrap();
        let token = got["sections"][0]["updated_at"].as_str().unwrap().to_string();
        let (r1, r2) = tokio::join!(
            phone(&app, "phone-1", "section_update", json!({ "id": ids[0], "body_md": "<p>from phone-1</p>", "expected_updated_at": token })),
            phone(&app, "phone-2", "section_update", json!({ "id": ids[0], "body_md": "<p>from phone-2</p>", "expected_updated_at": token })),
        );
        let (ok, lost) = match (&r1, &r2) {
            (Ok(v), Err(e)) => ((v, "<p>from phone-1</p>"), e),
            (Err(e), Ok(v)) => ((v, "<p>from phone-2</p>"), e),
            other => panic!("exactly one write must win: {other:?}"),
        };
        assert_eq!(lost.0, "CONFLICT");
        assert!(ok.0.get("section_updated_at").is_some(), "response carries the new token: {}", ok.0);
        assert_eq!(bodies(&app, &note_id)[0], ok.1);
        // 토큰 없는 쓰기(데스크톱 구 경로)는 단계 1 동안 마지막 쓰기 승리.
        desktop_set(&app, &ids[0], "<p>from desktop</p>");
        assert_eq!(bodies(&app, &note_id)[0], "<p>from desktop</p>");
    }

    /// (b) 서로 다른 섹션 — 둘 다 보존.
    #[tokio::test]
    async fn b_different_sections_both_survive() {
        let (_d, app, note_id, ids) = setup();
        let (r1, r2) = tokio::join!(
            phone(&app, "phone-1", "section_update", json!({ "id": ids[0], "body_md": "<p>one</p>" })),
            phone(&app, "phone-2", "section_update", json!({ "id": ids[1], "body_md": "<p>two</p>" })),
        );
        r1.unwrap();
        r2.unwrap();
        assert_eq!(bodies(&app, &note_id), vec!["<p>one</p>", "<p>two</p>"], "section-granular writes must not clobber each other");
    }

    /// (c) lost update 차단: A 읽음 -> B 씀 -> A 가 읽은 토큰으로 전체 재작성 -> CONFLICT, B 의 줄 보존.
    #[tokio::test]
    async fn c_stale_read_then_rewrite_is_rejected() {
        let (_d, app, note_id, ids) = setup();
        let got = phone(&app, "phone-1", "note_get", json!({ "id": note_id })).await.unwrap();
        let read_body = got["sections"][0]["body_md"].as_str().unwrap().to_string();
        let read_updated_at = got["sections"][0]["updated_at"].as_str().unwrap().to_string();
        assert_eq!(read_body, "base");
        phone(&app, "phone-2", "section_update", json!({ "id": ids[0], "body_md": "base
phone-2 line" })).await.unwrap();
        let (code, _) = phone(
            &app,
            "phone-1",
            "section_update",
            json!({ "id": ids[0], "body_md": format!("{read_body}
phone-1 line"), "expected_updated_at": read_updated_at }),
        )
        .await
        .expect_err("stale rewrite must be rejected");
        assert_eq!(code, "CONFLICT");
        assert_eq!(bodies(&app, &note_id)[0], "base
phone-2 line", "phone-2's edit survives");
        // 다시 읽은 토큰으로는 통과한다.
        let fresh = phone(&app, "phone-1", "note_get", json!({ "id": note_id })).await.unwrap();
        let fresh_token = fresh["sections"][0]["updated_at"].as_str().unwrap().to_string();
        phone(
            &app,
            "phone-1",
            "section_update",
            json!({ "id": ids[0], "body_md": "base
phone-2 line
phone-1 line", "expected_updated_at": fresh_token }),
        )
        .await
        .unwrap();
    }

    /// (d) 삭제/휴지통 직후의 쓰기.
    #[tokio::test]
    async fn d_write_after_trash_or_purge() {
        let (_d, app, note_id, ids) = setup();
        phone(&app, "phone-1", "note_delete", json!({ "id": note_id })).await.unwrap();
        // D2② W1: 토큰을 든 쓰기(새 클라이언트)는 NOT_FOUND — 삭제 사실이 쓴 쪽에 전달된다.
        let token = {
            let state = app.state::<crate::commands::AppState>();
            let conn = state.db.lock();
            conn.query_row("SELECT updated_at FROM sections WHERE id=?1", [&ids[0]], |r| r.get::<_, String>(0)).unwrap()
        };
        let (code, msg) = phone(
            &app,
            "phone-2",
            "section_update",
            json!({ "id": ids[0], "body_md": "<p>write into trash</p>", "expected_updated_at": token }),
        )
        .await
        .expect_err("token-bearing write to a trashed note must be rejected");
        assert_eq!(code, "NOT_FOUND");
        assert!(msg.contains("trash"), "{msg}");
        assert_ne!(bodies(&app, &note_id)[0], "<p>write into trash</p>");
        // 단계 1: 토큰 없는 구 클라이언트 쓰기는 예전처럼 휴지통 안으로 들어간다(복구 시 살아남는다 —
        // 충돌 UI(W3) 전에 거부하면 오히려 유실/토스트 폭주).
        phone(&app, "phone-2", "section_update", json!({ "id": ids[0], "body_md": "<p>legacy into trash</p>" }))
            .await
            .unwrap();
        assert_eq!(bodies(&app, &note_id)[0], "<p>legacy into trash</p>");
        {
            let state = app.state::<crate::commands::AppState>();
            let conn = state.db.lock();
            let deleted: Option<String> =
                conn.query_row("SELECT deleted_at FROM notes WHERE id=?1", [&note_id], |r| r.get(0)).unwrap();
            assert!(deleted.is_some(), "the note stays trashed");
            let fts_rows: i64 =
                conn.query_row("SELECT COUNT(*) FROM notes_fts WHERE note_id=?1", [&note_id], |r| r.get(0)).unwrap();
            assert_eq!(fts_rows, 0, "trashed note stays out of the FTS index");
        }
        // 휴지통 노트에 태그 같은 노트 쓰기가 와도 색인이 되살아나지 않는다(fts_upsert 가드).
        phone(&app, "phone-2", "note_set_tags", json!({ "id": note_id, "tag_names": ["t"] })).await.unwrap();
        {
            let state = app.state::<crate::commands::AppState>();
            let conn = state.db.lock();
            let fts_rows: i64 =
                conn.query_row("SELECT COUNT(*) FROM notes_fts WHERE note_id=?1", [&note_id], |r| r.get(0)).unwrap();
            assert_eq!(fts_rows, 0, "non-section writes don't resurrect the FTS row either");
        }

        // 완전 삭제(purge) 뒤의 쓰기 -> NOT_FOUND. 정상.
        phone(&app, "phone-1", "note_purge", json!({ "id": note_id })).await.unwrap();
        let (code, msg) = phone(&app, "phone-2", "section_update", json!({ "id": ids[0], "body_md": "x" }))
            .await
            .expect_err("purged section must not accept writes");
        assert_eq!(code, "NOT_FOUND");
        assert!(msg.contains("section not found"), "{msg}");
    }

    /// (d3) HTTP 층의 커맨드 에러 응답 — 예전엔 전부 500 {"error"} 로 코드가 사라졌다. 이제 additive
    /// `code` 를 싣고 CONFLICT 는 409. 도메인 NOT_FOUND 는 404 가 아니다(브리지·CLI 가 404 를 "HTTP
    /// 표면 밖"으로 읽는다). mock 앱은 실제 HTTP invoke 를 못 타므로 응답 빌더를 직접 본다.
    #[tokio::test]
    async fn d3_command_errors_keep_their_code_over_http() {
        use axum::http::StatusCode;
        use crate::error::AppError;
        for (e, status, code) in [
            (AppError::Conflict("c".into()), StatusCode::CONFLICT, "CONFLICT"),
            (AppError::NotFound("n".into()), StatusCode::INTERNAL_SERVER_ERROR, "NOT_FOUND"),
            (AppError::Validation("v".into()), StatusCode::INTERNAL_SERVER_ERROR, "VALIDATION"),
        ] {
            let res = crate::sync_server::handlers::command_error_response(e);
            assert_eq!(res.status(), status);
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            let v: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(v["code"], code);
            assert!(v["error"].is_string());
        }
    }

    /// (e) SSE — 상대 클라이언트가 이벤트를 받고, 자기 에코는 client 필드로 구분된다.
    #[tokio::test]
    async fn e_sse_frames_carry_origin_and_client_for_echo_detection() {
        use futures_util::StreamExt;
        let (d, app, note_id, ids) = setup();
        let (addr, handle) = super::start(d.path().to_path_buf(), 0, "tok-d3".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let sse = reqwest::Client::new().get(format!("http://{addr}/api/v1/events?token=tok-d3")).send().await.unwrap();
        assert_eq!(sse.status(), 200);
        let mut stream = sse.bytes_stream();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        phone(&app, "phone-1", "section_update", json!({ "id": ids[0], "body_md": "<p>1</p>" })).await.unwrap();
        phone(&app, "phone-2", "section_update", json!({ "id": ids[1], "body_md": "<p>2</p>" })).await.unwrap();
        desktop_set(&app, &ids[0], "<p>d</p>");

        let frames: Vec<Value> = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (mut buf, mut out) = (String::new(), Vec::<Value>::new());
            while let Some(chunk) = stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                out = buf
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:"))
                    .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
                    .filter(|v| v["note_id"] == note_id.as_str())
                    .collect();
                if out.len() >= 3 {
                    break;
                }
            }
            out
        })
        .await
        .unwrap_or_default();
        handle.abort();

        assert_eq!(frames.len(), 3, "exactly one frame per write, no double emit: {frames:?}");
        let tag = |v: &Value| (v["origin"].as_str().unwrap().to_string(), v["client"].as_str().map(str::to_string));
        assert_eq!(tag(&frames[0]), ("remote".to_string(), Some("phone-1".to_string())));
        assert_eq!(tag(&frames[1]), ("remote".to_string(), Some("phone-2".to_string())));
        // 데스크톱 쓰기는 client 가 없다 — 어떤 폰도 이를 자기 에코로 오인하지 않는다(옳음).
        assert_eq!(tag(&frames[2]), ("local".to_string(), None));
        // 한계(결함 아님): 페이로드는 note_id 만 싣고 section_id/updated_at 이 없다 — 수신 쪽은 노트 전체를
        // 재조회해야 하고, 재조회가 편집 중인 로컬 입력을 덮을지는 클라이언트 몫이다.
        assert!(frames[0].get("section_id").is_none());
    }
