    use crate::db;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(crate::commands::AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    #[tokio::test]
    async fn happy_path_on_a_real_read_command() {
        let (_data_dir, app) = mock_app_with_state();
        let out = super::dispatch::dispatch(app.handle(), "settings_get_all", serde_json::json!({}))
            .await
            .expect("settings_get_all should succeed against a freshly bootstrapped DB");
        assert!(out.get("settings").is_some(), "expected a `settings` field in the output: {out:?}");
    }

    #[tokio::test]
    async fn unknown_command_is_unknown() {
        let (_data_dir, app) = mock_app_with_state();
        let err = super::dispatch::dispatch(app.handle(), "definitely_not_a_real_command", serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, super::dispatch::DispatchError::UnknownCommand));
    }

    /// db_reset is `http: false` in specs/commands/export.yaml — the generator never emits an arm
    /// for it, so it is unreachable through dispatch() exactly like a typo'd command name. This is
    /// the "http:false command NOT reachable" test the task asks for.
    #[tokio::test]
    async fn http_false_command_is_unreachable_same_as_unknown() {
        let (_data_dir, app) = mock_app_with_state();
        let err = super::dispatch::dispatch(
            app.handle(),
            "db_reset",
            serde_json::json!({ "confirm": "RESET" }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, super::dispatch::DispatchError::UnknownCommand));
    }

    /// 2026-10-06 채팅 코어 원격 개방: pet_chat_history 는 도달 가능, 서버 로컬 경로를 읽는
    /// pet_chat_read_attach 와 창 조작(pet_open_main)은 http:false 로 여전히 도달 불가.
    #[tokio::test]
    async fn chat_core_is_reachable_but_local_pet_surfaces_stay_closed() {
        let (_data_dir, app) = mock_app_with_state();
        let out = super::dispatch::dispatch(app.handle(), "pet_chat_history", serde_json::json!({}))
            .await
            .expect("pet_chat_history is http:true");
        assert!(out.get("messages").is_some(), "{out:?}");
        for closed in ["pet_chat_read_attach", "pet_open_main", "pet_screenshot_capture", "pet_bubble_toggle"] {
            let err = super::dispatch::dispatch(app.handle(), closed, serde_json::json!({ "path": "x" }))
                .await
                .unwrap_err();
            assert!(matches!(err, super::dispatch::DispatchError::UnknownCommand), "{closed} must stay http:false");
        }
    }

    /// 원격 pet_session_new 는 AppHandle 없이도(mock 런타임: 데스크톱 APP 핸들 없음) 패닉 없이
    /// 끝나고, SSE 버스에 "pet-chat-updated" 를 origin=remote 로 한 번 낸다.
    #[tokio::test]
    async fn remote_chat_write_publishes_pet_chat_updated_on_the_bus() {
        let (_data_dir, app) = mock_app_with_state();
        let mut rx = crate::events::subscribe();
        crate::events::scope_remote(None, super::dispatch::dispatch(
            app.handle(),
            "pet_session_new",
            serde_json::json!({}),
        ))
        .await
        .expect("pet_session_new over dispatch");
        let mut found = None;
        while let Ok(raw) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if v["event"] == "pet-chat-updated" {
                found = Some(v);
            }
        }
        let v = found.expect("pet-chat-updated must reach the SSE bus");
        assert_eq!(v["origin"], "remote");
        assert_eq!(v["reason"], "session");
    }

    #[tokio::test]
    async fn bad_args_missing_required_field_is_bad_args() {
        let (_data_dir, app) = mock_app_with_state();
        // note_create requires folder_id (String) — send an empty object.
        let err = super::dispatch::dispatch(app.handle(), "note_create", serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, super::dispatch::DispatchError::BadArgs(_)));
    }

    // ── P2 1단계: 후행 제안 커맨드 (docs/PLAN-2026-08-07-second-brain.md Q5) ───────────────────

    #[tokio::test]
    async fn suggestions_list_and_set_status_round_trip_through_dispatch() {
        let (_data_dir, app) = mock_app_with_state();
        let state = app.state::<crate::commands::AppState>();
        let (ws_id, note_a, note_b) = {
            let mut conn = state.db.lock();
            let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
            let folder_id: String = conn
                .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws_id], |r| r.get(0))
                .unwrap();
            let a = crate::repo::notes::create(&mut conn, &folder_id, Some("여수 첫 방문".into()), Some(1592))
                .unwrap()
                .note
                .id;
            let b = crate::repo::notes::create(&mut conn, &folder_id, Some("여수 재방문".into()), Some(1593))
                .unwrap()
                .note
                .id;
            crate::repo::suggestions::upsert_overlap(&conn, &ws_id, &a, &b, 0.9, "{}").unwrap();
            (ws_id, a, b)
        };

        let listed = super::dispatch::dispatch(
            app.handle(),
            "suggestions_list",
            serde_json::json!({ "workspace_id": ws_id }),
        )
        .await
        .expect("suggestions_list should default to status=pending and succeed");
        let rows = listed.get("suggestions").and_then(|v| v.as_array()).expect("suggestions array");
        assert_eq!(rows.len(), 1, "{listed:?}");
        assert_eq!(rows[0].get("kind").and_then(|v| v.as_str()), Some("overlap"));
        // note_id/related_note_id are normalized (min,max) by upsert_overlap — just assert both
        // notes are represented, not a fixed order.
        let ids: Vec<&str> = [
            rows[0].get("note_id").and_then(|v| v.as_str()).unwrap(),
            rows[0].get("related_note_id").and_then(|v| v.as_str()).unwrap(),
        ]
        .to_vec();
        assert!(ids.contains(&note_a.as_str()) && ids.contains(&note_b.as_str()), "{listed:?}");
        let id = rows[0].get("id").and_then(|v| v.as_str()).unwrap().to_string();

        let set = super::dispatch::dispatch(
            app.handle(),
            "suggestion_set_status",
            serde_json::json!({ "id": id, "status": "dismissed" }),
        )
        .await
        .expect("suggestion_set_status should accept a valid status");
        assert_eq!(set.get("ok").and_then(|v| v.as_bool()), Some(true), "{set:?}");

        let pending_after = super::dispatch::dispatch(
            app.handle(),
            "suggestions_list",
            serde_json::json!({ "workspace_id": ws_id }),
        )
        .await
        .unwrap();
        assert!(
            pending_after.get("suggestions").and_then(|v| v.as_array()).unwrap().is_empty(),
            "dismissed suggestion must drop out of the default pending listing: {pending_after:?}"
        );

        let bad_status = super::dispatch::dispatch(
            app.handle(),
            "suggestion_set_status",
            serde_json::json!({ "id": id, "status": "bogus" }),
        )
        .await
        .unwrap_err();
        assert!(matches!(bad_status, super::dispatch::DispatchError::Command(_)), "{bad_status:?}");
    }

    #[tokio::test]
    async fn graph_suggestion_accept_round_trips_through_dispatch() {
        let (_data_dir, app) = mock_app_with_state();
        let state = app.state::<crate::commands::AppState>();
        let suggestion_id = {
            let mut conn = state.db.lock();
            let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
            let folder: String = conn
                .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws], |r| r.get(0))
                .unwrap();
            let a = crate::repo::notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap().note.id;
            let b = crate::repo::notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap().note.id;
            crate::repo::suggestions::upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
            crate::repo::suggestions::list(&conn, &ws, "pending").unwrap()[0].id.clone()
        };

        let out = super::dispatch::dispatch(
            app.handle(),
            "graph_suggestion_accept",
            serde_json::json!({ "id": suggestion_id }),
        )
        .await
        .expect("graph_suggestion_accept should be exposed");
        assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(true));
    }

    #[tokio::test]
    async fn graph_suggestion_dismiss_round_trips_through_dispatch() {
        let (_data_dir, app) = mock_app_with_state();
        let state = app.state::<crate::commands::AppState>();
        let suggestion_id = {
            let mut conn = state.db.lock();
            let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
            let folder: String = conn
                .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws], |r| r.get(0))
                .unwrap();
            let a = crate::repo::notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap().note.id;
            let b = crate::repo::notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap().note.id;
            crate::repo::suggestions::upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
            crate::repo::suggestions::list(&conn, &ws, "pending").unwrap()[0].id.clone()
        };

        let out = super::dispatch::dispatch(
            app.handle(),
            "graph_suggestion_dismiss",
            serde_json::json!({ "id": suggestion_id }),
        )
        .await
        .expect("graph_suggestion_dismiss should be exposed");
        assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(true));
    }

    // ── P2 3단계: 링크 후행 제안 (docs/PLAN-2026-08-07-second-brain.md Q5) ─────────────────────
    // link_suggestions_active(ai_enabled && link_suggestions) 게이트는 이 테스트 바이너리처럼
    // 둘 다 기본 OFF인 새 DB에서 외부 fetch/AI 호출에 닿기 전에 즉시 반환한다 — 그래서 이 테스트는
    // 네트워크나 모델 없이도 결정적으로 통과한다("네트워크·모델 실호출 테스트 금지" 조건을 만족).

    #[tokio::test]
    async fn link_suggest_is_a_silent_noop_when_the_opt_in_gate_is_off() {
        let (_data_dir, app) = mock_app_with_state();
        let state = app.state::<crate::commands::AppState>();
        let note_id = {
            let mut conn = state.db.lock();
            let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
            let folder_id: String = conn
                .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws_id], |r| r.get(0))
                .unwrap();
            crate::repo::notes::create(&mut conn, &folder_id, Some("링크 테스트".into()), Some(2026))
                .unwrap()
                .note
                .id
        };

        // 옵트인 게이트가 기본 OFF인 새 DB — 존재하지 않는 호스트를 줘도(네트워크가 실제로 시도됐다면
        // 반드시 실패했을 URL) 게이트가 fetch 전에 막으므로 에러가 나지 않는다.
        let out = super::dispatch::dispatch(
            app.handle(),
            "link_suggest",
            serde_json::json!({ "note_id": note_id, "url": "https://this-host-does-not-exist.invalid/page" }),
        )
        .await
        .expect("gate-off must be a quiet no-op, not an error");
        assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(false), "{out:?}");

        // ai_enabled 단독으로는 부족 — link_suggestions 까지 켜져야 게이트를 지난다(semantic_index
        // 와 동일한 이중 플래그 규칙).
        super::dispatch::dispatch(
            app.handle(),
            "settings_set",
            serde_json::json!({ "entries": { "ai_enabled": true } }),
        )
        .await
        .expect("settings_set should accept ai_enabled");
        let still_off = super::dispatch::dispatch(
            app.handle(),
            "link_suggest",
            serde_json::json!({ "note_id": note_id, "url": "https://this-host-does-not-exist.invalid/page" }),
        )
        .await
        .expect("ai_enabled alone must still no-op, not error");
        assert_eq!(still_off.get("ok").and_then(|v| v.as_bool()), Some(false), "{still_off:?}");

        let count: i64 = {
            let conn = state.db.lock();
            conn.query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count, 0, "gate-off must never create a suggestion row");
    }

    // ── P3 수집 관문 (docs/PLAN-2026-08-07-second-brain.md Q6) ─────────────────────────────────

    #[tokio::test]
    async fn collect_source_commands_are_unreachable_through_remote_dispatch() {
        let (_data_dir, app) = mock_app_with_state();
        for command in [
            "collect_source_list",
            "collect_source_set_enabled",
            "collect_source_delete",
            "collect_source_run_now",
            "collect_source_add_nl",
        ] {
            let err = super::dispatch::dispatch(app.handle(), command, serde_json::json!({})).await.unwrap_err();
            assert!(matches!(err, super::dispatch::DispatchError::UnknownCommand), "{command}: {err:?}");
        }
    }
