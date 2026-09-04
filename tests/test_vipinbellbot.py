import os
import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import nfc_gate
import bot
from config import public_base_url


IST = ZoneInfo("Asia/Kolkata")
MORNING = datetime(2026, 9, 1, 8, 30, 0, tzinfo=IST)


class TelegramSchoolHeaderTests(unittest.TestCase):
    def test_school_header_is_added_to_regular_messages(self):
        with patch.object(bot, "TELEGRAM_API", "https://telegram.invalid/bot"), patch.object(
            bot.requests, "post"
        ) as post:
            post.return_value.json.return_value = {"ok": True}
            bot.send_telegram_message("123", "📊 <b>Student Status</b>")

        payload = post.call_args.kwargs["json"]
        self.assertTrue(
            payload["text"].startswith(
                "🏫 <b>Madan Mohan Malviya Junior High School</b>\n\n"
            )
        )

    def test_existing_school_header_is_not_duplicated(self):
        message = "🏫 <b>Madan Mohan Malviya Junior High School</b>\n\nWelcome"
        with patch.object(bot, "TELEGRAM_API", "https://telegram.invalid/bot"), patch.object(
            bot.requests, "post"
        ) as post:
            post.return_value.json.return_value = {"ok": True}
            bot.send_telegram_message("123", message)

        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["text"].count("Madan Mohan Malviya Junior High School"), 1)


def _reset_cache():
    with nfc_gate._lock:
        nfc_gate._students_by_uid.clear()
        nfc_gate._students_by_adm.clear()
        nfc_gate._attendance_today.clear()
        nfc_gate._cache_loaded_at = 0.0
        nfc_gate._cache_loading = False
        nfc_gate._last_refresh_error = ""


class PublicBaseUrlTests(unittest.TestCase):
    def test_prefers_public_base_url(self):
        env = {
            "PUBLIC_BASE_URL": "https://school-nfc-bot.vercel.app",
            "VERCEL": "1",
            "VERCEL_URL": "school-nfc-bot-abc123.vercel.app",
        }
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(public_base_url(), "https://school-nfc-bot.vercel.app")

    def test_vercel_uses_production_host_not_deployment_url(self):
        env = {"VERCEL": "1", "VERCEL_URL": "school-nfc-bot-abc123.vercel.app"}
        with patch.dict(os.environ, env, clear=True):
            os.environ.pop("PUBLIC_BASE_URL", None)
            os.environ.pop("VERCEL_PROJECT_PRODUCTION_URL", None)
            os.environ.pop("RENDER_EXTERNAL_URL", None)
            self.assertEqual(public_base_url(), "https://school-nfc-bot.vercel.app")


class NfcGateTests(unittest.TestCase):
    def setUp(self):
        _reset_cache()

    def tearDown(self):
        _reset_cache()

    def test_empty_cache_peek_registered_card_is_success(self):
        peek = {
            "ok": True,
            "found": True,
            "student": {
                "admissionNo": "1658",
                "name": "Aarav",
                "nfcUid": "D7FE3B63",
                "telegramChatId": "111",
            },
        }
        with patch.object(nfc_gate, "_schedule_cache_refresh"), patch.object(
            nfc_gate, "_is_vercel", return_value=True
        ), patch.object(nfc_gate, "_now_ist", return_value=MORNING), patch.object(
            nfc_gate, "_after_response"
        ) as after, patch.object(
            nfc_gate.bot, "apps_script_get", return_value=peek
        ) as script:
            result = nfc_gate.process_nfc_tap("d7fe3b63")
        self.assertTrue(result.startswith("SUCCESS:Aarav:IN:"))
        after.assert_called_once()
        self.assertEqual(after.call_args[0][0], "sync")
        script.assert_called()
        action = script.call_args[0][0]["action"]
        self.assertEqual(action, "peek_uid")

    def test_empty_cache_unknown_uid_is_invalid_card(self):
        peek = {"ok": True, "found": False}
        with patch.object(nfc_gate, "_schedule_cache_refresh"), patch.object(
            nfc_gate, "_is_vercel", return_value=True
        ), patch.object(nfc_gate, "_telegram_admin_new_card") as notify, patch.object(
            nfc_gate, "_after_response"
        ) as after, patch.object(
            nfc_gate.bot, "apps_script_get", return_value=peek
        ):
            result = nfc_gate.process_nfc_tap("DEADBEEF01")
        self.assertEqual(result, "INVALID CARD")
        notify.assert_called_once_with("DEADBEEF01")
        after.assert_not_called()

    def test_empty_cache_peek_and_refresh_fail_is_error(self):
        with patch.object(nfc_gate, "_schedule_cache_refresh"), patch.object(
            nfc_gate, "_is_vercel", return_value=True
        ), patch.object(nfc_gate.bot, "apps_script_get", return_value=None), patch.object(
            nfc_gate, "refresh_student_cache", return_value=False
        ):
            result = nfc_gate.process_nfc_tap("DEADBEEF01")
        self.assertEqual(result, "ERROR")

    def test_warm_cache_unknown_uid_does_not_peek(self):
        nfc_gate._remember_student(
            {
                "admissionNo": "1001",
                "name": "Known",
                "className": "5",
                "nfcUid": "AABBCCDD",
                "telegramChatId": "",
            }
        )
        with patch.object(nfc_gate, "_schedule_cache_refresh"), patch.object(
            nfc_gate, "_is_vercel", return_value=False
        ), patch.object(nfc_gate, "_after_response"), patch.object(
            nfc_gate.bot, "apps_script_get"
        ) as script:
            result = nfc_gate.process_nfc_tap("DEADBEEF01")
        self.assertEqual(result, "INVALID CARD")
        script.assert_not_called()

    def test_vercel_followup_posts_nfc_bg(self):
        with patch.object(nfc_gate, "_is_vercel", return_value=True), patch.object(
            nfc_gate, "public_base_url", return_value="https://school-nfc-bot.vercel.app"
        ), patch.object(nfc_gate.requests, "post") as post:
            nfc_gate._after_response("sync", "D7FE3B63")
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://school-nfc-bot.vercel.app/nfc_bg")
        self.assertEqual(kwargs["json"]["kind"], "sync")
        self.assertEqual(kwargs["json"]["uid"], "D7FE3B63")


class FlaskRouteTests(unittest.TestCase):
    def setUp(self):
        from main import app

        self.client = app.test_client()

    def test_nfc_bg_runs_requested_kind(self):
        with patch.object(nfc_gate, "run_nfc_background", return_value="ok") as run:
            resp = self.client.post(
                "/nfc_bg", json={"kind": "sync", "uid": "D7FE3B63"}
            )
        self.assertEqual(resp.status_code, 200)
        run.assert_called_once_with("sync", "D7FE3B63", {})
        self.assertTrue(resp.get_json()["ok"])

    def test_health_exposes_release_marker(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        if resp.is_json:
            self.assertEqual(
                resp.get_json()["release"], "school-header-single-alert-20260904"
            )
        else:
            self.assertIn("release=school-header-single-alert-20260904", resp.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
