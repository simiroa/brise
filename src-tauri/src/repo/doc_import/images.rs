// repo: doc_import::images — 문서 안 그림 저장소 (HWPX 가져오기에서 떼어 낸 형식 무관 부분, W4-RI)
//
// zip 엔트리 하나를 그림으로 꺼낸다. 어느 엔트리가 그림인지(HWPX 는 BinData/manifest, DOCX 는 rels)는 형식이 정하고,
// **얼마나 풀어도 되는가**(한 장 · 전체 · 장수 · 푼 양 상한)는 여기서 한 번에 지킨다. 저장(DB)은 `import()` 가 한다.
use super::{
    ImageData, IMAGE_EXTS, MAX_IMAGES, MAX_IMAGES_TOTAL_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_LOOKUPS, MAX_IMAGE_READ_BYTES,
};
use crate::error::{AppError, AppResult};
use crate::repo::extraction::read_entry_bytes_capped;
use std::collections::HashMap;
use std::path::Path;
use zip::ZipArchive;

pub(super) struct ImagePool {
    pub(super) images: Vec<ImageData>,
    total: u64,
    /// 그림을 읽느라 푼 바이트 합(버린 것 포함) — `MAX_IMAGE_READ_BYTES` 까지만 푼다.
    read: u64,
    /// 해석된 zip 엔트리 이름 → 결과. 참조(id)가 여럿이어도 같은 파일은 한 번만 푼다(id 만 캐시 키로 쓰면 같은 20MB 를 id 수만큼
    /// 풀고 버린다).
    by_entry: HashMap<String, Option<usize>>,
}

impl ImagePool {
    pub(super) fn new() -> Self {
        ImagePool { images: Vec::new(), total: 0, read: 0, by_entry: HashMap::new() }
    }

    /// 엔트리 → 그림 번호(`images` 의 자리). 못 꺼내면 `Err(dropped kind)` — `image_format`(웹뷰가 못 그리는 형식: emf·wmf·tif …)
    /// 또는 `image_limit`(상한). 상한에 걸려 버려진 파일은 참조마다 `image_limit` 로 센다(진단은 처음 한 번만).
    /// `feature` 는 진단 기록의 기능 이름이다.
    pub(super) fn load<R: std::io::Read + std::io::Seek>(
        &mut self,
        zip: &mut ZipArchive<R>,
        entry: &str,
        feature: &'static str,
    ) -> AppResult<Result<usize, &'static str>> {
        let ext = Path::new(entry).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            return Ok(Err("image_format"));
        }
        let cached = match self.by_entry.get(entry) {
            Some(r) => *r,
            None => {
                // 서로 다른 엔트리를 몇 개까지 찾아 볼지 — 상한 밖 그림을 일일이 시도하고 버리는 일에도 한도를 둔다(진단 줄도 함께).
                if self.by_entry.len() >= MAX_IMAGE_LOOKUPS {
                    return Ok(Err("image_limit"));
                }
                let r = self.read_image(zip, entry, feature)?;
                self.by_entry.insert(entry.to_string(), r);
                r
            }
        };
        Ok(cached.ok_or("image_limit"))
    }

    /// zip 엔트리 하나를 그림으로 꺼낸다. 풀기 **전에** 중앙 디렉터리가 알리는 크기로 상한을 먼저 보고(큰 파일을 풀고 버리지
    /// 않는다), 푸는 동안은 `min(한 장 상한, 남은 총량)` 으로 끊는다 — 헤더가 크기를 속여도 상한은 지켜진다.
    fn read_image<R: std::io::Read + std::io::Seek>(
        &mut self,
        zip: &mut ZipArchive<R>,
        entry: &str,
        feature: &'static str,
    ) -> AppResult<Option<usize>> {
        if self.images.len() >= MAX_IMAGES {
            limit_skip(feature, "count");
            return Ok(None);
        }
        if self.read >= MAX_IMAGE_READ_BYTES {
            limit_skip(feature, "read");
            return Ok(None);
        }
        let remaining = MAX_IMAGES_TOTAL_BYTES - self.total;
        let mut budget = MAX_IMAGE_BYTES.min(remaining);
        let allowed = budget;
        let mut unread = false; // 선언 크기만 보고 풀지 않고 거른 경우
        let read = {
            let mut f = zip
                .by_name(entry)
                .map_err(|e| AppError::Validation(format!("image entry is unreadable: {e}")))?;
            let declared = f.size();
            if declared > allowed {
                unread = true;
                Err(AppError::Validation("declared image size exceeds the limit".to_string()))
            } else {
                read_entry_bytes_capped(&mut f, &mut budget)
            }
        };
        let bytes = match read {
            Ok(b) => b,
            // 그림 한 장이 상한을 넘었다고 문서 전체를 버리지 않는다.
            Err(AppError::Validation(_)) => {
                // 읽다가 끊긴 경우의 바이트(상한 + 1)도 푼 양에 센다 — 헤더 크기를 속인 엔트리가 줄지어도 총량으로 끝난다.
                if !unread {
                    self.read = self.read.saturating_add(allowed + 1);
                }
                limit_skip(feature, if allowed < MAX_IMAGE_BYTES { "total" } else { "size" });
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let len = bytes.len() as u64;
        self.read = self.read.saturating_add(len);
        self.total += len; // len <= allowed <= remaining 이라 총량 상한을 넘지 않는다
        let name = entry.rsplit('/').next().unwrap_or("image").to_string();
        self.images.push(ImageData { name, bytes });
        Ok(Some(self.images.len() - 1))
    }
}

/// 상한 때문에 그림을 건너뛴 것 — 사용자에겐 `image_limit` 개수로, 진단에는 이유 한 줄(개수만, 이름·경로 없음).
fn limit_skip(feature: &'static str, why: &str) {
    crate::diag::warn(feature, "image_limit", format!("skipped an image ({why} limit)"));
}
