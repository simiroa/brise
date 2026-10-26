// repo: doc_export — ProseMirror JSON → 문서 파일 (PLAN-2026-10-07-doc-import-export W3, W4-0 에서 모듈로 분리, W4-RE 에서 DOCX 추가)
//
// 본 제품은 한글과컴퓨터의 글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
// (OWPML/KS X 6101 구조를 참고했다 — 정확한 고지 문구·위치는 조사 §6.7 대로 W3 전에 스펙 PDF 와 대조해 확정한다.)
//
// 형식 무관 부분과 형식 전용 부분을 가른다(DOCX 가 형식 무관 부분을 HWPX 와 같이 쓴다):
//   mod.rs   입력·출력 형 · 쪽 종류 · 상한 · 섹션 검증 · 첨부 그림 해석(`attachment_resolver`) · 그림 적재(`ImageStore`) ·
//            노드·깊이 예산(`Budget`) · zip 쓰기(`ZipOut`) · `export()`(쓰기)
//   pm.rs    ProseMirror JSON 접근자 · CSS 색 · 링크 대상 · 정렬 · 표 격자 배치 · 열 너비 · 그림 크기
//   xmlw.rs  XML 이스케이프 · 불법 글자 거르기
//   hwpx.rs  HWPX(OWPML) 전용 — 서식 레지스트리 · 작성기 · 정적 부품 · zip 패키지
//   docx.rs  DOCX(WordprocessingML) 전용 — 작성기 · 스타일/번호 정의 · 관계 · zip 패키지
//   html.rs  HTML(W6) — 빌더가 아니다: 프런트가 만든 완성 HTML 의 `<img data-rel-path>` 를 같은 첨부 해석기로 data: URI 로 채운다
//            (`export_html` 파일 · `export_html_inline` 클립보드)
// 빌더의 계약: (제목, 섹션들, 쪽, 그림 해석기) → 파일 바이트(`Built`). 순수 — 파일·DB 를 건드리지 않는다.
mod docx;
mod hwpx;
pub mod html;
mod pm;
#[cfg(test)]
mod testutil;
mod xmlw;

use crate::error::{io as io_err, AppError, AppResult};
use crate::repo::attachments;
use parking_lot::Mutex;
use pm::ty;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Cursor, Seek, Write};
use std::path::Path;

// ── 상한 ─────────────────────────────────────────────────────────────────────

/// 한 번에 내보낼 섹션 수 · 문서 전체에서 훑는 노드 수 · 중첩 깊이(재귀 = 스택 보호).
const MAX_SECTIONS: usize = 500;
const MAX_NODES: usize = 1_000_000;
const MAX_DEPTH: usize = 48;
/// 그림: 한 장 · 전체 · 장수(같은 파일이 여러 번 나와도 BinData 는 한 번). 넘는 그림은 그 그림만 건너뛴다(`skipped_images`).
/// 가져오기(`doc_import/mod.rs`)와 같은 값이다(U-7, 오너 2026-10-12) — 가져온 문서는 그림 그대로 다시 내보낼 수 있어야 한다.
/// zip 은 임시 파일로 바로 흘려 쓴다(`export()` → `write_atomic_with`, E-2) — 순간 메모리는 적재한 그림(≤128MB) + XML 정도다.
/// ponytail: 그림은 아직 전부 메모리에 올린 뒤 쓴다(엔트리 순서·id 가 문서 순서라 먼저 다 읽어야 한다). 더 줄이려면 그림 엔트리를 읽는 즉시
/// 쓰는 2패스 구조가 필요하다. HTML 은 출력 상한(html.rs `LIMITS.output`)이 따로 막는다.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGES: usize = 400;
/// 디코드가 필요한(webp·tiff → png) 그림의 화소 수 상한 — 작은 파일이 거대한 비트맵으로 풀리는 걸 막는다.
const MAX_IMAGE_PIXELS: u64 = 50_000_000;

// 쪽 설정(형식 무관 선택값) — 용지 크기 · 방향 · 여백 단계. 쪽 크기·여백의 수치(HWPUNIT · twips)와 방향 표기는 형식 전용이라
// `hwpx.rs`·`docx.rs` 에 각자 있다. 여백 "보통"은 그 편집기의 기본값(한글 / Word), 좁게는 사방 12.7mm, 넓게는 보통에서 좌우만 50.8mm.
// 프런트 미리보기·인쇄(exportPaper.ts pageInsetMm)가 같은 값을 mm 로 쓴다 — 한쪽을 바꾸면 다른 쪽도.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PaperSize {
    A4,
    /// JIS B5(182×257mm) — 한글·Word 의 "B5" 와 같은 크기(ISO B5 176×250 이 아니다).
    B5,
    Letter,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Margin {
    Narrow,
    Normal,
    Wide,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Paper {
    pub size: PaperSize,
    pub landscape: bool,
    pub margin: Margin,
}

#[allow(non_upper_case_globals)]
impl Paper {
    pub const A4Portrait: Paper = Paper { size: PaperSize::A4, landscape: false, margin: Margin::Normal };
    pub const A4Landscape: Paper = Paper { size: PaperSize::A4, landscape: true, margin: Margin::Normal };

    /// `paper` = `{a4|b5|letter}-{portrait|landscape}`, `margin` = `narrow|normal|wide`. 모르는 값은 VALIDATION.
    pub fn parse(paper: &str, margin: &str) -> AppResult<Paper> {
        let bad = || AppError::Validation(format!("unknown paper: {paper}"));
        let (size, orient) = paper.split_once('-').ok_or_else(bad)?;
        let size = match size {
            "a4" => PaperSize::A4,
            "b5" => PaperSize::B5,
            "letter" => PaperSize::Letter,
            _ => return Err(bad()),
        };
        let landscape = match orient {
            "portrait" => false,
            "landscape" => true,
            _ => return Err(bad()),
        };
        let margin = match margin {
            "narrow" => Margin::Narrow,
            "normal" => Margin::Normal,
            "wide" => Margin::Wide,
            other => return Err(AppError::Validation(format!("unknown margin: {other}"))),
        };
        Ok(Paper { size, landscape, margin })
    }

    /// 세로 기준 (가로, 세로) 를 방향에 맞춰 돌린다.
    pub fn orient(self, (w, h): (i64, i64)) -> (i64, i64) {
        if self.landscape { (h, w) } else { (w, h) }
    }
}

/// 내보낼 파일 형식. 입력(ProseMirror JSON)은 형식과 무관하고 빌더만 갈린다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DocFormat {
    Hwpx,
    Docx,
}

