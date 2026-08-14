"""
ERP data access — MMMJHS Telegram / ERP Google Sheet only.

Uses ERP_APPS_SCRIPT_URL. Never calls the NFC attendance Apps Script.
Bot for this layer: @mmmjhschoolbot
"""

from __future__ import annotations

import requests

from config import ERP_APPS_SCRIPT_URL, ERP_BOT_USERNAME


def erp_apps_get(params: dict, timeout: int = 30):
    if not ERP_APPS_SCRIPT_URL:
        print("[ERP] ERP_APPS_SCRIPT_URL missing — set MMMJHS Telegram sheet Apps Script URL")
        return None
    try:
        resp = requests.get(
            ERP_APPS_SCRIPT_URL, params=params, timeout=timeout, allow_redirects=True
        )
        try:
            return resp.json()
        except Exception:
            return {"raw": (resp.text or "").strip(), "ok": resp.ok}
    except Exception as e:
        print(f"[ERP] Apps Script error: {e}")
        return None


def normalize_admission(value) -> str:
    s = str(value or "").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def row_to_student(row: dict | None) -> dict | None:
    if not isinstance(row, dict):
        return None
    adm = normalize_admission(
        row.get("admissionNo")
        or row.get("admission_no")
        or row.get("Admission No")
        or row.get("AdmissionNo")
        or ""
    )
    if not adm:
        return None
    name = (
        row.get("name")
        or row.get("Name")
        or row.get("student_name")
        or f"Student {adm}"
    )
    class_name = (
        row.get("className")
        or row.get("class_name")
        or row.get("Class")
        or row.get("class")
        or ""
    )
    return {
        "id": abs(hash(adm)) % (10**9),
        "admission_no": adm,
        "name": str(name).strip(),
        "class_name": str(class_name).strip(),
        "parent_name": str(
            row.get("parentName") or row.get("parent_name") or row.get("Parent") or ""
        ).strip(),
        "parent_phone": str(
            row.get("parentPhone") or row.get("parent_phone") or row.get("Phone") or ""
        ).strip(),
        "telegram_chat_id": str(
            row.get("telegramChatId") or row.get("telegram_chat_id") or ""
        ).strip(),
        "source": "mmmjhs_telegram_sheet",
        "bot": f"@{ERP_BOT_USERNAME}",
    }


def get_all_students() -> list:
    """Try common ERP sheet actions; return list of student dicts (API shape)."""
    if not ERP_APPS_SCRIPT_URL:
        return []

    for params in (
        {"action": "get_all_students"},
        {"action": "list_students"},
        {"action": "get_all_uids"},
        {"action": "students"},
    ):
        data = erp_apps_get(params, timeout=45)
        rows = None
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            if isinstance(data.get("students"), list):
                rows = data["students"]
            elif isinstance(data.get("data"), list):
                rows = data["data"]
        if not rows:
            continue
        out = []
        for row in rows:
            s = row_to_student(row if isinstance(row, dict) else None)
            if s:
                out.append(s)
        if out:
            print(f"[ERP] loaded {len(out)} students from MMMJHS sheet via {params}")
            return out
    print("[ERP] no students returned — check ERP_APPS_SCRIPT_URL / sheet actions")
    return []


def find_student(admission_no: str) -> dict | None:
    adm = normalize_admission(admission_no)
    if not adm:
        return None
    if ERP_APPS_SCRIPT_URL:
        for params in (
            {"action": "find_student", "admission": adm},
            {"action": "student", "admission": adm},
            {"action": "find_student", "admission_no": adm},
        ):
            data = erp_apps_get(params, timeout=30)
            if isinstance(data, dict):
                if data.get("ok") and isinstance(data.get("student"), dict):
                    return row_to_student(data["student"])
                if data.get("admissionNo") or data.get("name"):
                    return row_to_student(data)
    for s in get_all_students():
        if s["admission_no"].lower() == adm.lower():
            return s
    return None


def school_stats() -> dict:
    students = get_all_students()
    total = len(students)
    return {
        "total": total,
        "present": 0,
        "absent": total,
        "source": "mmmjhs_telegram_sheet",
        "bot": f"@{ERP_BOT_USERNAME}",
    }


def configured() -> bool:
    return bool(ERP_APPS_SCRIPT_URL)
