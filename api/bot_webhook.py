import json
import bot
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not bot.BOT_TOKEN:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"BOT_TOKEN missing")
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        try:
            update = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"INVALID JSON")
            return

        if not update:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"EMPTY")
            return

        try:
            bot.handle_telegram_update(update)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
        except Exception as e:
            print(f"[WEBHOOK] error: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"ERROR")