impl DocFormat {
    /// 임시 파일(`.tmp-xxxx.<ext>`)과 파일 확장자.
    pub fn ext(self) -> &'static str {
        match self {
            DocFormat::Hwpx => "hwpx",
            DocFormat::Docx => "docx",
        }
    }
}

// ── 입력 · 출력 형 ────────────────────────────────────────────────────────────

/// `export_hwpx`·`export_docx` 의 섹션 하나(specs `DocExportSection`) — `doc` 은 그 섹션 body_md 를 헤드리스 TipTap 으로 연 `getJSON()`.
/// 입력은 형식과 무관하다(ProseMirror JSON) — 어느 형식의 내보내기도 같은 입력을 받는다.
#[derive(Deserialize, Debug, Clone)]
pub struct DocExportSection {
    pub name: String,
    pub doc: Value,
}

/// `export_hwpx`·`export_docx` 출력(specs `ExportHwpxOutput` · `ExportDocxOutput` — 같은 모양).
#[derive(Serialize, Debug)]
pub struct ExportDocResult {
    pub written_path: String,
    pub image_count: usize,
    pub skipped_images: usize,
}

/// 순수 빌더의 결과 — zip 바이트와 그림 집계.
pub struct Built {
    pub bytes: Vec<u8>,
    pub image_count: usize,
    pub skipped_images: usize,
}

/// 섹션 입력 검증 — 비어 있지 않고, 상한 안이고, 모두 ProseMirror 문서(`doc`)여야 한다. 형식별 빌더(`hwpx::build` …)가
/// **첫 문장으로** 부른다(빌더를 직접 부르는 테스트도 같은 오류를 본다).
fn validate_sections(sections: &[DocExportSection]) -> AppResult<()> {
    if sections.is_empty() {
        return Err(AppError::Validation("no sections to export".to_string()));
    }
    if sections.len() > MAX_SECTIONS {
        return Err(AppError::Validation(format!("too many sections to export (max {MAX_SECTIONS})")));
    }
    for s in sections {
        if ty(&s.doc) != "doc" {
            return Err(AppError::Validation("section doc is not a ProseMirror doc".to_string()));
        }
    }
    Ok(())
}

/// 섹션이 둘 이상이면 섹션 이름을 제목 1 문단으로 앞에 둔다(이름이 빈 섹션은 만들지 않는다 — 빈 제목 줄이 생길 뿐이다).
/// 노트 제목은 본문에 넣지 않고 문서 정보에만 쓴다.
fn section_heading(sections: &[DocExportSection], s: &DocExportSection) -> Option<Value> {
    if sections.len() > 1 && !s.name.trim().is_empty() {
        return Some(serde_json::json!({ "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": s.name.trim() }] }));
    }
    None
}

/// 문서 전체에서 훑는 노드 수 · 블록 중첩 깊이 예산 — 두 작성기가 같은 상한을 같은 방식으로 지킨다.
#[derive(Default)]
struct Budget {
    nodes: usize,
    depth: usize,
}

impl Budget {
    fn tick(&mut self) -> AppResult<()> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(AppError::Validation("document is too large to export".to_string()));
        }
        Ok(())
    }

    /// 재귀 한 단계 들어간다(`leave` 와 짝). 모든 블록 재귀(`block` · `list`)가 지나야 한다 — 목록 안 목록처럼 `block` 을 거치지 않는
    /// 재귀도 같은 깊이 예산을 먹어야 스택이 안 터진다.
    fn enter(&mut self) -> AppResult<()> {
        if self.depth >= MAX_DEPTH {
            return Err(AppError::Validation("document nesting is too deep to export".to_string()));
        }
        self.depth += 1;
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::Io(format!("zip write error: {e}"))
}

/// 그림 해석기 — relPath → 바이트. 병렬 미리 읽기(E-3)가 여러 스레드에서 부르므로 `Sync` 여야 한다(`attachment_resolver` 는 이미 그렇다).
type Resolver<'r> = dyn Fn(&str) -> Option<Vec<u8>> + Sync + 'r;

/// zip 쓰기 — 엔트리 시각은 1980-01-01 로 고정한다(실제 한컴·Word 저장본도 그렇다). `stored` = 무압축.
/// 출력처 `W` 는 `Cursor<Vec<u8>>`(순수 `build`) 또는 임시 파일(`export`) — 문서 조립은 하나, 싱크만 둘이다(E-2).
struct ZipOut<W: Write + Seek> {
    zw: zip::ZipWriter<W>,
}

