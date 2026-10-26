/**
 * 엔드포인트가 이 기기(루프백)를 가리키는지. 호스트만 보고 판단한다.
 * 백엔드 `repo::ai::is_loopback_endpoint` 와 동일: scheme 제거, userinfo `@` 제거 후 host.
 * 빈 문자열은 loopback 이 아니다(ollama 기본 로컬은 호출부가 따로 처리).
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const schemeIdx = endpoint.indexOf("://");
  const rest = schemeIdx >= 0 ? endpoint.slice(schemeIdx + 3) : endpoint;
  const atIdx = rest.lastIndexOf("@");
  const afterUserinfo = atIdx >= 0 ? rest.slice(atIdx + 1) : rest;
  const hostPort = afterUserinfo.split(/[/?#]/, 1)[0] ?? afterUserinfo;
  let host: string;
  if (hostPort.startsWith("[")) {
    const end = hostPort.slice(1);
    const close = end.indexOf("]");
    host = close >= 0 ? end.slice(0, close) : end;
  } else {
    const colon = hostPort.lastIndexOf(":");
    host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  }
  host = host.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}
