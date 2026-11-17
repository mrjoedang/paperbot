# Local preview of site/ at http://localhost:8411: never cached (edits show on reload), gzip like Cloudflare.
# python3 tools/site/serve.py site [port]
import sys, gzip, os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
TEXT = ('.html', '.css', '.js', '.json', '.svg', '.glb')
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_GET(self):
        path = self.translate_path(self.path.split('?')[0])
        if os.path.isdir(path): path = os.path.join(path, 'index.html')
        if path.endswith(TEXT) and os.path.isfile(path) and 'gzip' in self.headers.get('Accept-Encoding', ''):
            body = gzip.compress(open(path, 'rb').read(), 6)
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8411
print(f'paperbot.ca preview: http://localhost:{PORT}', flush=True)
ThreadingHTTPServer(('0.0.0.0', PORT), partial(Handler, directory=sys.argv[1])).serve_forever()