impl<W: Write + Seek> ZipOut<W> {
    fn new(sink: W) -> Self {
        ZipOut { zw: zip::ZipWriter::new(sink) }
    }

    fn put(&mut self, name: &str, stored: bool, bytes: &[u8]) -> AppResult<()> {
        use zip::write::SimpleFileOptions;
        use zip::CompressionMethod;
        let method = if stored { CompressionMethod::Stored } else { CompressionMethod::Deflated };
        let opts = SimpleFileOptions::default().compression_method(method).last_modified_time(zip::DateTime::default());
        self.zw.start_file(name, opts).map_err(zip_err)?;
        self.zw.write_all(bytes).map_err(io_err)
    }

    fn finish(self) -> AppResult<W> {
        self.zw.finish().map_err(zip_err)
    }
}

// ── 이미지 ────────────────────────────────────────────────────────────────────
//
// 그림 적재(읽기 · 형식 판별 · 상한 · 같은 파일 한 번만)는 형식 무관이라 여기 한 곳에 둔다. 압축 파일 안 이름(`BinData/imageN.ext` ·
// `word/media/imageN.ext`)·id·media-type 표기·길이 단위(HWPUNIT = px × 75 · EMU = px × 9525)는 작성기가 정한다.

/// 적재한 그림 한 장. 확장자는 `png`·`jpg`·`gif`·`bmp` 중 하나 — 작성기가 자기 형식의 이름·media-type 으로 바꾼다.
struct ImgEntry {
    ext: &'static str,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
struct Loaded {
    /// `ImageStore::entries` 안의 위치.
    idx: usize,
    /// 원본 크기(px).
    w_px: u32,
    h_px: u32,
}

/// 그림 바이트 → (확장자, 바이트, 가로 px, 세로 px). 한컴·Word 가 읽는 png·jpg·gif·bmp 는 그대로, webp·tiff 는 png 로 바꾼다.
/// 그 밖(svg·heic·깨진 파일·화소 상한 초과)은 None.
fn sniff_image(bytes: Vec<u8>) -> Option<(&'static str, Vec<u8>, u32, u32)> {
    use image::ImageFormat;
    let fmt = image::guess_format(&bytes).ok()?;
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), fmt);
    let (w, h) = reader.into_dimensions().ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    match fmt {
        ImageFormat::Png => Some(("png", bytes, w, h)),
        ImageFormat::Jpeg => Some(("jpg", bytes, w, h)),
        ImageFormat::Gif => Some(("gif", bytes, w, h)),
        ImageFormat::Bmp => Some(("bmp", bytes, w, h)),
        ImageFormat::WebP | ImageFormat::Tiff => {
            if u64::from(w) * u64::from(h) > MAX_IMAGE_PIXELS {
                return None;
            }
            let img = image::load_from_memory_with_format(&bytes, fmt).ok()?;
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::Png).ok()?;
            Some(("png", buf.into_inner(), w, h))
        }
        _ => None,
    }
}

/// 읽기 + 형식 판별을 마친 그림(`sniff_image` 결과).
type Sniffed = (&'static str, Vec<u8>, u32, u32);

/// relPath → 그림 바이트 해석기를 받아 그림을 모으는 곳. 같은 relPath 는 한 번만 읽고(실패도 기억한다) 한 장만 쌓는다.
///
/// `prefetched` 는 `prefetch_images` 가 병렬로 미리 읽고 판별해 둔 결과다. 있으면 `load_uncached` 가 읽기·판별만 거기서 꺼내 쓰고
/// (상한 판정·순서·id 는 그대로 문서 순서로 여기서 한다), 없으면 직접 읽는다 — 그래서 미리 읽기가 빠뜨리거나 순서가 달라도
/// 결과는 직렬일 때와 바이트 단위로 같다.
struct ImageStore<'a> {
    resolve: &'a Resolver<'a>,
    entries: Vec<ImgEntry>,
    total: usize,
    by_rel: HashMap<String, Option<Loaded>>,
    prefetched: HashMap<String, Option<Sniffed>>,
}

impl<'a> ImageStore<'a> {
    fn new(resolve: &'a Resolver<'a>) -> Self {
        ImageStore { resolve, entries: Vec::new(), total: 0, by_rel: HashMap::new(), prefetched: HashMap::new() }
    }

    fn prefill(&mut self, prefetched: HashMap<String, Option<Sniffed>>) {
        self.prefetched = prefetched;
    }

    /// 못 넣는 그림(경로 밖·없음·형식·상한)은 None — 호출자가 그 그림만 글자로 남기고 센다.
    fn load(&mut self, rel: &str) -> Option<Loaded> {
        if let Some(l) = self.by_rel.get(rel) {
            return *l;
        }
        let l = self.load_uncached(rel);
        self.by_rel.insert(rel.to_string(), l);
        l
    }

    fn load_uncached(&mut self, rel: &str) -> Option<Loaded> {
        if self.entries.len() >= MAX_IMAGES {
            return None;
        }
        let sniffed = match self.prefetched.remove(rel) {
            Some(s) => s,
            None => (self.resolve)(rel).and_then(sniff_image),
        };
        let (ext, bytes, w_px, h_px) = sniffed?;
        if self.total + bytes.len() > MAX_IMAGES_TOTAL_BYTES {
            return None;
        }
        self.total += bytes.len();
        self.entries.push(ImgEntry { ext, bytes });
        Some(Loaded { idx: self.entries.len() - 1, w_px, h_px })
    }
}

