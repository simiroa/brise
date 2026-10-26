// 안전 — 이스케이프·불법 글자·상한·검증·변형 입력, 그리고 오너가 Word 로 열어 보는 샘플 writer.
use super::structure::assert_docx_consistent;
use super::*;

#[test]
fn hostile_text_is_escaped_and_xml_illegal_characters_are_dropped() {
    let nasty = "a\u{1}b\u{8}c\u{b}\u{c}\u{fffe}\u{ffff}d &amp; <b>x</b> \"q\" 'r' ]]> &#1;";
    let para = json!({ "type": "paragraph", "content": [{ "type": "text", "text": nasty }, { "type": "text", "marks": [{ "type": "textStyle", "attrs": { "color": "red\" onclick=\"x" } }], "text": "색" }] });
    let img = json!({ "type": "paragraph", "content": [{ "type": "image", "attrs": { "relPath": "n1/a.png", "alt": "a\"b<c>&\u{2}d", "width": "50%" } }] });
    let link = json!({ "type": "paragraph", "content": [{ "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://a.example/?q=\"><x>&y=1" } }], "text": "L" }] });
    let b = build("제<목>&\u{1}", &[sec("s\u{1}\"", vec![para, img, link])], Paper::A4Portrait, &|_| Some(png_bytes())).unwrap();
    // 모든 XML 부품이 잘 형성되고 불법 글자가 없다(검사기가 확인).
    assert_docx_consistent(&b.bytes);
    let d = document(&b);
    assert!(d.contains("abcd &amp;amp; &lt;b&gt;x&lt;/b&gt; \"q\" 'r' ]]&gt; &amp;#1;"), "{d}");
    assert!(d.contains(r#"descr="a&quot;b&lt;c&gt;&amp;d""#), "{d}");
    // 글자색은 CSS 색 파서를 통과한 것만 — 속성 주입이 안 된다.
    assert!(!d.contains("onclick"));
    assert!(part(&b.bytes, "docProps/core.xml").contains("<dc:title>제&lt;목&gt;&amp;</dc:title>"));
    // 링크 대상의 따옴표·꺾쇠·& 는 관계 속성에서 이스케이프된다.
    let rels = part(&b.bytes, "word/_rels/document.xml.rels");
    assert!(rels.contains(r#"Target="https://a.example/?q=&quot;&gt;&lt;x&gt;&amp;y=1""#), "{rels}");
}

#[test]
fn pathological_text_never_breaks_the_document_xml() {
    // 경계 글자·긴 글·빈 글·공백만 있는 글.
    for text in ["", " ", "\t", "\n", "\r\n", "   앞뒤 공백   ", "😀 emoji \u{10FFFF}", &"가".repeat(5_000)] {
        let b = build_doc(vec![json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] }), json!({ "type": "codeBlock", "content": [{ "type": "text", "text": text }] })]);
        assert_docx_consistent(&b.bytes);
    }
}

#[test]
fn deeply_nested_documents_fail_validation_instead_of_overflowing_the_stack() {
    let mut node = p("깊다");
    for _ in 0..200 {
        node = json!({ "type": "blockquote", "content": [node] });
    }
    let err = build("t", &[sec("s", vec![node])], Paper::A4Portrait, &no_images).err().unwrap();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    // 얕은 중첩은 된다.
    let mut ok = p("얕다");
    for _ in 0..10 {
        ok = json!({ "type": "blockquote", "content": [ok] });
    }
    assert!(build("t", &[sec("s", vec![ok])], Paper::A4Portrait, &no_images).is_ok());
}

