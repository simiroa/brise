"""가짜 PC 서버. Tailscale IP 에만 바인딩(0.0.0.0 금지). 포트 8803.

S1 검증용으로 Brise sync_server 의 `/app?token=` 흐름을 흉내낸다:
  GET /app            -> app.html (토큰을 sessionStorage 에 저장하고 URL 에서 지움, ping/SSE/권한/뒤로가기 테스트 UI)
  GET /api/v1/ping    -> Bearer(또는 ?token=) 검사, 틀리면 401
  GET /api/v1/events  -> SSE (인증 필요, ?token= 허용 — EventSource 는 헤더를 못 실으므로)
  GET /api/v1/headers -> 업스트림이 받은 요청 헤더(쿠키 제거 확인용)
토큰은 환경변수 FAKE_TOKEN (기본 'fake-token-123'). 기존 프로브 경로(/probe/, /api/ping ...)는 그대로 둔다.
"""
import json, os, subprocess, sys, time
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = 8803
HERE = os.path.dirname(os.path.abspath(__file__))
IP = subprocess.check_output(["tailscale", "ip", "-4"], text=True).split()[0]
assert IP.startswith("100."), IP
BIG = 20 * 1024 * 1024
TOKEN = os.environ.get("FAKE_TOKEN", "fake-token-123")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, f, *a):
        # 토큰이 로그에 남지 않게 요청 라인의 쿼리는 지운다.
        sys.stderr.write("%s %s\n" % (self.address_string(), (f % a).split("?")[0])); sys.stderr.flush()
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def _authed(self):
        q = parse_qs(urlparse(self.path).query)
        return self.headers.get("Authorization", "") == "Bearer " + TOKEN or q.get("token", [""])[0] == TOKEN
    def _sse(self):
        self.send_response(200); self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "close"); self.end_headers()
        try:
            for i in range(10):
                self.wfile.write(("data: %d %f\n\n" % (i, time.time())).encode()); self.wfile.flush(); time.sleep(1)
        except Exception: pass
        self.close_connection = True
    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/probe/", "/probe"):
            return self._send(200, open(os.path.join(HERE, "index.html"), "rb").read(), "text/html; charset=utf-8")
        if p == "/app":
            return self._send(200, open(os.path.join(HERE, "app.html"), "rb").read(), "text/html; charset=utf-8")
        if p == "/api/v1/ping":
            if not self._authed(): return self._send(401, b'{"error":"unauthorized"}')
            return self._send(200, b'{"app_version":"fake","schema_version":0,"device_id":"fake","workspace_count":1}')
        if p == "/api/v1/headers":
            return self._send(200, json.dumps(dict(self.headers.items())).encode())
        if p == "/api/v1/events":
            if not self._authed(): return self._send(401, b'{"error":"unauthorized"}')
            return self._sse()
        if p == "/api/ping": return self._send(200, b'{"pong":true}')
        if p == "/api/events": return self._sse()
        if p == "/api/big":
            self.send_response(200); self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(BIG)); self.end_headers()
            chunk = b"x" * 65536; left = BIG
            try:
                while left > 0:
                    n = min(left, len(chunk)); self.wfile.write(chunk[:n]); left -= n
            except Exception: pass
            return
        self._send(404, b'{"error":"nf"}')
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0); got = 0; data = []
        while got < n:
            b = self.rfile.read(min(65536, n - got))
            if not b: break
            got += len(b); data.append(b)
        return got, b"".join(data)
    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/echo":
            n, d = self._body(); return self._send(200, d + ("|len=%d" % n).encode(), "text/plain")
        if p == "/api/upload":
            n = int(self.headers.get("Content-Length") or 0); got = 0
            while got < n:
                b = self.rfile.read(min(65536, n - got))
                if not b: break
                got += len(b)
            return self._send(200, ('{"received":%d}' % got).encode())
        self._send(404, b'{"error":"nf"}')

if __name__ == "__main__":
    s = ThreadingHTTPServer((IP, PORT), H)
    print("listening", IP, PORT, "pid", os.getpid(), flush=True)
    s.serve_forever()