/// 미리 읽어 쥔 결과(판별·변환을 **마친** 바이트)가 이만큼이 되면 새 읽기를 시작하지 않는다 — 나머지는 `load` 가 직접 읽는다.
/// 원본 크기로 세면 안 된다: webp·tiff 는 png 로 바뀌며 몇 배로 커져(손실 압축 사진이면 5~10배) 원본 기준 상한 아래에서도 쥔 결과가
/// 저장 총량(`MAX_IMAGES_TOTAL_BYTES`)을 한참 넘을 수 있고, 그 몫은 어차피 문서 순서상 상한에 걸려 버려진다(코디네이터 검증 2026-10-12).
/// 총량과 같게 두면 미리 읽기가 쥐는 메모리는 저장에 실제로 들어갈 몫 + 일꾼 수만큼의 진행분으로 묶인다.
const PREFETCH_HELD_LIMIT: usize = MAX_IMAGES_TOTAL_BYTES;

/// 문서 순서(깊이 우선 전위)로 그림 relPath 를 모은다 — 중복 제거, 처음 `MAX_IMAGES` 개. 작성기가 그림을 만나는 순서와 같다고 가정하지만,
/// 틀려도 성능만 달라진다(`ImageStore` 가 못 찾은 것은 직접 읽는다). 반복문이라 깊은 입력에도 스택이 안 터진다.
fn collect_image_rels(sections: &[DocExportSection]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for s in sections {
        let mut stack = vec![&s.doc];
        while let Some(n) = stack.pop() {
            if out.len() >= MAX_IMAGES {
                return out;
            }
            if ty(n) == "image" {
                if let Some(rel) = pm::attr_str(n, "relPath").filter(|r| !r.is_empty()) {
                    if seen.insert(rel) {
                        out.push(rel.to_string());
                    }
                }
            }
            stack.extend(pm::kids(n).iter().rev());
        }
    }
    out
}

#[cfg(test)]
thread_local! {
    /// 테스트 오라클: 켜면 미리 읽기를 건너뛰어 예전 직렬 적재를 그대로 재현한다(바이트 동치 검사용).
    static SERIAL_IMAGES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// 테스트 시계: 값이 있으면 `export_now` 가 그 시각을 돌려준다(바이트 동치 검사용).
    static FIXED_NOW: std::cell::Cell<Option<chrono::DateTime<chrono::Utc>>> = const { std::cell::Cell::new(None) };
}

/// 내보낸 파일 메타 날짜(HWPX 작성일·DOCX core.xml)의 "지금". 테스트는 `FIXED_NOW` 로 고정한다 — 직렬·병렬 출력을
/// 바이트로 비교하는데, 그림 상한 크기 문서는 빌드 한 번이 1초를 넘어 두 결과가 늘 다른 초에 찍혔다
/// (parallel_prefetch_matches_serial_at_the_image_count_and_total_byte_caps 부하 플레이크, AUDIT-2026-10-23 R5).
pub(crate) fn export_now() -> chrono::DateTime<chrono::Utc> {
    #[cfg(test)]
    if let Some(t) = FIXED_NOW.with(|c| c.get()) {
        return t;
    }
    chrono::Utc::now()
}

/// 그림을 `std::thread::scope` 로 `min(4, 코어)` 개 일꾼이 병렬로 읽고 판별한다(webp·tiff 의 디코드→png 가 CPU 를 먹는다, E-3).
/// 그림이 둘 미만이면 아무것도 안 한다. 쥔 결과가 `PREFETCH_HELD_LIMIT` 를 넘으면 새 읽기를 시작하지 않는다.
fn prefetch_images(sections: &[DocExportSection], resolve: &Resolver<'_>) -> HashMap<String, Option<Sniffed>> {
    #[cfg(test)]
    if SERIAL_IMAGES.with(|c| c.get()) {
        return HashMap::new();
    }
    prefetch_images_within(sections, resolve, PREFETCH_HELD_LIMIT)
}

/// `prefetch_images` 본체 — 쥘 상한을 인자로 받아 테스트가 작은 값으로 멈춤을 확인할 수 있게 한다.
fn prefetch_images_within(sections: &[DocExportSection], resolve: &Resolver<'_>, held_limit: usize) -> HashMap<String, Option<Sniffed>> {
    use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
    let rels = collect_image_rels(sections);
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(4).min(rels.len());
    if workers < 2 {
        return HashMap::new();
    }
    let next = AtomicUsize::new(0);
    let held = AtomicUsize::new(0);
    let done: Mutex<HashMap<String, Option<Sniffed>>> = Mutex::new(HashMap::with_capacity(rels.len()));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Relaxed);
                if i >= rels.len() || held.load(Relaxed) > held_limit {
                    break;
                }
                let sniffed = resolve(&rels[i]).and_then(sniff_image);
                if let Some((_, bytes, _, _)) = &sniffed {
                    held.fetch_add(bytes.len(), Relaxed);
                }
                done.lock().insert(rels[i].clone(), sniffed);
            });
        }
    });
    done.into_inner()
}