#[test]
fn deeply_nested_lists_fail_validation_instead_of_overflowing_the_stack() {
    // 목록 안 목록은 `block` 을 거치지 않고 재귀한다 — 깊이 예산이 없으면 ~1000단에서 스택 오버플로로 프로세스가 죽는다.
    // 깊은 `Value` 를 만들고 버리는 것도 재귀라 넉넉한 스택의 스레드에서 돌린다.
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(|| {
            for kind in ["bulletList", "orderedList", "taskList"] {
                let err = build("t", &[sec("s", vec![nested_lists(kind, 1500)])], Paper::A4Portrait, &no_images).err().unwrap();
                assert!(matches!(err, AppError::Validation(_)), "{kind}: {err:?}");
            }
            // 얕은 중첩은 된다 — 수준은 ilvl 8 에서 멈춘다.
            let b = build("t", &[sec("s", vec![nested_lists("bulletList", 20)])], Paper::A4Portrait, &no_images).unwrap();
            assert_docx_consistent(&b.bytes);
            assert!(attr_vals(&document(&b), "ilvl", "val").iter().all(|v| v.parse::<usize>().unwrap() <= 8));
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn too_many_numbered_lists_are_rejected_instead_of_bloating_numbering_xml() {
    let list = |t: &str| json!({ "type": "orderedList", "attrs": { "start": 1 }, "content": [{ "type": "listItem", "content": [p(t)] }] });
    let many: Vec<Value> = (0..=MAX_NUMS).map(|i| list(&i.to_string())).collect();
    let err = build("t", &[sec("s", many)], Paper::A4Portrait, &no_images).err().unwrap();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    let some: Vec<Value> = (0..50).map(|i| list(&i.to_string())).collect();
    assert_docx_consistent(&build("t", &[sec("s", some)], Paper::A4Portrait, &no_images).unwrap().bytes);
}

#[test]
fn a_pathological_table_grid_is_rejected() {
    let cell = json!({ "type": "tableCell", "attrs": { "colspan": 200, "rowspan": 1000 }, "content": [p("x")] });
    let rows: Vec<Value> = (0..1000).map(|_| json!({ "type": "tableRow", "content": [cell.clone()] })).collect();
    let err = build("t", &[sec("s", vec![json!({ "type": "table", "content": rows })])], Paper::A4Portrait, &no_images).err().unwrap();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
}

/// Word 표는 열이 63개까지다 — 넘는 표를 쓰면 파일을 못 읽는다고 보고된다. 거절하고, 63열은 그대로 쓰되 표 폭이 Word 의 폭 한계(22인치 = 31680 twips)를 넘지 않는다.
#[test]
fn tables_over_words_63_column_limit_are_rejected_and_63_columns_stay_within_word_width() {
    let row = |n: usize| trow((0..n).map(|i| tcell(&i.to_string(), 1, 1, Value::Null)).collect());
    let try_build = |t: Value| build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images);
    for n in [64usize, 100, 200] {
        let err = try_build(table_of(vec![row(n)])).err().unwrap();
        assert!(matches!(err, AppError::Validation(_)), "{n}: {err:?}");
    }
    // 칸 하나가 64열을 덮는 병합도 격자는 64열이다.
    let wide_span = trow(vec![tcell("병합", 64, 1, Value::Null)]);
    assert!(matches!(try_build(table_of(vec![wide_span])), Err(AppError::Validation(_))));
    // 표 안의 표도 같은 상한을 받는다.
    let nested = json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1 }, "content": [table_of(vec![row(64)])] });
    assert!(matches!(try_build(table_of(vec![trow(vec![nested])])), Err(AppError::Validation(_))));

    let b = try_build(table_of(vec![row(63), row(63)])).unwrap();
    assert_docx_consistent(&b.bytes);
    let d = document(&b);
    assert_eq!(count(&d, "gridCol"), 63, "{d}");
    let w: i64 = attr_vals(&d, "tblW", "w")[0].parse().unwrap();
    assert!(w <= 31_680, "table width {w} twips is over Word's 22in table limit");
}

#[test]
fn rows_without_cells_and_empty_tables_do_not_crash() {
    let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [] }] });
    let t2 = json!({ "type": "table" });
    let b = build("t", &[sec("s", vec![t, t2, p("뒤")])], Paper::A4Portrait, &no_images).unwrap();
    assert_docx_consistent(&b.bytes);
}

