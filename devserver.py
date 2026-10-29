#!/usr/bin/env python3
"""Dev static server that tells the browser NEVER to cache.

Safari (and others) cache ES modules aggressively and will happily serve a
stale src/*.js after you edit it, producing "half-updated" bundles where one
module calls a method another (cached) module doesn't have yet. Sending
`Cache-Control: no-store` on every response forces a fresh fetch of every file
on each reload, so a normal Reload always runs the latest code.

Usage:  python3 devserver.py [port]   (default 5179)
"""
import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))  # serve this project regardless of cwd


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet

    def do_POST(self):
        """/crew/chat/completions: forward the crew's chat requests to an OpenAI-style server with a key that stays in this
        process's environment (NVIDIA_API_KEY, optional RAWAH_CREW_UPSTREAM). Local use only; with no key it answers 501."""
        if not self.path.startswith('/crew/'):
            self.send_error(404)
            return
        key = os.environ.get('NVIDIA_API_KEY')
        if not key:
            self.send_error(501, 'set NVIDIA_API_KEY to use the crew proxy')
            return
        upstream = os.environ.get('RAWAH_CREW_UPSTREAM', 'https://integrate.api.nvidia.com/v1').rstrip('/')
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        req = urllib.request.Request(upstream + self.path[len('/crew'):], data=body, method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, status = e.read(), e.code
        except Exception as e:
            data, status = str(e).encode(), 502
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5179
    print(f'No-cache dev server on http://localhost:{port}  (serving {ROOT})')
    ThreadingHTTPServer(('', port), partial(NoCacheHandler, directory=ROOT)).serve_forever()
