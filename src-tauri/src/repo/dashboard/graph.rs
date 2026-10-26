use crate::error::{db as dberr, AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection};
use serde::Serialize;
use std::collections::HashMap;

use super::ensure_workspace;

pub const GRAPH_NODE_CAP: i64 = 500;
pub const GRAPH_EDGE_CAP: i64 = 2500;
const RELATED_PER_NODE: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GraphNode {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    pub year: i64,
    pub snippet: String,
    pub degree: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub weight: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GraphResult {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub total: i64,
    pub cap: i64,
    pub capped: bool,
    pub edge_total: i64,
    pub edge_cap: i64,
    pub edges_capped: bool,
}

pub fn graph(conn: &Connection, workspace_id: &str, limit: Option<i64>) -> AppResult<GraphResult> {
    ensure_workspace(conn, workspace_id)?;
    let cap = limit.unwrap_or(GRAPH_NODE_CAP);
    if cap < 1 {
        return Err(AppError::Validation("limit must be at least 1".to_string()));
    }
    let cap = cap.min(GRAPH_NODE_CAP);

    let mut stmt = conn.prepare(NODES_SQL).map_err(dberr)?;
    let mut total = 0;
    let mut nodes: Vec<GraphNode> = stmt
        .query_map(params![workspace_id, cap], |r| {
            total = r.get(6)?;
            Ok(GraphNode {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                title: r.get(2)?,
                year: r.get(3)?,
                snippet: r.get(4)?,
                degree: 0,
            })
        })
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    if nodes.is_empty() {
        return Ok(GraphResult {
            nodes,
            edges: Vec::new(),
            total,
            cap,
            capped: total > cap,
            edge_total: 0,
            edge_cap: GRAPH_EDGE_CAP,
            edges_capped: false,
        });
    }

    let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");

    let backlink_sql = format!(
        "SELECT a.note_id, a.url, COUNT(*) * 100, COUNT(*) OVER ()
         FROM attachments a
         WHERE a.kind='internal'
           AND a.note_id IN ({placeholders}) AND a.url IN ({placeholders})
         GROUP BY a.note_id, a.url
         ORDER BY a.note_id, a.url
         LIMIT ?{}",
        ids.len() + 1
    );
    let mut backlink_stmt = conn.prepare(&backlink_sql).map_err(dberr)?;
    let mut backlink_binds: Vec<rusqlite::types::Value> =
        ids.iter().map(|id| rusqlite::types::Value::Text((*id).to_string())).collect();
    backlink_binds.push((GRAPH_EDGE_CAP + 1).into());
    let mut backlink_total = 0;
    let mut edges: Vec<GraphEdge> = backlink_stmt
        .query_map(params_from_iter(backlink_binds.iter()), |r| {
            backlink_total = r.get(3)?;
            Ok(GraphEdge {
                source: r.get(0)?,
                target: r.get(1)?,
                kind: "backlink".to_string(),
                weight: r.get(2)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(backlink_stmt);

    let related_sql = related_sql(&placeholders);
    let mut related_stmt = conn.prepare(&related_sql).map_err(dberr)?;
    let related = related_stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok(GraphEdge {
                source: r.get(0)?,
                target: r.get(1)?,
                kind: "related".to_string(),
                weight: r.get(2)?,
            })
        })
        .map_err(dberr)?;
    let mut overlap_items = Vec::new();
    let mut payloads = Vec::new();
    for row in related {
        let edge = row.map_err(dberr)?;
        payloads.push(format!(r#"{{"source":"dashboard_graph","score":{}}}"#, edge.weight));
        edges.push(edge);
    }
    for (i, edge) in edges.iter().enumerate().skip(edges.len() - payloads.len()) {
        let payload = &payloads[i - (edges.len() - payloads.len())];
        overlap_items.push(crate::repo::suggestions::OverlapItem {
            note_a: &edge.source,
            note_b: &edge.target,
            score: edge.weight as f32,
            payload,
        });
    }
    crate::repo::suggestions::upsert_overlap_batch(conn, workspace_id, &overlap_items)?;

    let mut node_indexes: HashMap<String, usize> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        node_indexes.insert(node.id.clone(), index);
    }
    for edge in &edges {
        if let Some(index) = node_indexes.get(edge.source.as_str()) {
            nodes[*index].degree += 1;
        }
        if let Some(index) = node_indexes.get(edge.target.as_str()) {
            nodes[*index].degree += 1;
        }
    }

    edges.sort_by(|a, b| {
        (a.kind != "backlink", &a.source, &a.target)
            .cmp(&(b.kind != "backlink", &b.source, &b.target))
    });
    let related_total = edges.iter().filter(|edge| edge.kind == "related").count() as i64;
    let edge_total = backlink_total + related_total;
    edges.truncate(GRAPH_EDGE_CAP as usize);

    Ok(GraphResult {
        nodes,
        edges,
        total,
        cap,
        capped: total > cap,
        edge_total,
        edge_cap: GRAPH_EDGE_CAP,
        edges_capped: edge_total > GRAPH_EDGE_CAP,
    })
}

const NODES_SQL: &str = "
WITH alive AS MATERIALIZED (
  SELECT n.id, n.folder_id, n.title, n.year, n.updated_at
  FROM notes n
  JOIN folders f ON f.id=n.folder_id
  WHERE f.workspace_id=?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
),
links AS MATERIALIZED (
  -- 2026-09-13 실측(10만 노트 + 내부링크 첨부 14,994개): alive 는 MATERIALIZED CTE 라 SQLite 가
  -- 자동 인덱스를 안 붙여준다 — a.note_id/a.url 을 alive 로 두 번 조인하면 첨부 행마다 alive
  -- 10만 행을 스캔해 273ms 가 37.2초로 뛰었다. 같은 조건(workspace/미삭제/미보관)을 alive 재사용
  -- 대신 notes/folders 원본 인덱스(PK)로 다시 걸어 인덱스 조인이 되게 한다.
  SELECT a.note_id AS src, a.url AS dst
  FROM attachments a
  JOIN notes ns ON ns.id = a.note_id AND ns.deleted_at IS NULL AND ns.archived_at IS NULL
  JOIN folders nf ON nf.id = ns.folder_id AND nf.workspace_id = ?1
  JOIN notes nd ON nd.id = a.url AND nd.deleted_at IS NULL AND nd.archived_at IS NULL
  JOIN folders df ON df.id = nd.folder_id AND df.workspace_id = ?1
  WHERE a.kind = 'internal'
),
deg AS (
  SELECT id, COUNT(*) AS link_degree FROM (
    SELECT src AS id FROM links
    UNION ALL
    SELECT dst FROM links WHERE dst <> src
  ) GROUP BY id
)
SELECT n.id, n.folder_id, n.title, n.year,
       COALESCE((SELECT SUBSTR(s.body_md, 1, 180) FROM sections s
                 WHERE s.note_id=n.id AND s.kind='text' ORDER BY s.position LIMIT 1), ''),
       COALESCE(deg.link_degree, 0) AS link_degree,
       (SELECT COUNT(*) FROM alive)
FROM alive n LEFT JOIN deg ON deg.id = n.id
ORDER BY link_degree DESC, n.updated_at DESC, n.id
LIMIT ?2";

fn related_sql(placeholders: &str) -> String {
    format!(
        "WITH selected AS MATERIALIZED (
           SELECT n.id, n.year, n.month, n.day
           FROM notes n WHERE n.id IN ({placeholders})
         ), tag_scores AS MATERIALIZED (
           -- 2026-09-13 실측(10만 노트): note_tags 를 selected 로 좁히기 전에 자기조인하면
           -- head 태그(수천 노트 공유) 쪽에서 조합 폭발이 나 related_sql 이 320초까지 늘어난다
           -- (docs/reviews 참고). note_id IN (SELECT id FROM selected) 를 서브쿼리 안에서 먼저
           -- 적용해 각 변을 최대 |selected|(<=500) 행으로 자른 뒤에 자기조인해야 한다.
           SELECT ta.note_id source, tb.note_id target, COUNT(DISTINCT ta.tag_id) shared_tags
           FROM (SELECT note_id, tag_id FROM note_tags WHERE note_id IN (SELECT id FROM selected)) ta
           JOIN (SELECT note_id, tag_id FROM note_tags WHERE note_id IN (SELECT id FROM selected)) tb
             ON tb.tag_id=ta.tag_id AND ta.note_id<tb.note_id
           GROUP BY ta.note_id, tb.note_id
         ), attachment_scores AS MATERIALIZED (
           -- 위와 같은 이유로 attachments 도 selected 로 먼저 좁힌다(content_hash 공유가 많은
           -- 노트북에서 같은 조합 폭발).
           SELECT aa.note_id source, ab.note_id target,
                  COUNT(DISTINCT aa.content_hash) shared_attachments
           FROM (SELECT note_id, content_hash FROM attachments
                   WHERE note_id IN (SELECT id FROM selected) AND content_hash IS NOT NULL) aa
           JOIN (SELECT note_id, content_hash FROM attachments
                   WHERE note_id IN (SELECT id FROM selected) AND content_hash IS NOT NULL) ab
             ON ab.content_hash=aa.content_hash AND aa.note_id<ab.note_id
           GROUP BY aa.note_id, ab.note_id
         ), cand AS (
           SELECT a.id source, b.id target FROM selected a JOIN selected b ON a.id < b.id AND a.year = b.year
           UNION
           SELECT source, target FROM tag_scores
           UNION
           SELECT source, target FROM attachment_scores
         ), pairs AS (
           SELECT c.source, c.target, sa.year ay, sb.year by, sa.month am, sb.month bm, sa.day ad, sb.day bd
           FROM cand c JOIN selected sa ON sa.id = c.source JOIN selected sb ON sb.id = c.target
         ), link_pairs AS (
           SELECT MIN(a.note_id, a.url) source, MAX(a.note_id, a.url) target
           FROM attachments a JOIN selected s1 ON s1.id=a.note_id JOIN selected s2 ON s2.id=a.url
           WHERE a.kind='internal' GROUP BY source, target
         ), scored AS (
           SELECT source, target,
                  (CASE WHEN ay=by AND (am IS NULL OR bm IS NULL OR
                         (am=bm AND (ad IS NULL OR bd IS NULL OR ad=bd))) THEN 30 ELSE 0 END
                   + COALESCE(attachment_scores.shared_attachments, 0) * 15
                   + COALESCE(tag_scores.shared_tags, 0) * 10
                   + MAX(0, 10 - ABS(ay-by) / 10)) AS score
           FROM pairs
           LEFT JOIN tag_scores USING(source, target)
           LEFT JOIN attachment_scores USING(source, target)
           LEFT JOIN link_pairs USING(source, target)
           WHERE link_pairs.source IS NULL
             AND NOT EXISTS (SELECT 1 FROM note_related_exclusions x
                             WHERE (x.id_1=source AND x.id_2=target) OR
                                   (x.id_1=target AND x.id_2=source))
         ), directed AS (
           SELECT source center, target neighbor, score FROM scored WHERE score>=25
           UNION ALL
           SELECT target, source, score FROM scored WHERE score>=25
         ), ranked AS (
           SELECT center, neighbor, score,
                  ROW_NUMBER() OVER (PARTITION BY center ORDER BY score DESC, neighbor) rank
           FROM directed
         ), top_pairs AS (
           SELECT MIN(center, neighbor) source, MAX(center, neighbor) target, MAX(score) score
           FROM ranked WHERE rank<={RELATED_PER_NODE}
           GROUP BY source, target HAVING COUNT(*)=2
         )
         SELECT source, target, score FROM top_pairs
         ORDER BY score DESC, source, target"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{attachments, notes, workspaces};
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn seeded(conn: &Connection) -> (String, String) {
        let ws = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        (ws, folder)
    }

    #[test]
    fn graph_is_scoped_and_filters_archived_notes() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);
        let a = notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap();
        let b = notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap();
        let archived = notes::create(&mut conn, &folder, Some("old".into()), Some(2000)).unwrap();
        notes::archive(&mut conn, &archived.note.id).unwrap();
        attachments::add_internal(&mut conn, &a.note.id, &b.note.id, "B").unwrap();

        let other = workspaces::create(&mut conn, "Other").unwrap();
        let other_folder: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1",
                [&other.id],
                |r| r.get(0),
            )
            .unwrap();
        notes::create(&mut conn, &other_folder, Some("outside".into()), Some(2000)).unwrap();

        let out = graph(&conn, &ws, None).unwrap();
        assert_eq!(out.total, 2);
        assert_eq!(out.nodes.len(), 2);
        assert_eq!(out.edges.len(), 1);
        assert_eq!(out.edges[0].kind, "backlink");
        assert_eq!(out.edges[0].weight, 100);
        assert!(out.nodes.iter().all(|n| n.degree == 1));
    }

    /// NODES_SQL 의 link_degree 컬럼(인덱스 5) semantics 를 SQL 재작성 전에 고정한다.
    /// 비대칭 링크(A→B, B→C, C→A) + 중복 링크(A→B 재입력) + 자기 링크(A→A) + archived 노트가
    /// 낀 링크(D→C, D 는 archived) 를 섞어, 각 alive 노트의 link_degree 기대값을 assert 로 박는다.
    #[test]
    fn nodes_sql_link_degree_semantics() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);
        let a = notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap();
        let b = notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap();
        let c = notes::create(&mut conn, &folder, Some("C".into()), Some(2000)).unwrap();
        let d = notes::create(&mut conn, &folder, Some("D".into()), Some(2000)).unwrap();
        notes::archive(&mut conn, &d.note.id).unwrap();

        attachments::add_internal(&mut conn, &a.note.id, &b.note.id, "link").unwrap();
        attachments::add_internal(&mut conn, &a.note.id, &b.note.id, "link").unwrap(); // 중복
        attachments::add_internal(&mut conn, &b.note.id, &c.note.id, "link").unwrap();
        attachments::add_internal(&mut conn, &c.note.id, &a.note.id, "link").unwrap();
        attachments::add_internal(&mut conn, &a.note.id, &a.note.id, "link").unwrap(); // 자기 링크
        attachments::add_internal(&mut conn, &d.note.id, &c.note.id, "link").unwrap(); // archived 낀 링크

        let mut stmt = conn.prepare(NODES_SQL).unwrap();
        let degrees: HashMap<String, i64> = stmt
            .query_map(params![ws, GRAPH_NODE_CAP], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(5)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(stmt);

        // D 는 archived 라 alive 노드 목록에 아예 없다 — 3개 노드만 나와야 한다.
        assert_eq!(degrees.len(), 3);
        // A: A→B, A→B(중복), C→A, A→A(자기 링크는 OR 조건이라 1만) = 4
        assert_eq!(degrees.get(a.note.id.as_str()), Some(&4));
        // B: A→B, A→B(중복), B→C = 3
        assert_eq!(degrees.get(b.note.id.as_str()), Some(&3));
        // C: B→C, C→A = 2 (D→C 는 D 가 archived 라 제외)
        assert_eq!(degrees.get(c.note.id.as_str()), Some(&2));
    }

    #[test]
    fn graph_caps_nodes_and_returns_related_without_backlink_duplicates() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);
        let a = notes::create(&mut conn, &folder, Some("A".into()), Some(1999)).unwrap();
        let b = notes::create(&mut conn, &folder, Some("B".into()), Some(1999)).unwrap();
        let c = notes::create(&mut conn, &folder, Some("C".into()), Some(1999)).unwrap();
        attachments::add_internal(&mut conn, &a.note.id, &b.note.id, "B").unwrap();

        let out = graph(&conn, &ws, Some(5000)).unwrap();
        assert_eq!(out.cap, GRAPH_NODE_CAP);
        assert_eq!(out.total, 3);
        assert!(out.edges.iter().any(|e| e.kind == "backlink"));
        assert!(out
            .edges
            .iter()
            .any(|e| e.kind == "related" && (e.source == c.note.id || e.target == c.note.id)));
        assert!(!out.edges.iter().any(|e| e.kind == "related"
            && ((e.source == a.note.id && e.target == b.note.id)
                || (e.source == b.note.id && e.target == a.note.id))));

        let limited = graph(&conn, &ws, Some(1)).unwrap();
        assert_eq!(
            (limited.nodes.len(), limited.total, limited.cap, limited.capped),
            (1, 3, 1, true)
        );
    }

    #[test]
    fn graph_rejects_zero_limit() {
        let conn = setup_db();
        let (ws, _) = seeded(&conn);
        assert!(matches!(
            graph(&conn, &ws, Some(0)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn graph_reports_when_the_deterministic_edge_cap_is_hit() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);
        let note_ids: Vec<String> = (0..51)
            .map(|i| {
                notes::create(&mut conn, &folder, Some(format!("N{i}")), Some(2000))
                    .unwrap()
                    .note
                    .id
            })
            .collect();
        let now = crate::util::now_iso();
        for (source_pos, source) in note_ids.iter().enumerate() {
            for (target_pos, target) in note_ids.iter().enumerate() {
                if source != target {
                    conn.execute(
                        "INSERT INTO attachments(id, note_id, name, kind, url, position, created_at)
                         VALUES (?1, ?2, 'link', 'internal', ?3, ?4, ?5)",
                        rusqlite::params![
                            crate::util::new_id(),
                            source,
                            target,
                            (source_pos * note_ids.len() + target_pos) as i64,
                            now,
                        ],
                    )
                    .unwrap();
                }
            }
        }

        let out = graph(&conn, &ws, None).unwrap();
        assert_eq!(out.edge_cap, GRAPH_EDGE_CAP);
        assert_eq!(out.edge_total, 51 * 50);
        assert_eq!(out.edges.len() as i64, GRAPH_EDGE_CAP);
        assert!(out.edges_capped);
        assert!(out.edges.windows(2).all(|pair| {
            (&pair[0].source, &pair[0].target) <= (&pair[1].source, &pair[1].target)
        }));
    }

    /// `related_sql` 재작성(고정비 제거) 전 동치 고정 테스트. 스코어 산식(같은날짜 CASE 30 +
    /// shared_attachments*15 + shared_tags*10 + 연도근접 max(0,10-|Δyear|/10), 임계 score>=25)이
    /// 재작성 후에도 동일한 related 엣지 집합을 내는지 이 스냅샷으로 고정한다.
    ///
    /// 후보 판별 근거: 연도근접 단독 최대가 10이라 25에 못 미치므로, score>=25 인 쌍은 반드시
    /// (연도 일치) OR (공유 태그>=1) OR (공유 첨부>=1) 중 하나를 만족해야 한다 — 재작성이 크로스
    /// 조인 대신 이 세 후보의 합집합만 스코어링해도 결과가 같아야 한다는 뜻.
    #[test]
    fn related_sql_scores_pairs_by_date_tag_and_attachment_overlap() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);

        // case 1: 같은 연도, 월 NULL → CASE 30 + 근접 10 = 40 (포함)
        let a = notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap();
        let b = notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap();

        // case 2: 다른(가까운) 연도, 공유 태그 1 + 공유 첨부 1 → 10+15+10 = 35 (포함)
        let c = notes::create(&mut conn, &folder, Some("C".into()), Some(1950)).unwrap();
        let d = notes::create(&mut conn, &folder, Some("D".into()), Some(1951)).unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &c.note.id, vec!["shared1".into()]).unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &d.note.id, vec!["shared1".into()]).unwrap();
        for note_id in [&c.note.id, &d.note.id] {
            conn.execute(
                "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
                 VALUES (?1, ?2, 'img', 'image', 'dummy.png', NULL, 100, 0, ?3, 'hash-c-d')",
                params![crate::util::new_id(), note_id, crate::util::now_iso()],
            )
            .unwrap();
        }

        // case 3: 다른(가까운) 연도, 공유 태그 1 만 → 10+10 = 20 (제외되어야 함)
        let e = notes::create(&mut conn, &folder, Some("E".into()), Some(1960)).unwrap();
        let f = notes::create(&mut conn, &folder, Some("F".into()), Some(1961)).unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &e.note.id, vec!["tagE".into()]).unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &f.note.id, vec!["tagE".into()]).unwrap();

        // case 4: 다른(가까운) 연도, 공유 태그 2 → 20+10 = 30 (포함)
        let g = notes::create(&mut conn, &folder, Some("G".into()), Some(1970)).unwrap();
        let h = notes::create(&mut conn, &folder, Some("H".into()), Some(1971)).unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &g.note.id, vec!["tagA".into(), "tagB".into()])
            .unwrap();
        crate::repo::note_tags::set_tags(&mut conn, &h.note.id, vec!["tagA".into(), "tagB".into()])
            .unwrap();

        // case 5: 내부 링크로 이미 연결된 같은 연도 쌍 → 점수는 40(같은날짜) 이지만 link_pairs
        // 필터로 related 에서 제외되고 backlink 로만 잡힌다.
        let i = notes::create(&mut conn, &folder, Some("I".into()), Some(1980)).unwrap();
        let j = notes::create(&mut conn, &folder, Some("J".into()), Some(1980)).unwrap();
        attachments::add_internal(&mut conn, &i.note.id, &j.note.id, "link").unwrap();

        // case 6: note_related_exclusions 에 넣은 같은 연도 쌍 → 점수는 40 이지만 제외
        let k = notes::create(&mut conn, &folder, Some("K".into()), Some(1990)).unwrap();
        let l = notes::create(&mut conn, &folder, Some("L".into()), Some(1990)).unwrap();
        conn.execute(
            "INSERT INTO note_related_exclusions(id_1, id_2, created_at) VALUES (?1, ?2, ?3)",
            params![k.note.id, l.note.id, crate::util::now_iso()],
        )
        .unwrap();

        let out = graph(&conn, &ws, None).unwrap();

        let related: std::collections::HashSet<(String, String, i64)> = out
            .edges
            .iter()
            .filter(|e| e.kind == "related")
            .map(|e| (e.source.clone(), e.target.clone(), e.weight))
            .collect();

        let pair = |x: &str, y: &str, w: i64| -> (String, String, i64) {
            if x < y {
                (x.to_string(), y.to_string(), w)
            } else {
                (y.to_string(), x.to_string(), w)
            }
        };
        let expected: std::collections::HashSet<(String, String, i64)> = [
            pair(&a.note.id, &b.note.id, 40),
            pair(&c.note.id, &d.note.id, 35),
            pair(&g.note.id, &h.note.id, 30),
        ]
        .into_iter()
        .collect();

        assert_eq!(related, expected);

        // I-J 는 link_pairs 필터로 related 에 없고 backlink 로만 존재해야 한다.
        assert!(out.edges.iter().any(
            |e| e.kind == "backlink" && ((e.source == i.note.id) || (e.target == i.note.id))
        ));
        assert!(!related.iter().any(|(s, t, _)| {
            (s == &i.note.id || t == &i.note.id) && (s == &j.note.id || t == &j.note.id)
        }));
    }

    #[test]
    fn graph_related_edges_feed_pending_overlap_suggestions_without_duplicates() {
        let mut conn = setup_db();
        let (ws, folder) = seeded(&conn);
        notes::create(&mut conn, &folder, Some("A".into()), Some(2000)).unwrap();
        notes::create(&mut conn, &folder, Some("B".into()), Some(2000)).unwrap();

        graph(&conn, &ws, None).unwrap();
        graph(&conn, &ws, None).unwrap();

        let suggestions = crate::repo::suggestions::list(&conn, &ws, "pending").unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].kind, "overlap");
        assert_eq!(suggestions[0].score, 40.0);
    }
}