/// 첨부 루트(`attachments/`) 안의 그림만 읽는 해석기. relPath 는 `{폴더}/{저장 이름}` 모양이어야 한다.
///
/// 폴더가 **이 노트의 id 일 필요는 없다** — 섹션을 다른 노트로 옮기면 본문 이미지는 원 노트 id 를 포함한 상대경로 그대로라(`repo/sections.rs`
/// `move_to_note`) 새 노트에서도 그림이 그려지고, 내보내기도 같이 나가야 앱 화면(모달 미리보기)과 파일이 어긋나지 않는다. 경계는 첨부 루트다:
/// `../`·절대 경로·UNC·드라이브 접두사(`C:x.png`)는 `paths::safe_rel` 이, 심볼릭 링크·정션으로 새는 것은 정규화 경로 포함 검사가 막는다.
/// 일반 파일이 아니거나 상한을 넘거나 없거나 루트 바로 아래 파일(폴더 없음)이면 None(= 그 그림만 건너뜀). 이미지 형식 판별은 호출자(`sniff_image`).
pub fn attachment_resolver(data_dir: &Path) -> impl Fn(&str) -> Option<Vec<u8>> + '_ {
    move |rel: &str| {
        let clean = crate::repo::paths::safe_rel(rel).ok()?;
        if clean.components().count() < 2 {
            return None;
        }
        let root = crate::db::attachments_dir(data_dir);
        let file = root.join(&clean);
        let meta = std::fs::symlink_metadata(&file).ok()?;
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            return None;
        }
        if !file.canonicalize().ok()?.starts_with(root.canonicalize().ok()?) {
            return None;
        }
        std::fs::read(&file).ok()
    }
}

/// `export_hwpx`·`export_docx` 본체 — 검증 → 빌드 → tmp→rename 으로 쓰기. **블로킹**이다(호출자가 spawn_blocking 으로 감싼다).
///
/// 노트가 없으면 NOT_FOUND, 섹션이 비었거나 doc 이 ProseMirror 문서가 아니면 VALIDATION. `exported_at` 은 갱신하지 않는다 —
/// 이 명령은 섹션 일부만 내보낼 수도 있어 "노트를 내보냈다"는 사실을 단정할 수 없다(노트 전체 Markdown 인 `export_note` 와 다른 점).
#[allow(clippy::too_many_arguments)]
pub fn export(
    db: &Mutex<Connection>,
    data_dir: &Path,
    note_id: &str,
    dest_path: &str,
    title: &str,
    sections: &[DocExportSection],
    paper: &str,
    margin: &str,
    format: DocFormat,
) -> AppResult<ExportDocResult> {
    let paper = Paper::parse(paper, margin)?;
    attachments::require_note(&db.lock(), note_id)?;
    let resolver = attachment_resolver(data_dir);
    // zip 을 메모리에 다 모으지 않고 tmp 파일에 바로 쓴다(E-2). 조립 중 오류면 tmp 는 `write_atomic_with` 가 지운다.
    let (written_path, (image_count, skipped_images)) =
        crate::repo::transfer::export::write_atomic_with(Path::new(dest_path), format.ext(), |file| match format {
            DocFormat::Hwpx => hwpx::build_into(title, sections, paper, &resolver, file).map(|(_, a, b)| (a, b)),
            DocFormat::Docx => docx::build_into(title, sections, paper, &resolver, file).map(|(_, a, b)| (a, b)),
        })?;
    Ok(ExportDocResult { written_path, image_count, skipped_images })
}

/// 내보내기 완료 토스트가 여는 파일인가 — 내보내기 형식 확장자이고 **존재하는 일반 파일**(심볼릭 링크·폴더 아님)일 때만 그 경로를 돌려준다.
/// 아무 경로나 여는 명령이 되지 않게 하는 관문이라 순수 함수로 둔다(`export_open` 이 이걸 지난 뒤에만 opener 를 부른다).
pub fn openable_export_path(path: &str) -> AppResult<std::path::PathBuf> {
    // htm: export_html 이 .html 과 같이 받는다 — 그렇게 저장한 파일도 토스트에서 열려야 한다.
    const EXTS: [&str; 8] = ["hwpx", "docx", "pdf", "md", "html", "htm", "csv", "png"];
    let p = Path::new(path);
    if path.trim().is_empty() {
        return Err(AppError::Validation("path is empty".to_string()));
    }
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !EXTS.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!("not an export file type: .{ext}")));
    }
    let meta = std::fs::symlink_metadata(p).map_err(io_err)?;
    if !meta.is_file() {
        return Err(AppError::Validation("not a regular file".to_string()));
    }
    Ok(p.to_path_buf())
}

// ── 테스트 ────────────────────────────────────────────────────────────────────
//
// 형식 무관 부분(그림 경로 해석기 · `export()` 의 검증·쓰기 · 열기 관문)을 본다. 픽스처(섹션·PNG 만들기)와 패키지 구조 검사는
// `hwpx::tests` 가 가진다.
#[cfg(test)]
mod tests {
    use super::hwpx::tests::assert_package_consistent;
    use super::testutil::{image_node, p, png_bytes, sec};
    use super::*;
    use serde_json::json;

    // ── 그림 경로 해석기 ──────────────────────────────────────────────────

