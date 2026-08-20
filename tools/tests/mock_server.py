#!/usr/bin/env python3
"""Minimal mock MCP server used by the Biblos setup tool test suite.

Smoke-test / registration behaviour is driven by URL path prefix:

  /ok            -> 200 + valid JSON-RPC response
  /accepted      -> 202 + valid JSON-RPC response
  /unauthorized  -> 401 + JSON error
  /invalid       -> 200 + non-JSON body
  /empty         -> 200 + empty body
  /register-fail -> register requests (body contains "capabilities") get 500;
                    other requests (e.g. the smoke-test initialize call) get
                    200 + valid JSON-RPC response
  anything else  -> 200 + valid JSON-RPC response (e.g. /mcp)

Every request is appended as one JSON line to $MOCK_SERVER_LOG so tests can
assert method, path, headers, and body.

Usage: mock_server.py <port>
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG_FILE = os.environ.get("MOCK_SERVER_LOG", "/tmp/biblos-mock-requests.log")

OK_JSON = {"jsonrpc": "2.0", "result": {"protocolVersion": "2025-11-25"}, "id": 1}
ACCEPTED_JSON = {"jsonrpc": "2.0", "result": {"accepted": True}, "id": 1}
UNAUTH_JSON = {
    "jsonrpc": "2.0",
    "error": {"code": -32001, "message": "unauthorized"},
    "id": 1,
}


class Handler(BaseHTTPRequestHandler):
    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
        record = {
            "method": self.command,
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "body": body,
        }
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")

        if self.path.startswith("/ok"):
            status, payload = 200, OK_JSON
        elif self.path.startswith("/accepted"):
            status, payload = 202, ACCEPTED_JSON
        elif self.path.startswith("/unauthorized"):
            status, payload = 401, UNAUTH_JSON
        elif self.path.startswith("/invalid"):
            status, payload = 200, "this is not json"
        elif self.path.startswith("/empty"):
            status, payload = 200, ""
        elif self.path.startswith("/register-fail") and "capabilities" in body:
            # Registration-failure simulation (REQ-008/010 failure paths):
            # register_agent posts a body containing "capabilities" to the
            # same endpoint the smoke test uses. Keep the smoke test passing
            # (200) while registration itself fails (500).
            status, payload = 500, {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": "registration rejected"},
                "id": 1,
            }
        else:
            status, payload = 200, OK_JSON

        data = payload if isinstance(payload, str) else json.dumps(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(data.encode("utf-8"))

    do_GET = _respond
    do_POST = _respond

    def log_message(self, *args):
        pass  # silence per-request stderr noise


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18765
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()