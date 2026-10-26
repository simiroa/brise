# 보안 정책 (Security Policy)

## 취약점 신고
보안 문제를 발견하면 공개 이슈로 올리지 말고 **GitHub의 비공개 신고**를 이용해 주세요.

저장소의 **Security → Report a vulnerability**에서 신고하면 저에게만 전달됩니다.
재현 방법, 영향 범위, 사용한 버전을 적어 주시면 확인하는 데 큰 도움이 됩니다.

개인 프로젝트라 응답 시간을 보장하지는 못하지만, 확인되는 대로 회신하고 수정이 나오면 릴리즈 노트에 적겠습니다.

## 지원 버전
가장 최근 릴리즈만 수정 대상입니다. 현재는 Windows 데스크톱 앱이 대상이고, 아직 베타(Pre-release)입니다.

## 알아 둘 설계
- 동기화 서버는 같은 Tailscale 네트워크의 기기(없으면 이 PC의 루프백)에만 열리고, 모든 요청에 토큰이 필요합니다. 토큰을 아는 사람은 노트를 읽고 쓸 수 있습니다. 토큰이 노출되면 설정에서 재발급하세요.
- 노트와 설정(토큰·AI 키 포함)은 이 기기의 로컬 데이터 폴더에 저장됩니다.

---

Please report vulnerabilities privately via GitHub: **Security → Report a vulnerability**. Do not open a public issue.