    #[test]
    fn attachment_resolver_reads_only_regular_files_inside_the_attachments_root() {
        let data = tempfile::tempdir().unwrap();
        let att = crate::db::attachments_dir(data.path());
        std::fs::create_dir_all(att.join("n1/sub")).unwrap();
        std::fs::create_dir_all(att.join("n2")).unwrap();
        std::fs::write(att.join("n1/ok.png"), b"ok").unwrap();
        std::fs::write(att.join("n2/other.png"), b"other").unwrap();
        // 첨부 루트 바로 아래 파일(폴더 없음) · 첨부 루트 밖 파일.
        std::fs::write(att.join("n1x.png"), b"sibling-prefix").unwrap();
        std::fs::write(data.path().join("secret.txt"), b"secret").unwrap();
        let big = std::fs::File::create(att.join("n1/big.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(big);
        let r = attachment_resolver(data.path());
        assert_eq!(r("n1/ok.png").as_deref(), Some(&b"ok"[..]));
        // 다른 노트 폴더의 그림도 읽는다 — 섹션을 옮기면 본문 이미지는 원 노트 id 경로 그대로라 새 노트에서도 그려진다(미리보기와 파일이 같아야 한다).
        assert_eq!(r("n2/other.png").as_deref(), Some(&b"other"[..]));
        for bad in [
            "n1/../n2/other.png",
            "n1/../../secret.txt",
            "../secret.txt",
            "../attachments/n1/ok.png",
            "./n1/ok.png",
            "/n1/ok.png",
            "C:x.png",
            "C:\\x.png",
            "C:/Windows/win.ini",
            "\\\\server\\share\\a.png",
            "//server/share/a.png",
            "n1x.png",
            "n1/missing.png",
            "n1",
            "n1/",
            "n1/sub",
            "n1/big.png",
            "",
            "n1/ok.png/..",
        ] {
            assert!(r(bad).is_none(), "{bad:?} must not resolve");
        }
    }

    // ── 병렬 미리 읽기 ≡ 직렬 적재 (E-3 오라클) ────────────────────────────

    /// 같은 입력을 직렬(예전 방식, `SERIAL_IMAGES`)과 병렬 미리 읽기로 만들어 **바이트까지** 같은지 본다. 파일에 현재 시각(메타 날짜)이
    /// 들어가므로 시계를 고정한다(`FIXED_NOW`) — 예전엔 초가 넘어가면 몇 번 다시 해 봤는데, 빌드 한 번이 1초를 넘는 상한 크기
    /// 문서에선 재시도가 늘 다른 초에 걸려 부하가 있을 때마다 실패했다.
    fn assert_serial_equals_parallel(sections: &[DocExportSection], resolve: &Resolver<'_>, expect_images: Option<(usize, usize)>) {
        let fixed = chrono::DateTime::parse_from_rfc3339("2026-01-02T03:04:05Z").unwrap().with_timezone(&chrono::Utc);
        FIXED_NOW.with(|c| c.set(Some(fixed)));
        for (name, build) in [
            ("hwpx", hwpx::build as fn(&str, &[DocExportSection], Paper, &Resolver<'_>) -> AppResult<Built>),
            ("docx", docx::build),
        ] {
            SERIAL_IMAGES.with(|c| c.set(true));
            let serial = build("t", sections, Paper::A4Portrait, resolve);
            SERIAL_IMAGES.with(|c| c.set(false));
            let parallel = build("t", sections, Paper::A4Portrait, resolve);
            let (s, p) = (serial.unwrap(), parallel.unwrap());
            assert_eq!((s.image_count, s.skipped_images), (p.image_count, p.skipped_images), "{name} counts");
            if let Some(want) = expect_images {
                assert_eq!((p.image_count, p.skipped_images), want, "{name} expected counts");
            }
            assert!(s.bytes == p.bytes, "{name}: parallel output differs from serial");
        }
        FIXED_NOW.with(|c| c.set(None));
    }

    fn encoded(fmt: image::ImageFormat, seed: u8) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(40 + u32::from(seed), 30, |x, y| image::Rgba([(x * 5) as u8 ^ seed, (y * 7) as u8, seed.wrapping_mul(3), 255]));
        let img = if fmt == image::ImageFormat::Jpeg { image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(img).to_rgb8()) } else { image::DynamicImage::ImageRgba8(img) };
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, fmt).unwrap();
        buf.into_inner()
    }

    fn image_doc(rels: &[String]) -> Vec<DocExportSection> {
        let paras: Vec<Value> = rels.iter().map(|r| json!({ "type": "paragraph", "content": [image_node(Some(r), "", "40%")] })).collect();
        vec![sec("s", paras)]
    }

    #[test]
    fn parallel_prefetch_matches_serial_for_every_format_duplicate_missing_and_oversize() {
        use image::ImageFormat::{Bmp, Gif, Jpeg, Png, Tiff, WebP};
        let data = tempfile::tempdir().unwrap();
        let dir = crate::db::attachments_dir(data.path()).join("n1");
        std::fs::create_dir_all(&dir).unwrap();
        let mut rels = Vec::new();
        for (i, (fmt, ext)) in [(Jpeg, "jpg"), (Png, "png"), (Gif, "gif"), (Bmp, "bmp"), (WebP, "webp"), (Tiff, "tif")].into_iter().enumerate() {
            for k in 0..3u8 {
                let name = format!("{ext}{k}.{ext}");
                std::fs::write(dir.join(&name), encoded(fmt, (i as u8) * 10 + k)).unwrap();
                rels.push(format!("n1/{name}"));
            }
        }
        std::fs::write(dir.join("notimage.svg"), b"<svg/>").unwrap();
        let big = std::fs::File::create(dir.join("big.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(big);
        // 문서 순서를 섞는다: 중복(앞·뒤), 없는 파일, 이미지 아님, 32MB 초과, 경로 밖.
        let mut order = rels.clone();
        order.insert(2, rels[0].clone());
        order.insert(5, "n1/missing.png".to_string());
        order.insert(7, "n1/notimage.svg".to_string());
        order.insert(9, "n1/big.png".to_string());
        order.insert(11, "../brise.db".to_string());
        order.push(rels[4].clone());
        order.push("n1/missing.png".to_string());
        let sections = image_doc(&order);
        let resolver = attachment_resolver(data.path());
        // 18 장 + 중복 2 = 유효 18 장 적재, 건너뜀 = 없음 2 + svg 1 + 초과 1 + 경로 밖 1.
        assert_serial_equals_parallel(&sections, &resolver, Some((20, 5)));
    }

    #[test]
    fn parallel_prefetch_matches_serial_at_the_image_count_and_total_byte_caps() {
        // 400장 초과 — 유효한 작은 jpg 410장(서로 다른 relPath, 내용은 일부만 달라도 됨). 처음 400장만 들어가고 나머지는 건너뜀.
        let jpg = encoded(image::ImageFormat::Jpeg, 1);
        let many: Vec<String> = (0..410).map(|i| format!("n1/{i}.jpg")).collect();
        let r = |_: &str| Some(jpg.clone());
        assert_serial_equals_parallel(&image_doc(&many), &r, Some((MAX_IMAGES, 10)));

        // 합계 128MB 초과 — 헤더가 유효한 jpg 뒤에 쓰레기를 붙여 5MB 로 부풀린다(치수만 읽으므로 디코드 없음). 25장 = 125MB 다음 장부터는
        // 합계 상한에 걸리고, 그 뒤의 작은 그림은 다시 들어간다(건너뜀 판정이 문서 순서의 누적 합계에 달렸다는 뜻).
        let mut fat = jpg.clone();
        fat.resize(5 * 1024 * 1024, 0);
        let small = jpg.clone();
        let rels: Vec<String> = (0..28).map(|i| if i < 27 { format!("fat/{i}.jpg") } else { "small/tail.jpg".to_string() }).collect();
        let r2 = |rel: &str| Some(if rel.starts_with("fat/") { fat.clone() } else { small.clone() });
        // 25 × 5MB = 125MB 들어감, fat 26·27번째(0-base 25·26) 건너뜀, small 들어감.
        assert_serial_equals_parallel(&image_doc(&rels), &r2, Some((26, 2)));
    }

    #[test]
    fn prefetch_stops_once_held_results_pass_the_limit() {
        // 미리 읽기는 판별을 마친 결과 크기로 세어 멈춘다(원본 크기 아님 — webp·tiff 는 png 로 커진다). 1MB jpg 50장, 상한 10MB:
        // 쥔 결과는 상한 + 일꾼 수만큼의 진행분 안이어야 한다. 나머지는 ImageStore 가 직접 읽으므로 결과 파일은 같다(위 동치 테스트).
        let mut jpg = encoded(image::ImageFormat::Jpeg, 1);
        jpg.resize(1024 * 1024, 0);
        let rels: Vec<String> = (0..50).map(|i| format!("n1/{i}.jpg")).collect();
        let r = |_: &str| Some(jpg.clone());
        let limit = 10 * 1024 * 1024;
        let held: usize = prefetch_images_within(&image_doc(&rels), &r, limit)
            .values()
            .filter_map(|s| s.as_ref().map(|(_, b, _, _)| b.len()))
            .sum();
        let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(4);
        assert!(held <= limit + workers * jpg.len(), "held {held} > limit {limit} + {workers} in-flight");
    }

    #[test]
    fn collect_image_rels_is_document_ordered_deduped_and_capped() {
        let doc = vec![sec(
            "s",
            vec![
                json!({ "type": "paragraph", "content": [image_node(Some("a/1.png"), "", "1"), image_node(Some("a/2.png"), "", "1")] }),
                json!({ "type": "bulletList", "content": [{ "type": "listItem", "content": [image_node(Some("a/3.png"), "", "1"), image_node(Some("a/1.png"), "", "1"), image_node(None, "", "1")] }] }),
            ],
        )];
        assert_eq!(collect_image_rels(&doc), vec!["a/1.png", "a/2.png", "a/3.png"]);
        let many: Vec<String> = (0..MAX_IMAGES + 5).map(|i| format!("n/{i}.png")).collect();
        assert_eq!(collect_image_rels(&image_doc(&many)).len(), MAX_IMAGES);
    }

    // ── export() — DB · 첨부 · 파일 ───────────────────────────────────────

    fn seeded() -> (tempfile::TempDir, Mutex<Connection>, String) {
        let data = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(data.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let note_id = crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap().note.id;
        (data, Mutex::new(conn), note_id)
    }

    #[test]
    fn export_writes_a_file_with_attachment_images_and_skips_paths_outside_the_attachments_root() {
        let (data, db, note_id) = seeded();
        let src = data.path().join("pic.png");
        std::fs::write(&src, png_bytes()).unwrap();
        let att = attachments::add_file(&mut db.lock(), data.path(), &note_id, &src.to_string_lossy()).unwrap();
        let rel = att.rel_path.unwrap();
        // 다른 노트 폴더의 파일(섹션을 옮긴 뒤에도 그려지는 그림 — 들어간다) · `..` 로 벗어나는 경로 · 첨부 루트 밖 파일(건너뜀).
        std::fs::create_dir_all(crate::db::attachments_dir(data.path()).join("other-note")).unwrap();
        std::fs::write(crate::db::attachments_dir(data.path()).join("other-note/x.png"), png_bytes()).unwrap();
        let para = json!({ "type": "paragraph", "content": [
            image_node(Some(&rel), "내 그림", "40%"), image_node(Some("other-note/x.png"), "", "40%"),
            image_node(Some(&format!("{note_id}/../other-note/x.png")), "", "40%"), image_node(Some("../brise.db"), "", "40%"),
        ] });
        let out_dir = tempfile::tempdir().unwrap();
        let dest = out_dir.path().join("sub").join("내보내기.hwpx");
        let res = export(&db, data.path(), &note_id, &dest.to_string_lossy(), "제목", &[sec("s", vec![para])], "a4-portrait", "normal", DocFormat::Hwpx).unwrap();
        assert_eq!((res.image_count, res.skipped_images), (2, 2));
        assert_eq!(res.written_path, dest.to_string_lossy());
        let bytes = std::fs::read(&dest).unwrap();
        assert_package_consistent(&bytes);
        // tmp 파일이 남지 않는다.
        let left: Vec<String> = std::fs::read_dir(dest.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["내보내기.hwpx".to_string()], "{left:?}");
        // exported_at 은 건드리지 않는다.
        let exported: Option<String> = db.lock().query_row("SELECT exported_at FROM notes WHERE id=?1", [&note_id], |r| r.get(0)).unwrap();
        assert!(exported.is_none());
    }

    #[test]
    fn export_validates_note_paper_sections_and_destination() {
        // 두 형식이 같은 검증을 같은 순서로 지난다(검증은 형식 앞에 있다).
        for (format, ext) in [(DocFormat::Hwpx, "hwpx"), (DocFormat::Docx, "docx")] {
            let (data, db, note_id) = seeded();
            let out = tempfile::tempdir().unwrap();
            let dest = out.path().join(format!("a.{ext}")).to_string_lossy().into_owned();
            let one = [sec("s", vec![p("x")])];
            let run = |note: &str, dest: &str, secs: &[DocExportSection], paper: &str| export(&db, data.path(), note, dest, "t", secs, paper, "normal", format);
            assert!(matches!(run("no-such-note", &dest, &one, "a4-portrait"), Err(AppError::NotFound(_))), "{ext}");
            assert!(matches!(run(&note_id, &dest, &[], "a4-portrait"), Err(AppError::Validation(_))), "{ext}");
            assert!(matches!(run(&note_id, &dest, &one, "letter"), Err(AppError::Validation(_))), "{ext}");
            assert!(matches!(run(&note_id, "", &one, "a4-portrait"), Err(AppError::Validation(_))), "{ext}");
            let bad = [DocExportSection { name: "n".into(), doc: json!({ "type": "heading" }) }];
            assert!(matches!(run(&note_id, &dest, &bad, "a4-portrait"), Err(AppError::Validation(_))), "{ext}");
            assert!(!std::path::Path::new(&dest).exists(), "a failed {ext} export must not leave a file");
            assert!(matches!(export(&db, data.path(), &note_id, &dest, "t", &one, "a4-portrait", "tight", format), Err(AppError::Validation(_))), "{ext}");
            assert!(run(&note_id, &dest, &one, "a4-landscape").is_ok(), "{ext}");
            assert!(std::path::Path::new(&dest).exists(), "{ext}");
            assert!(export(&db, data.path(), &note_id, &dest, "t", &one, "b5-portrait", "wide", format).is_ok(), "{ext}");
        }
    }

    #[test]
    fn docx_export_writes_a_docx_with_attachment_images_and_leaves_no_tmp_file() {
        let (data, db, note_id) = seeded();
        let src = data.path().join("pic.png");
        std::fs::write(&src, png_bytes()).unwrap();
        let att = attachments::add_file(&mut db.lock(), data.path(), &note_id, &src.to_string_lossy()).unwrap();
        let rel = att.rel_path.unwrap();
        let para = json!({ "type": "paragraph", "content": [image_node(Some(&rel), "내 그림", "40%"), image_node(Some("../brise.db"), "", "40%")] });
        let out_dir = tempfile::tempdir().unwrap();
        let dest = out_dir.path().join("sub").join("내보내기.docx");
        let res = export(&db, data.path(), &note_id, &dest.to_string_lossy(), "제목", &[sec("s", vec![para])], "a4-portrait", "normal", DocFormat::Docx).unwrap();
        assert_eq!((res.image_count, res.skipped_images), (1, 1));
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(&bytes[0..4], b"PK");
        let left: Vec<String> = std::fs::read_dir(dest.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["내보내기.docx".to_string()], "{left:?}");
    }

    #[test]
    fn openable_export_path_accepts_only_export_formats_that_are_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        for ext in ["hwpx", "DOCX", "pdf", "md", "html", "htm", "csv", "png"] {
            let f = dir.path().join(format!("a.{ext}"));
            std::fs::write(&f, b"x").unwrap();
            assert!(openable_export_path(&f.to_string_lossy()).is_ok(), "{ext}");
        }
        for ext in ["exe", "bat", "lnk", "txt", "sh", "ps1", "zip", ""] {
            let f = dir.path().join(if ext.is_empty() { "noext".to_string() } else { format!("a.{ext}") });
            std::fs::write(&f, b"x").unwrap();
            assert!(matches!(openable_export_path(&f.to_string_lossy()), Err(AppError::Validation(_))), "{ext}");
        }
        // 폴더(확장자가 export 형식이어도) · 없는 파일 · 빈 경로.
        let d = dir.path().join("folder.pdf");
        std::fs::create_dir(&d).unwrap();
        assert!(matches!(openable_export_path(&d.to_string_lossy()), Err(AppError::Validation(_))));
        assert!(matches!(openable_export_path(&dir.path().join("none.pdf").to_string_lossy()), Err(AppError::Io(_))));
        assert!(matches!(openable_export_path(""), Err(AppError::Validation(_))));
        assert!(matches!(openable_export_path("   "), Err(AppError::Validation(_))));
    }
}