/// W10 재판정용 구간 계측 (2026-08-21). `docs/reviews/2026-08-21-perf-stress.md` 참고.
///
/// 첫 실측은 `graph()` 를 통짜로만 재서 "N=1,000 에 1.5초"라는 고정비만 확인했고, 그게 어느
/// 구간인지 가르지 못했다. 게다가 `dev_seed` 가 `attachments` 를 하나도 안 넣어 내부 링크
/// 경로(`link_pairs`/`attachment_scores`)가 실행조차 되지 않았다 — 그 상태의 숫자로 SQL
/// 재작성을 정당화할 수 없다.
///
/// 실행: `cargo test --lib probe_graph_segments -- --ignored --nocapture`
/// (`#[ignore]` 이므로 평소 게이트에는 안 걸린다 — 수 초~수십 초짜리 측정이다.)
#[cfg(test)]
mod perf_probe {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;
    use std::time::Instant;

    fn ms(t: Instant) -> u128 {
        t.elapsed().as_millis()
    }

    fn probe_at(n_notes: usize, links_per_note: usize) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // 2026-09-13: db::open() 이 실제 앱 커넥션에 주는 PRAGMA(§below)를 맞춰도 이 하네스(:memory:)
        // 에서는 NODES_SQL(100k 노트 + 링크 3개/노트)이 여전히 수십 초~수분 걸린다 — 그런데 **똑같은
        // SQL·똑같은 데이터 모양(파일로 seed_corpus 출력을 옮겨 검증)을 node:sqlite 로 실제 파일
        // DB에 직접 돌리면 715~778ms** 다(EXPLAIN QUERY PLAN도 두 경우 다 동일하게 인덱스 SEARCH +
        // AUTOMATIC COVERING INDEX 로 잡힌다 — 플랜 자체는 정상). 즉 이 격차는 SQL이나 인덱스
        // 문제가 아니라 **`Connection::open_in_memory()` 특유의 무언가**(rusqlite 번들 SQLite
        // 버전, in-memory 전용 플래너 휴리스틱 등 — 미확인)로 보인다. 결론: 이 하네스의 절대
        // 시간을 실사용 예산 판정에 쓰지 말 것 — 파일 DB(진짜 앱이 항상 쓰는 형태)에서 재현되지
        // 않는 하네스 전용 현상이다. 링크 유무에 따른 *상대* 배율(고쳐지기 전 87,000× 폭발 등)은
        // 여전히 유효한 회귀 신호다. 아래 PRAGMA 는 실제 값과 최대한 맞춰두되(cache_size 등은
        // 그래도 유효), mmap_size 는 in-memory DB에는 적용되지 않는다.
        conn.pragma_update(None, "cache_size", -65536).unwrap();
        conn.pragma_update(None, "mmap_size", 268435456i64).unwrap();
        conn.pragma_update(None, "temp_store", "MEMORY").unwrap();
        migrations::run(&mut conn).unwrap();
        crate::dev_seed::seed_corpus(&mut conn, n_notes, 20, false, 42).unwrap();

        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // 내부 링크 심기 — 첫 실측의 사각지대였던 부분. 노트를 순서대로 늘어놓고 각 노트가
        // 뒤쪽 이웃 links_per_note 개를 가리키게 한다(체인형: 실제 노트북의 국소적 링크 밀도에
        // 가깝고, 완전 무작위보다 재현성이 좋다).
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM notes ORDER BY id LIMIT 5000")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let t_link = Instant::now();
        conn.execute_batch("BEGIN").unwrap();
        for (i, from) in ids.iter().enumerate() {
            for k in 1..=links_per_note {
                if let Some(to) = ids.get(i + k) {
                    let _ = crate::repo::attachments::add_internal(&mut conn, from, to, "link");
                }
            }
        }
        conn.execute_batch("COMMIT").unwrap();
        let link_ms = ms(t_link);

