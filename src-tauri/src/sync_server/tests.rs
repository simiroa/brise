// sync_server::tests — R4: mod.rs 본문에서 분리된 통합 테스트. 핸들러 본체는 handlers/*.rs(2026-10-07 분리). 파일 기반
// 서브모듈이라 super:: 의미는 인라인 mod tests {} 와 동일(sync_server가 부모).
    use super::*;
    use crate::db;

    /// 통합 테스트 — 임시 디렉토리 + 포트 0(OS가 빈 포트 배정)으로 실제 서버를 띄우고
    /// /api/v1/ping 에 토큰으로 접근한다(rt-multi-thread + macros 는 이미 dev-dependencies).
    #[tokio::test]
    async fn ping_roundtrip_with_token_over_a_real_bound_port() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        // 서버 태스크가 accept 루프에 들어갈 시간을 준다(포트는 이미 bind()에서 열려 있으므로
        // 연결 자체는 즉시 되지만, 첫 실제 요청이 리스너 진입 타이밍과 경합하지 않게 짧게 양보).
        tokio::task::yield_now().await;

        let client = reqwest::Client::new();
        let ok = client
            .get(format!("http://{addr}/api/v1/ping?token=tok123"))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        let body: serde_json::Value = ok.json().await.unwrap();
        assert!(body.get("schema_version").and_then(|v| v.as_i64()).unwrap_or(0) > 0);

        let denied = client
            .get(format!("http://{addr}/api/v1/ping?token=wrong"))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), 401);

        handle.abort();
    }

    /// /api/v1/attachments/{note_id}/{*file} 는 라우트 정의 자체가 가장 다루기 까다로운 부분
    /// (wildcard tail + 튜플 Path 추출) — repo::paths::safe_rel 단위 테스트만으로는 이 라우트가
    /// 실제로 요청을 handler까지 도달시키는지 전혀 검증하지 못한다(추출이 깨지면 axum이 그 전에
    /// PathRejection으로 튕기는데, 그건 별개의 실패 모드). 여기서 실제 HTTP 왕복으로 둘 다 검증.
    #[tokio::test]
    async fn attachment_roundtrip_and_path_traversal_over_a_real_bound_port() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let note_dir = db::attachments_dir(data_dir.path()).join("note1");
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(note_dir.join("photo.png"), b"fake-png-bytes").unwrap();

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let ok = client
            .get(format!("http://{addr}/api/v1/attachments/note1/photo.png?token=tok123"))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200, "the wildcard route must actually reach the handler");
        assert_eq!(ok.bytes().await.unwrap().as_ref(), b"fake-png-bytes");

        // brise.db 자체를 이탈해서 훔쳐보려는 시도 — percent-decode 된 "../../brise.db"가
        // safe_rel 을 통과하면 안 된다. 정확한 상태코드는 axum/hyper가 경로를 정규화하는
        // 단계에 따라 400/404 어느 쪽도 나올 수 있어 "200이 아님"만 단언한다.
        let escape = client
            .get(format!("http://{addr}/api/v1/attachments/note1/..%2f..%2fbrise.db?token=tok123"))
            .send()
            .await
            .unwrap();
        assert_ne!(escape.status(), 200, "path traversal must never return the escaped file");
        let body = escape.text().await.unwrap();
        assert!(!body.contains("SQLite format"), "must never leak brise.db contents");

        handle.abort();
    }

    #[tokio::test]
    async fn attachment_with_accept_encoding_gzip_is_not_compressed_and_keeps_accept_ranges() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let note_dir = db::attachments_dir(data_dir.path()).join("note1");
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(note_dir.join("video.mp4"), b"fake-video-bytes-for-ranges").unwrap();

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .get(format!("http://{addr}/api/v1/attachments/note1/video.mp4?token=tok123"))
            .header("Accept-Encoding", "gzip")
            .send()
            .await
            .unwrap();

        assert_eq!(res.status(), 200);
        assert_eq!(res.headers().get("accept-ranges").and_then(|v| v.to_str().ok()), Some("bytes"));
        assert!(res.headers().get("content-encoding").is_none());

        handle.abort();
    }


    /// GET /api/v1/notes' feed-card fields (excerpt/tags/checklist/thumb) — all three batch
    /// helpers (sections::load_for_ids, notes::tag_refs_for_ids, attachments::load_for_ids) wired
    /// together correctly, not just individually unit-tested.
    #[tokio::test]
    async fn notes_list_returns_excerpt_tags_checklist_and_thumb() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("Feed card".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        let overview_id = detail.sections[0].id.clone();

        // excerpt: first section's body, tags stripped and whitespace collapsed.
        crate::repo::sections::update(
            &mut conn,
            &overview_id,
            None,
            Some("<p>Hello <strong>world</strong>   with   extra space</p>".to_string()),
            None,
        )
        .unwrap();
        // second section carries a checklist — exact markup tiptap's TaskList/TaskItem emit
        // (mdSerialize.test.ts), one done + one not done.
        crate::repo::sections::create_with_body(
            &mut conn,
            &note_id,
            Some("Tasks".to_string()),
            "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Done thing</p></div></li><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Not done</p></div></li></ul>".to_string(),
        )
        .unwrap();
        crate::repo::notes::set_tags(&mut conn, &note_id, vec!["Alpha".to_string(), "Beta".to_string()]).unwrap();
        // A doc attachment first (position 0), an image second (position 1) — thumb must pick the
        // image specifically, not just whatever attachment happens to be first.
        let now = crate::util::now_iso();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, size_bytes, position, created_at)
             VALUES ('att-doc', ?1, 'notes.txt', 'doc', ?1 || '/notes.txt', 10, 0, ?2)",
            rusqlite::params![note_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, size_bytes, position, created_at)
             VALUES ('att-img', ?1, 'photo.png', 'image', ?1 || '/photo.png', 10, 1, ?2)",
            rusqlite::params![note_id, now],
        )
        .unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client.get(format!("http://{addr}/api/v1/notes?token=tok123")).send().await.unwrap();
        assert_eq!(res.status(), 200);
        let body: serde_json::Value = res.json().await.unwrap();
        let note = body["notes"].as_array().unwrap().iter().find(|n| n["id"] == note_id).unwrap();

        assert_eq!(note["excerpt"], "Hello world with extra space");

        let tag_names: Vec<String> =
            note["tags"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(tag_names, vec!["Alpha", "Beta"]);
        assert!(!note["tags"][0]["id"].as_str().unwrap().is_empty(), "tag rows must carry an id, not just a name");

        assert_eq!(note["checklist"]["total"], 2);
        assert_eq!(note["checklist"]["done"], 1);
        let items = note["checklist"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["text"], "Done thing");
        assert_eq!(items[0]["checked"], true);
        assert_eq!(items[0]["index"], 0);
        assert_eq!(items[1]["text"], "Not done");
        assert_eq!(items[1]["checked"], false);
        assert_eq!(items[1]["index"], 1);

        assert_eq!(note["thumb"], format!("{note_id}/photo.png"), "thumb must pick the first IMAGE attachment, not the first attachment overall");

        handle.abort();
    }

    /// Item 12: notes_list must honor an explicit `limit` query param and report `has_more` —
    /// regression guard for the "no LIMIT at all, batch-loads every note's full sections" bug.
    /// Creates 5 notes, asks for a page of 3, and checks both the item count and the flag (in
    /// both directions: a page that exactly reaches the end must NOT claim has_more).
    #[tokio::test]
    async fn notes_list_honors_limit_and_reports_has_more() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        for i in 0..5 {
            crate::repo::notes::create_today_default(&mut conn, &folder_id, Some(format!("Note {i}")), None, None, None).unwrap();
        }
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let page1 = client
            .get(format!("http://{addr}/api/v1/notes?token=tok123&limit=3"))
            .send()
            .await
            .unwrap();
        assert_eq!(page1.status(), 200);
        let body1: serde_json::Value = page1.json().await.unwrap();
        assert_eq!(body1["notes"].as_array().unwrap().len(), 3, "limit=3 must cap the page at 3 items");
        assert_eq!(body1["has_more"], true, "5 notes with limit=3 must report more remaining");

        let page2 = client
            .get(format!("http://{addr}/api/v1/notes?token=tok123&limit=10"))
            .send()
            .await
            .unwrap();
        let body2: serde_json::Value = page2.json().await.unwrap();
        assert_eq!(body2["notes"].as_array().unwrap().len(), 5, "limit=10 with only 5 notes must return all of them");
        assert_eq!(body2["has_more"], false, "a page that reaches the end must not claim has_more");

        handle.abort();
    }

    /// Item 12: the checklist section-scan bound must survive the move to repo::notes::feed_page
    /// (load_first_n_sections_for_ids) — a checklist in the 3rd section must NOT surface in the
    /// feed (same CHECKLIST_SECTION_SCAN_LIMIT=2 contract the old sections::load_for_ids-based
    /// code had, now enforced in SQL instead of loaded-then-truncated in Rust).
    #[tokio::test]
    async fn notes_list_still_bounds_checklist_scan_to_first_two_sections_after_feed_page_move() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("Buried checklist".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        // Sections 2 and 3 (0-based: the note already has 1 section from creation, so these are
        // the note's 2nd and 3rd sections) — checklist only in the 3rd, past the scan bound.
        crate::repo::sections::create_with_body(&mut conn, &note_id, Some("Second".to_string()), "<p>no checklist here</p>".to_string()).unwrap();
        crate::repo::sections::create_with_body(
            &mut conn,
            &note_id,
            Some("Third".to_string()),
            "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Buried task</p></div></li></ul>".to_string(),
        )
        .unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client.get(format!("http://{addr}/api/v1/notes?token=tok123")).send().await.unwrap();
        let body: serde_json::Value = res.json().await.unwrap();
        let note = body["notes"].as_array().unwrap().iter().find(|n| n["id"] == note_id).unwrap();
        assert!(note["checklist"].is_null(), "a checklist past the scan bound (3rd section) must not surface in the feed");

        handle.abort();
    }

    /// POST /api/v1/notes/{id}/checklist must find the right *section* for a cross-section ordinal
    /// (index counts checkboxes across all sections in position order), flip only that one, and
    /// persist through the same repo::sections::update path PUT uses — updated_at bump and FTS
    /// resync are the proof (same assertions note_update_writes_title_and_section_body_through_
    /// desktop_repo_functions above uses for PUT).
    #[tokio::test]
    async fn checklist_toggle_flips_the_right_ordinal_across_two_sections_and_persists() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("Toggle test".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        let overview_id = detail.sections[0].id.clone();
        let updated_at_before = detail.note.updated_at.clone();

        // section 0 (Overview): one item -> global index 0.
        crate::repo::sections::update(
            &mut conn,
            &overview_id,
            None,
            Some("<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Buy milk</p></div></li></ul>".to_string()),
            None,
        )
        .unwrap();
        // section 1 (More): two items -> global index 1 (checked) and 2 (unchecked).
        let second = crate::repo::sections::create_with_body(
            &mut conn,
            &note_id,
            Some("More".to_string()),
            "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Task A</p></div></li><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Task B</p></div></li></ul>".to_string(),
        )
        .unwrap();
        let second_id = second.id.clone();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        // Toggle global index 2 ("Task B", the 2nd item of the *2nd* section) on.
        let res = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/checklist?token=tok123"))
            .json(&serde_json::json!({ "index": 2, "checked": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: serde_json::Value = res.json().await.unwrap();
        assert_ne!(body["note"]["updated_at"], updated_at_before, "updated_at must be bumped like the desktop repo path");

        // section 0's own item (index 0) and section 1's other item (index 1, "Task A") must be
        // untouched — a wrong-ordinal bug would flip one of these instead of index 2.
        let verify_conn = db::open(&db::db_path(data_dir.path())).unwrap();
        let overview_body: String =
            verify_conn.query_row("SELECT body_md FROM sections WHERE id=?1", [&overview_id], |r| r.get(0)).unwrap();
        let more_body: String =
            verify_conn.query_row("SELECT body_md FROM sections WHERE id=?1", [&second_id], |r| r.get(0)).unwrap();
        assert!(overview_body.contains("data-checked=\"false\""), "section 0's own item (index 0) must be untouched");
        assert!(
            more_body.contains("<li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Task A</p>"),
            "Task A (index 1) must stay checked and untouched"
        );
        assert!(
            more_body.contains("<li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Task B</p>"),
            "Task B (index 2) must now be checked"
        );

        // FTS row must be resynced too (repo::sections::update's fts_upsert call), not just the
        // sections table.
        let fts_body: String =
            verify_conn.query_row("SELECT body FROM notes_fts WHERE note_id=?1", [&note_id], |r| r.get(0)).unwrap();
        assert!(fts_body.contains(&more_body), "FTS body must reflect the just-toggled section body");

        handle.abort();
    }

    #[tokio::test]
    async fn checklist_toggle_rejects_out_of_range_index() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        let overview_id = detail.sections[0].id.clone();
        crate::repo::sections::update(
            &mut conn,
            &overview_id,
            None,
            Some("<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Only item</p></div></li></ul>".to_string()),
            None,
        )
        .unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/checklist?token=tok123"))
            .json(&serde_json::json!({ "index": 1, "checked": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "only one checkbox exists (index 0) — index 1 must be rejected");

        handle.abort();
    }

    /// Same 404 asymmetry as GET/PUT above (unknown id, and a trashed note must not be writable
    /// through this endpoint either).
    #[tokio::test]
    async fn checklist_toggle_404s_for_unknown_and_trashed_notes() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        crate::repo::notes::delete(&mut conn, &detail.note.id).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let missing = client
            .post(format!("http://{addr}/api/v1/notes/does-not-exist/checklist?token=tok123"))
            .json(&serde_json::json!({ "index": 0, "checked": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), 404);

        let trashed = client
            .post(format!("http://{addr}/api/v1/notes/{}/checklist?token=tok123", detail.note.id))
            .json(&serde_json::json!({ "index": 0, "checked": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(trashed.status(), 404);

        handle.abort();
    }

    /// Item 16: POST /api/v1/notes/{note_id}/attachments happy path — must go through the real
    /// repo::attachments::add_file path (desktop parity), which this test proves indirectly: the
    /// returned attachment's `kind` is derived from the filename extension (not hardcoded "doc"
    /// the way a naive temp-path-passthrough bug would produce — see the advisor note this task
    /// caught: a bare `uuid.tmp` staging path would misclassify every upload as kind="doc"), and
    /// the row round-trips into the note's own NoteDetail.attachments (item 17's existing field).
    #[tokio::test]
    async fn attachment_upload_lands_through_the_desktop_add_file_path_with_correct_kind() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("Attach me".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/attachments?token=tok123&filename=photo.png"))
            .body(vec![0xFFu8; 128]) // not real PNG bytes — thumbnail generation may fail, that's fine
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 201);
        let att: serde_json::Value = res.json().await.unwrap();
        assert_eq!(att["kind"], "image", "kind must be derived from the .png extension, not hardcoded from a temp path");
        assert_eq!(att["name"], "photo.png");
        assert!(att["rel_path"].as_str().unwrap().starts_with(&format!("{note_id}/")));

        // Round-trips into the note detail's attachments array (item 17 — already-existing field).
        // GET /api/v1/notes/{id} (the single-note REST handler) was removed as dead REST CRUD
        // (zero clients — web/mobile use invoke only), so verify through the same repo function
        // it used to call, directly against the DB.
        let verify_conn = db::open(&db::db_path(data_dir.path())).unwrap();
        let note_detail = crate::repo::notes::note_detail(&verify_conn, &note_id).unwrap();
        assert_eq!(note_detail.attachments.len(), 1);
        assert_eq!(note_detail.attachments[0].id, att["id"].as_str().unwrap());

        handle.abort();
    }

    #[tokio::test]
    async fn attachment_upload_rejects_wrong_token_and_trashed_note() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        crate::repo::notes::delete(&mut conn, &note_id).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let wrong_token = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/attachments?token=wrong&filename=a.txt"))
            .body(vec![1u8, 2, 3])
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_token.status(), 401);

        let trashed = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/attachments?token=tok123&filename=a.txt"))
            .body(vec![1u8, 2, 3])
            .send()
            .await
            .unwrap();
        assert_eq!(trashed.status(), 404, "uploading to a trashed note must be rejected like every other write endpoint");

        handle.abort();
    }

    /// Item 16 size cap — the route-level DefaultBodyLimit override (ATTACHMENT_UPLOAD_MAX_BYTES)
    /// must actually reject an oversize body with 413, not silently truncate or 500. Advisor's
    /// specific catch: assert the real status the test observes, don't assume axum's behavior.
    #[tokio::test]
    async fn attachment_upload_rejects_oversize_body_with_413() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let oversize = vec![0u8; 26 * 1024 * 1024]; // > 25MB cap
        let res = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/attachments?token=tok123&filename=big.bin"))
            .body(oversize)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 413);

        handle.abort();
    }

    /// POST /api/v1/invoke requires auth like every other endpoint here — even though app_handle
    /// is None in this harness (so an authorized call would 503, tested separately below), a
    /// *wrong* token must still be rejected before dispatch is ever considered.
    #[tokio::test]
    async fn invoke_rejects_wrong_token() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .post(format!("http://{addr}/api/v1/invoke?token=wrong"))
            .json(&serde_json::json!({ "cmd": "settings_get_all", "args": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);

        handle.abort();
    }

    /// With a valid token but no live AppHandle (this harness's None, same as production code
    /// would never see but the None-app_handle test/dev path does) there is nothing to dispatch
    /// against — 503, not a crash and not silently 200.
    #[tokio::test]
    async fn invoke_returns_503_without_a_live_app_handle() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .post(format!("http://{addr}/api/v1/invoke?token=tok123"))
            .json(&serde_json::json!({ "cmd": "settings_get_all", "args": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 503);

        handle.abort();
    }

    /// settings_set is blocked from touching sync_* keys even before app_handle is checked —
    /// the denylist in handlers::invoke must fire first (400), not fall through to the 503 an
    /// app_handle-less harness would otherwise return for every other command.
    #[tokio::test]
    async fn invoke_blocks_settings_set_of_sync_keys_before_dispatch() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .post(format!("http://{addr}/api/v1/invoke?token=tok123"))
            .json(&serde_json::json!({ "cmd": "settings_set", "args": { "entries": { "sync_enabled": true } } }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let body: serde_json::Value = res.json().await.unwrap();
        assert!(body["error"].as_str().unwrap().contains("sync_enabled"));

        handle.abort();
    }

    /// Item 3: settings_set must also block the four AI provider keys, not just sync_* — a
    /// leaked sync_token could otherwise persistently repoint the owner's own later local AI
    /// actions at an attacker-controlled endpoint. Exercised per-key over a real HTTP round trip
    /// (not just the pure-function unit test in handlers.rs) so the wiring itself is covered too.
    #[tokio::test]
    async fn invoke_blocks_settings_set_of_ai_provider_keys_before_dispatch() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        for (key, value) in [
            ("ai_provider", serde_json::json!("openai")),
            ("ai_endpoint", serde_json::json!("https://attacker.example/v1")),
            ("ai_api_key", serde_json::json!("sk-attacker")),
            ("ai_enabled", serde_json::json!(true)),
        ] {
            let res = client
                .post(format!("http://{addr}/api/v1/invoke?token=tok123"))
                .json(&serde_json::json!({ "cmd": "settings_set", "args": { "entries": { key: value } } }))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 400, "{key} must be rejected");
            let body: serde_json::Value = res.json().await.unwrap();
            assert!(body["error"].as_str().unwrap().contains(key), "{key}: error message must name the blocked key");
        }

        handle.abort();
    }

    /// GET /api/v1/events (SSE) requires the same auth as every other endpoint.
    #[tokio::test]
    async fn events_rejects_wrong_token() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let res = client
            .get(format!("http://{addr}/api/v1/events?token=wrong"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);

        handle.abort();
    }

    /// SSE round trip: connect to /api/v1/events, trigger a write via the checklist-toggle
    /// endpoint (works with app_handle=None — it hand-rolls repo calls same as the deleted note
    /// create/update REST handlers used to, and the broadcast channel is independent of the Tauri
    /// app emit, see handlers::emit_remote_write), and assert the "remote-note-write" payload
    /// actually arrives on the stream.
    #[tokio::test]
    async fn events_stream_delivers_remote_note_write_on_a_write() {
        use futures_util::StreamExt;

        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("SSE 트리거 테스트".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id.clone();
        let overview_id = detail.sections[0].id.clone();
        crate::repo::sections::update(
            &mut conn,
            &overview_id,
            None,
            Some("<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Buy milk</p></div></li></ul>".to_string()),
            None,
        )
        .unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let sse_res = client
            .get(format!("http://{addr}/api/v1/events?token=tok123"))
            .send()
            .await
            .unwrap();
        assert_eq!(sse_res.status(), 200);
        let mut byte_stream = sse_res.bytes_stream();

        // Give the SSE handler's subscribe() a moment to register before the write fires, so the
        // broadcast isn't sent to zero receivers.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let toggle_res = client
            .post(format!("http://{addr}/api/v1/notes/{note_id}/checklist?token=tok123"))
            .json(&serde_json::json!({ "index": 0, "checked": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(toggle_res.status(), 200);

        // Read chunks off the stream until we see the *named* SSE frame (keep-alive comments may
        // interleave first). Regression guard for the P0 bug: SseEvent::default().data(payload)
        // (no .event(...)) dispatches as the unnamed "message" type even though the JSON payload
        // itself contains the string "remote-note-write" inside `"event":"remote-note-write"` —
        // asserting on that substring alone passed even when the frame was never named. The wire
        // format's `event: <name>` line (with the space, colon-space) is what the frontend's
        // `EventSource.addEventListener("remote-note-write", ...)` actually keys off, so that is
        // what must be asserted here.
        let found = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut buf = String::new();
            while let Some(chunk) = byte_stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                if buf.contains("event: remote-note-write") {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(found, "expected an SSE frame with the named event type `event: remote-note-write`, not just the string somewhere in a data payload");

        handle.abort();
    }

    /// Item 11: SSE subscriber cap. Opens MAX_SSE_SUBSCRIBERS (8) connections and holds them open
    /// (by keeping their `Response` objects alive — dropping a reqwest::Response's underlying
    /// connection is what would let the server-side SseSlotGuard decrement), then asserts the 9th
    /// concurrent connection gets 503 rather than exhausting sockets. A buggy retry loop or a
    /// leaked token could otherwise open unbounded SSE connections.
    #[tokio::test]
    async fn events_stream_rejects_the_9th_concurrent_subscriber_with_503() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let mut held: Vec<reqwest::Response> = Vec::new();
        for _ in 0..8 {
            let res = client.get(format!("http://{addr}/api/v1/events?token=tok123")).send().await.unwrap();
            assert_eq!(res.status(), 200);
            held.push(res); // kept alive so the connection (and the server-side slot) stays open
        }

        let ninth = client.get(format!("http://{addr}/api/v1/events?token=tok123")).send().await.unwrap();
        assert_eq!(ninth.status(), 503, "the 9th concurrent SSE subscriber must be rejected, not accepted unbounded");

        // Dropping one held connection frees a slot — the next connection attempt must succeed
        // again (proves the cap is a live counter, not a one-shot "server is now permanently full").
        held.truncate(7);
        // Give the server a moment to notice the dropped connection and run SseSlotGuard::drop.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let after_free = client.get(format!("http://{addr}/api/v1/events?token=tok123")).send().await.unwrap();
        assert_eq!(after_free.status(), 200, "freeing a slot must let a new subscriber back in");

        drop(held);
        drop(after_free);
        handle.abort();
    }

    /// 토큰 재발급 드릴(2026-10-06): 서버를 멈춰도(abort = 토글-off·재발급) 이미 열린 SSE 연결이
    /// 옛 토큰으로 계속 이벤트를 받던 결함. 서버가 멈추면 열린 스트림도 끝나야 한다.
    #[tokio::test]
    async fn stopping_the_server_ends_already_open_event_streams() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let mut res = reqwest::Client::new()
            .get(format!("http://{addr}/api/v1/events?token=tok123"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);

        handle.abort();
        // 스트림이 끝나면 chunk() 가 Ok(None)/Err 로 돌아온다. 끝나지 않으면 keep-alive 만 오다 타임아웃.
        let ended = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match res.chunk().await {
                    Ok(Some(_)) => continue, // keep-alive 프레임은 무시
                    _ => break,
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "open SSE stream must end when the server is stopped");
    }

    /// /app is deliberately unauthenticated (asset requests carry no ?token=), which makes
    /// handlers::read_app_file's repo::paths::safe_rel guard the ONLY thing standing between a
    /// request and the filesystem — not defense-in-depth like on the token-gated routes. Same
    /// traversal shape as attachment_roundtrip_and_path_traversal_over_a_real_bound_port above.
    #[tokio::test]
    async fn app_route_rejects_path_traversal_out_of_dist() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        // No token at all — /app must not require one, but it must also never resolve "../" out
        // of dist/. A rejected path falls through to the SPA index.html fallback (200 is fine),
        // the only thing that must never happen is Cargo.toml's contents in the response body.
        let res = client
            .get(format!("http://{addr}/app/..%2f..%2fsrc-tauri%2fCargo.toml"))
            .send()
            .await
            .unwrap();
        let body = res.text().await.unwrap();
        assert!(!body.contains("[package]"), "path traversal must never leak Cargo.toml through /app");

        handle.abort();
    }

    /// Item 14: Cache-Control on /app static serving. A real hashed asset (dist/assets/*, vite
    /// content-hashed filename) must be cacheable forever; index.html — and critically, the SPA
    /// fallback case where a *requested* assets/foo.js doesn't exist and index.html's bytes are
    /// served in its place — must stay no-cache. Advisor's specific catch: keying "immutable"
    /// off the requested path alone (rather than "and it was actually found, not a fallback")
    /// would cache an HTML body under an asset URL for a year, unfixable by redeploy.
    #[tokio::test]
    async fn app_static_caches_real_assets_forever_but_never_the_spa_fallback() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        // A real file under dist/assets/ (debug build reads straight off disk) — pick whichever
        // one actually exists rather than hardcoding a vite content-hash that changes on rebuild.
        let dist_assets = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist").join("assets");
        let real_asset_name = std::fs::read_dir(&dist_assets)
            .ok()
            .and_then(|mut entries| entries.find_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()));

        if let Some(name) = real_asset_name {
            let res = client.get(format!("http://{addr}/app/assets/{name}")).send().await.unwrap();
            assert_eq!(res.status(), 200);
            let cc = res.headers().get(reqwest::header::CACHE_CONTROL).unwrap().to_str().unwrap();
            assert!(cc.contains("immutable"), "a real hashed asset must be cached forever, got: {cc}");
        } else {
            // dist/ not built in this environment (e.g. a fresh checkout before `npm run build`).
            // 아래 폴백 검증들도 **전부** dist/index.html 을 필요로 한다 — 없으면 서버가 404 를
            // 주고 Cache-Control 헤더가 아예 없어 unwrap 이 패닉한다. 예전 주석은 "폴백 검증은
            // 그래도 돈다" 고 적혀 있었지만 사실이 아니었고, 2026-09-01 에 dist 없는 워크트리에서
            // 이 테스트가 실제로 패닉했다. 스킵할 거면 여기서 통째로 빠져나간다.
            eprintln!("skipping asset cache assertions: dist/assets/ not found or empty");
            handle.abort();
            return;
        }

        // A requested assets/*.js that does NOT exist falls back to index.html's bytes — this
        // must NOT be cached as if it were the (nonexistent) asset.
        let missing = client.get(format!("http://{addr}/app/assets/does-not-exist-xyz.js")).send().await.unwrap();
        let cc_missing = missing.headers().get(reqwest::header::CACHE_CONTROL).unwrap().to_str().unwrap();
        assert_eq!(cc_missing, "no-cache", "a missing asset falling back to index.html must never be cached as immutable");

        // index.html itself must also be no-cache.
        let index = client.get(format!("http://{addr}/app")).send().await.unwrap();
        let cc_index = index.headers().get(reqwest::header::CACHE_CONTROL).unwrap().to_str().unwrap();
        assert_eq!(cc_index, "no-cache");

        handle.abort();
    }

    /// `/m`과 루트 `/`는 구형 모바일 뷰어 셸이 있던 자리 — 이제는 `/app`으로 307 리다이렉트만
    /// 한다. 구형 QR/북마크가 `/m?token=X` 형태로 남아 있으므로 쿼리스트링(토큰 포함)이 반드시
    /// `Location`으로 그대로 옮겨져야 한다. 인증 없이(과거 셸과 동일한 예외) 통과해야 하고,
    /// 리다이렉트 자체는 노트 데이터를 단 한 바이트도 담지 않는다(body가 비어 있음을 확인).
    #[tokio::test]
    async fn legacy_m_and_root_redirect_to_app_preserving_query_string() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        drop(conn);

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "tok123".to_string(), None).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();

        for path in ["/m", "/"] {
            let res = client
                .get(format!("http://{addr}{path}?token=tok123"))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 307, "{path} must 307-redirect, not serve a shell");
            let location = res.headers().get(reqwest::header::LOCATION).unwrap().to_str().unwrap().to_string();
            assert_eq!(location, "/app?token=tok123", "{path} must preserve the query string (token) into /app");
            let body = res.text().await.unwrap();
            assert!(body.is_empty(), "{path} redirect body must carry zero note data");
        }

        // No query string at all (bare /m) must still redirect cleanly to /app, no trailing "?".
        let bare = client.get(format!("http://{addr}/m")).send().await.unwrap();
        assert_eq!(bare.status(), 307);
        assert_eq!(bare.headers().get(reqwest::header::LOCATION).unwrap().to_str().unwrap(), "/app");

        handle.abort();
    }
