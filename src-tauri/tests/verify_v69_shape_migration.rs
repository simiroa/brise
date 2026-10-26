// v69 마이그레이션 변환기(convert_mermaid_flowchart_to_json)의 노드 도형 파서 검증.
// 지원 도형 5종(rect/round/stadium/circle/diamond) 외의 mermaid 래퍼를 만나면
// 가장 바깥 대괄호만 벗기고 나머지를 라벨에 흘리던 버그(2026-09-04 실측) 회귀 테스트.
use brise_lib::db::migrations::convert_mermaid_flowchart_to_json;
use serde_json::Value;

fn ir(source: &str) -> Value {
    let json = convert_mermaid_flowchart_to_json(source).expect("convert");
    serde_json::from_str(&json).expect("valid json")
}

fn node<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id)
        .unwrap_or_else(|| panic!("node {id} not found"))
}

#[test]
fn people() {
    let v = ir(
        "flowchart TD\n  n1[\"팀장\"] -->|\"선임 레포트\"| n2[\"디자이너\"]\n  n2 <-->|\"협업\"| n3[\"기획자\"]\n  n3 --> n4[\"인턴\"]\n  n4 --> n1",
    );
    assert_eq!(v["nodes"].as_array().unwrap().len(), 4);
    let edges = v["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 4);
    assert_eq!(edges[0]["label"], "선임 레포트");
    assert_eq!(edges[1]["label"], "협업");
    assert_eq!(edges[1]["arrow"], "both");
}

#[test]
fn process() {
    let v = ir("flowchart TD\n  n4 -.->|\"피드백 수집\"| n1");
    let edges = v["edges"].as_array().unwrap();
    assert_eq!(edges[0]["line"], "dotted");
    assert_eq!(edges[0]["label"], "피드백 수집");
}

#[test]
fn decision() {
    let v = ir("flowchart TD\n  n1{\"구매 여부 결정\"}\n  n4([\"즉시 구매\"])");
    assert_eq!(node(&v, "n1")["shape"], "diamond");
    assert_eq!(node(&v, "n4")["shape"], "stadium");
}

#[test]
fn system_cylinder_labels_dont_leak() {
    // 실측 실패 사례: 실린더(DB) 래퍼가 rect 로 잘못 매칭돼 괄호·따옴표가 라벨로 샜다.
    let v = ir("flowchart TD\n  n4[(\"메인 DB\")]\n  n5[(\"Redis 캐시\")]\n  n4 --> n5");
    let n4 = node(&v, "n4");
    assert_eq!(n4["label"], "메인 DB");
    assert_eq!(n4["shape"], "circle");
    let n5 = node(&v, "n5");
    assert_eq!(n5["label"], "Redis 캐시");
    assert_eq!(n5["shape"], "circle");
}

#[test]
fn chain() {
    let v = ir("flowchart TD\n  A[\"가\"] --> B[\"나\"] --> C[\"다\"]");
    assert_eq!(v["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(v["edges"].as_array().unwrap().len(), 2);
}

#[test]
fn subgraph() {
    let v = ir("flowchart TD\n  subgraph g1[\"집현전\"]\n    A[\"가\"]\n    B[\"나\"]\n  end");
    assert_eq!(v["groups"].as_array().unwrap().len(), 1);
    assert_eq!(v["groups"][0]["id"], "g1");
    let a = node(&v, "A");
    let b = node(&v, "B");
    assert_eq!(a["group"], "g1");
    assert_eq!(b["group"], "g1");
}

#[test]
fn thick_open() {
    let v = ir("flowchart TD\n  A ==>|\"굵게\"| B\n  B --- C");
    let edges = v["edges"].as_array().unwrap();
    assert_eq!(edges[0]["line"], "thick");
    assert_eq!(edges[0]["label"], "굵게");
    assert_eq!(edges[1]["arrow"], "none");
}

#[test]
fn subroutine_shape() {
    let v = ir("flowchart TD\n  n1[[\"처리\"]]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "처리");
    assert_eq!(n1["shape"], "rect");
}

#[test]
fn parallelogram_shape() {
    let v = ir("flowchart TD\n  n1[/\"입력\"/]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "입력");
    assert_eq!(n1["shape"], "rect");
}

#[test]
fn parallelogram_inv_shape() {
    let v = ir("flowchart TD\n  n1[\\\"출력\"\\]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "출력");
    assert_eq!(n1["shape"], "rect");
}

#[test]
fn trapezoid_shape() {
    let v = ir("flowchart TD\n  n1[/\"판단\"\\]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "판단");
    assert_eq!(n1["shape"], "rect");
}

#[test]
fn trapezoid_inv_shape() {
    let v = ir("flowchart TD\n  n1[\\\"판단\"/]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "판단");
    assert_eq!(n1["shape"], "rect");
}

#[test]
fn hexagon_shape() {
    let v = ir("flowchart TD\n  n1{{\"관문\"}}");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "관문");
    assert_eq!(n1["shape"], "diamond");
}

#[test]
fn double_circle_shape() {
    let v = ir("flowchart TD\n  n1(((\"핵\")))");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "핵");
    assert_eq!(n1["shape"], "circle");
}

#[test]
fn asymmetric_flag_shape() {
    let v = ir("flowchart TD\n  n1>\"깃발\"]");
    let n1 = node(&v, "n1");
    assert_eq!(n1["label"], "깃발");
    assert_eq!(n1["shape"], "rect");
}