        let att: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();

        // ── 구간별 ──────────────────────────────────────────────────────────
        let cap = GRAPH_NODE_CAP;

        let t = Instant::now();
        let mut stmt = conn.prepare(NODES_SQL).unwrap();
        let node_ids: Vec<String> = stmt
            .query_map(params![&ws, cap], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(stmt);
        let nodes_ms = ms(t);

        let placeholders = (1..=node_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let binds: Vec<rusqlite::types::Value> = node_ids
            .iter()
            .map(|id| rusqlite::types::Value::Text(id.clone()))
            .collect();

        let t = Instant::now();
        let rsql = related_sql(&placeholders);
        let mut rstmt = conn.prepare(&rsql).unwrap();
        let related_rows: Vec<(String, String, i64)> = rstmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(rstmt);
        let related_ms = ms(t);
        let related_n = related_rows.len();

        // upsert_overlap 루프만 따로 — 읽기 쿼리 안에 섞인 쓰기다(트랜잭션 없음).
        let t = Instant::now();
        for (src, dst, w) in &related_rows {
            crate::repo::suggestions::upsert_overlap(
                &conn,
                &ws,
                src,
                dst,
                *w as f32,
                r#"{"source":"probe"}"#,
            )
            .unwrap();
        }
        let upsert_ms = ms(t);

        let t = Instant::now();
        let full = graph(&conn, &ws, None).unwrap();
        let full_ms = ms(t);

        println!(
            "N={n_notes:>6} links/note={links_per_note} attachments={att:>6} | \
             seed_link={link_ms:>5}ms  NODES_SQL={nodes_ms:>5}ms  related_sql={related_ms:>5}ms \
             (rows={related_n})  upsert_loop={upsert_ms:>5}ms  graph()={full_ms:>5}ms \
             | nodes={} edges={}",
            full.nodes.len(),
            full.edges.len()
        );
    }

    #[test]
    #[ignore]
    fn probe_graph_segments() {
        println!("\n=== graph() 구간 계측 (debug 프로파일) ===");
        // 규모는 환경변수로 — 기본은 짧게(게이트가 아니라 손으로 도는 측정이다).
        // PROBE_N=10000 PROBE_LINKS=0,3 cargo test --lib probe_graph_segments -- --ignored --nocapture
        let n: usize = std::env::var("PROBE_N").ok().and_then(|v| v.parse().ok()).unwrap_or(1_000);
        let links: Vec<usize> = std::env::var("PROBE_LINKS")
            .unwrap_or_else(|_| "0,3".to_string())
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        for l in links {
            probe_at(n, l);
        }
    }
}