#[test]
fn invalid_inputs_are_validation_errors() {
    let ok = sec("s", vec![p("x")]);
    assert!(matches!(build("t", &[], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
    let not_doc = DocExportSection { name: "n".into(), doc: json!({ "type": "paragraph" }) };
    assert!(matches!(build("t", &[ok.clone(), not_doc], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
    let null_doc = DocExportSection { name: "n".into(), doc: Value::Null };
    assert!(matches!(build("t", &[null_doc], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
    let many: Vec<DocExportSection> = (0..=MAX_SECTIONS).map(|_| ok.clone()).collect();
    assert!(matches!(build("t", &many, Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
}

#[test]
fn unknown_nodes_keep_their_text_and_missing_attributes_are_tolerated() {
    let weird = json!({ "type": "somethingNew", "content": [p("펼쳐진 문단")] });
    let weird_leaf = json!({ "type": "mystery", "text": "글자" });
    let bare = json!({ "type": "paragraph" });
    let nulls = json!({ "type": "heading", "attrs": { "level": null, "textAlign": null, "indent": null }, "content": [{ "type": "text", "text": "널" }] });
    let inline_unknown = json!({ "type": "paragraph", "content": [{ "type": "emoji", "text": "😀" }, { "type": "text", "text": "끝" }] });
    let b = build_doc(vec![weird, weird_leaf, bare, nulls, inline_unknown]);
    let d = document(&b);
    for need in ["펼쳐진 문단", "글자", "널", "😀끝"] {
        assert!(d.contains(need), "{need} in {d}");
    }
    assert_docx_consistent(&b.bytes);
}

/// 실제 덤프의 값을 결정적으로 무작위 변형(null · 숫자 · 문자열 · 빈 배열 · 키 삭제)해도 panic 하지 않는다 — Ok 든 VALIDATION 이든 좋다.
#[test]
fn mutated_documents_never_panic() {
    let base: Value = serde_json::from_str(REAL_PM).unwrap();
    let mut rng = 0x9E37_79B9_7F4A_7C15u64;
    let (mut ok, mut rejected) = (0, 0);
    for _ in 0..250 {
        let mut doc = base.clone();
        mutate(&mut doc, &mut rng, 0);
        let sections = [DocExportSection { name: "n".into(), doc }];
        match build("t", &sections, Paper::A4Portrait, &real_resolver) {
            Ok(b) => {
                ok += 1;
                // 구조 검사는 무겁다 — 열 번에 한 번만. 변형이 만든 어떤 문서도 구조(순서 · 격자 · 칸 끝 · 참조)는 깨지지 않아야 한다.
                if ok % 10 == 1 {
                    assert_docx_consistent(&b.bytes);
                }
            }
            Err(AppError::Validation(_)) => rejected += 1,
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }
    assert!(ok > 50, "ok={ok} rejected={rejected}");
}

// ── 샘플 ──────────────────────────────────────────────────────────────────────

/// 오너가 Word(또는 LibreOffice)로 열어 보는 샘플을 쓴다 —
/// `DOCX_EXPORT_SAMPLE_OUT=<경로>.docx cargo test --lib doc_export::docx::tests::safety::write_sample -- --ignored`.
/// 경로 파일(세로, 이력서식 병합 표 + 제목 + 본문 + 목록, 그림 없음) 외에 옆에 `-landscape`(가로), `-picture`(그림 포함) 변형도 쓴다.
/// 문서는 HWPX 샘플과 같은 것(`testutil::sample_main`) — 두 형식을 나란히 열어 비교한다.
#[test]
#[ignore = "writes sample files for manual inspection in a viewer; set DOCX_EXPORT_SAMPLE_OUT"]
fn write_sample() {
    let Ok(out) = std::env::var("DOCX_EXPORT_SAMPLE_OUT") else {
        panic!("set DOCX_EXPORT_SAMPLE_OUT to the .docx path to write");
    };
    let out = std::path::PathBuf::from(out);
    let main = sample_main("DOCX");
    let write = |path: &std::path::Path, secs: &[DocExportSection], paper: Paper, resolve: &crate::repo::doc_export::Resolver<'_>| {
        let built = build("Brise 내보내기 샘플", secs, paper, resolve).unwrap();
        assert_docx_consistent(&built.bytes);
        std::fs::write(path, &built.bytes).unwrap();
        println!("wrote {} ({} bytes, {} images)", path.display(), built.bytes.len(), built.image_count);
    };
    write(&out, std::slice::from_ref(&main), Paper::A4Portrait, &no_images);
    let stem = out.file_stem().unwrap().to_string_lossy().into_owned();
    write(&out.with_file_name(format!("{stem}-landscape.docx")), std::slice::from_ref(&main), Paper::A4Landscape, &no_images);
    write(&out.with_file_name(format!("{stem}-picture.docx")), &[sample_picture()], Paper::A4Portrait, &|_| Some(sample_png()));
}
