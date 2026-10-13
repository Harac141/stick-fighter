
import http.server, functools, sys, os
ROOT = "/home/caleb/stick-fighter"
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()
    def do_PUT(self):
        # Editor "share" export: PUT js/custom.js writes the custom-levels
        # script so a LAN device can load the same maps without localStorage.
        # Dev-server only — GitHub Pages has no PUT, the editor treats this as optional.
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        path = self.path.split("?")[0].lstrip("/")
        full = os.path.normpath(os.path.join(ROOT, path))
        if not full.startswith(ROOT) or not full.endswith(".js"):
            self.send_error(403); return
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")
http.server.test(HandlerClass=functools.partial(NoCache, directory=ROOT), port=8000)
