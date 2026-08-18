#!/usr/bin/env python3
"""Parse Smart School-style collection_report HTML into fee history import CSV.

Usage:
  python parse_old_erp_collection_report.py collection_report.html -o MMM_Fee_History_Import_From_Old_ERP.csv

How to get the HTML (no credentials stored in this repo):
  1. Log in to the old ERP admin panel in your browser.
  2. Open Finance Reports -> Collection Report.
  3. Set search_type to "period" and choose the academic year date range
     (e.g. 01-04-2026 to 31-03-2027 for session 2026-27).
  4. Save the full results page as HTML, or use browser DevTools to copy response body.

Each payment row in the old ERP is usually one fee item with its own receipt number.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

CSV_COLUMNS = [
    "AdmissionNo",
    "PaidMonths",
    "PreviousSessionDue",
    "ReceiptNo",
    "PaymentDate",
    "TotalPaid",
    "TuitionPaid",
    "AnnualPaid",
    "ExamPaid",
    "PaymentMode",
    "Notes",
]

MONTH_MAP = {
    "january": "January",
    "february": "February",
    "march": "March",
    "april": "April",
    "may": "May",
    "june": "June",
    "july": "July",
    "august": "August",
    "september": "September",
    "october": "October",
    "november": "November",
    "december": "December",
}


class CollectionReportParser(HTMLParser):
    """Extract top-level table rows from nested Smart School collection report cells."""

    def __init__(self) -> None:
        super().__init__()
        self.tr_depth = 0
        self.td_depth = 0
        self.current_cell: list[str] = []
        self.current_row: list[str] = []
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "tr":
            self.tr_depth += 1
            if self.tr_depth == 1:
                self.current_row = []
        elif tag == "td":
            self.td_depth += 1
            if self.td_depth == 1:
                self.current_cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "tr":
            if self.tr_depth == 1 and self.current_row:
                self.rows.append(self.current_row)
            self.tr_depth -= 1
        elif tag == "td":
            if self.td_depth == 1:
                self.current_row.append(" ".join(self.current_cell).strip())
            self.td_depth -= 1

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text and self.td_depth >= 1:
            self.current_cell.append(text)


def parse_amount(raw: str) -> int:
    cleaned = re.sub(r"[^\d.-]", "", raw or "")
    try:
        value = float(cleaned)
    except ValueError:
        return 0
    return int(round(value)) if value > 0 else 0


def format_date(raw: str) -> str:
    match = re.match(r"(\d{2})-(\d{2})-(\d{4})", raw or "")
    if match:
        return f"{match.group(3)}-{match.group(2)}-{match.group(1)}"
    return raw.strip()


def normalize_mode(raw: str) -> str:
    mode = (raw or "").strip().lower()
    if "upi" in mode:
        return "UPI"
    if "bank" in mode or "neft" in mode or "transfer" in mode:
        return "Bank Transfer"
    if "cash" in mode:
        return "Cash"
    if "cheque" in mode or "check" in mode:
        return "Cheque"
    return raw.strip() or "Cash"


def extract_month_from_fee_type(fee_type: str) -> str:
    match = re.search(r"\(([^)]+)\)", fee_type or "")
    if not match:
        return ""
    token = match.group(1).strip().lower()
    return MONTH_MAP.get(token, "")


def classify_fee_type(fee_type: str) -> tuple[str, int, int, int, str]:
    """Return paid_month, tuition, annual, exam, notes for one fee line."""
    text = re.sub(r"\s+", " ", (fee_type or "").strip())
    lower = text.lower()

    if "annual charge" in lower:
        return "", 0, 1, 0, ""
    if "exam" in lower:
        return "", 0, 0, 1, text
    if "admission charge" in lower:
        return "", 0, 0, 0, text

    if "tution" in lower or "tuition" in lower:
        month = extract_month_from_fee_type(text)
        return month, 1, 0, 0, ""

    return "", 0, 0, 0, text


def parse_payment_rows(html: str) -> list[dict[str, str | int]]:
    parser = CollectionReportParser()
    parser.feed(html)

    payments: list[dict[str, str | int]] = []
    for row in parser.rows:
        if len(row) < 12:
            continue
        receipt_no = row[0].strip()
        if "/" not in receipt_no:
            continue

        adm_no = row[2].strip()
        fee_type = row[5].strip()
        paid_amount = parse_amount(row[11] if len(row) > 11 else row[-1])
        if not adm_no or paid_amount <= 0:
            continue

        month_flag, is_tuition, is_annual, is_exam, notes = classify_fee_type(fee_type)
        tuition_paid = paid_amount if is_tuition else 0
        annual_paid = paid_amount if is_annual else 0
        exam_paid = paid_amount if is_exam else 0

        payments.append(
            {
                "AdmissionNo": adm_no,
                "PaidMonths": month_flag,
                "PreviousSessionDue": 0,
                "ReceiptNo": receipt_no,
                "PaymentDate": format_date(row[1]),
                "TotalPaid": paid_amount,
                "TuitionPaid": tuition_paid,
                "AnnualPaid": annual_paid,
                "ExamPaid": exam_paid,
                "PaymentMode": normalize_mode(row[7] if len(row) > 7 else ""),
                "Notes": notes,
            }
        )

    return payments


def write_csv(rows: list[dict[str, str | int]], output_path: Path) -> None:
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def summarize(rows: list[dict[str, str | int]]) -> None:
    tuition_rows = sum(1 for row in rows if row["TuitionPaid"])
    annual_rows = sum(1 for row in rows if row["AnnualPaid"])
    exam_rows = sum(1 for row in rows if row["ExamPaid"])
    other_rows = sum(
        1
        for row in rows
        if not row["TuitionPaid"] and not row["AnnualPaid"] and not row["ExamPaid"]
    )
    print(f"Parsed {len(rows)} payment row(s)")
    print(f"  Tuition: {tuition_rows}")
    print(f"  Annual:  {annual_rows}")
    print(f"  Exam:    {exam_rows}")
    print(f"  Other:   {other_rows}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html_file", type=Path, help="Saved collection_report HTML file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("MMM_Fee_History_Import_From_Old_ERP.csv"),
        help="Output CSV path",
    )
    args = parser.parse_args()

    if not args.html_file.is_file():
        print(f"Input file not found: {args.html_file}", file=sys.stderr)
        return 1

    html = args.html_file.read_text(encoding="utf-8", errors="replace")
    rows = parse_payment_rows(html)
    if not rows:
        print("No payment rows found. Check that the HTML is a collection report results page.", file=sys.stderr)
        return 1

    write_csv(rows, args.output)
    summarize(rows)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
