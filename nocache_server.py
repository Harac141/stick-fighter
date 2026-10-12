
import http.server, functools, sys
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()
http.server.test(HandlerClass=functools.partial(NoCache, directory="/home/caleb/stick-fighter"), port=8000)
