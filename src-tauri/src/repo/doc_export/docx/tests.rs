// repo: doc_export::docx 테스트 — 구조 검사기 + 매핑 + 안전 (docx.rs 끝의 설명 참고)
use super::super::testutil::{
    attr_vals, count, entries, image_node, mark, mutate, nested_lists, no_images, p, part, png_bytes, real_resolver, real_section, sample_main,
    sample_picture, sample_png, scan, sec, table_of, tcell, trow, walk, Ev, REAL_PM,
};
use super::super::xmlw::is_xml_char;
use super::super::MAX_SECTIONS;
use super::*;
use crate::error::AppError;
use serde_json::json;
use std::io::Cursor;

fn build_doc(content: Vec<Value>) -> Built {
    build("제목", &[sec("s", content)], Paper::A4Portrait, &no_images).unwrap()
}

fn real_build() -> Built {
    build("제목", &[real_section()], Paper::A4Portrait, &real_resolver).unwrap()
}

fn document(b: &Built) -> String {
    part(&b.bytes, "word/document.xml")
}

mod structure;
mod mapping;
mod roundtrip;
mod safety;
