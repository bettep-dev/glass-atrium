"""Stand-in for the monitor's queue routes in the session-side bats suites.

Binds 127.0.0.1 on an OS-chosen port, writes the port to argv[1], appends one JSON line per
request (method, path, headers, body) to argv[2], and answers with the status and body held in
argv[3] (first line the status, the rest the body) → a test sets the reply per row.
A file `<argv[3]>.<n>` answers the n-th request instead (1-based) → a test sets a reply sequence.
A status line of `hang` holds the request open past every client timeout.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT_FILE, LOG_FILE, REPLY_FILE = sys.argv[1], sys.argv[2], sys.argv[3]
request_count = 0


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.answer(b"")

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        self.answer(self.rfile.read(length))

    def answer(self, body):
        global request_count
        request_count += 1
        record = {
            "method": self.command,
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": body.decode("utf-8", "replace"),
        }
        with open(LOG_FILE, "a", encoding="utf-8") as log:
            log.write(json.dumps(record) + "\n")
        sequenced = f"{REPLY_FILE}.{request_count}"
        with open(sequenced if os.path.exists(sequenced) else REPLY_FILE, encoding="utf-8") as reply:
            status, _, payload = reply.read().partition("\n")
        if status == "hang":
            time.sleep(30)
            return
        encoded = payload.encode("utf-8")
        self.send_response(int(status))
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE + ".tmp", "w", encoding="utf-8") as port_file:
    port_file.write(str(server.server_address[1]))
# rename → a reader never sees a half-written port
os.replace(PORT_FILE + ".tmp", PORT_FILE)
server.serve_forever()
