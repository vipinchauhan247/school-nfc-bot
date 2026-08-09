"""Gunicorn entrypoint — boots Telegram poller before serving HTTP."""
from main import app, bootstrap

bootstrap()
