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
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))  # serve this project regardless of cwd


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5179
    print(f'No-cache dev server on http://localhost:{port}  (serving {ROOT})')
    HTTPServer(('', port), partial(NoCacheHandler, directory=ROOT)).serve_forever()
