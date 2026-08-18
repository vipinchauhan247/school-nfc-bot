# Old ERP fee history import

This guide covers moving paid fee receipts from the previous Smart School ERP into MMM Jr High School ERP.

## Files you need

| File | Purpose |
|------|---------|
| `MMM_Student_Import_From_Old_ERP.csv` | Active student register (~749 students) |
| `MMM_Fee_History_Import_From_Old_ERP.csv` | Paid receipts for the current session (~1639 rows) |

Generate the fee CSV from a saved collection report:

```bash
python mmmjhschoolbot/scripts/parse_old_erp_collection_report.py collection_report.html \
  -o MMM_Fee_History_Import_From_Old_ERP.csv
```

## Getting the collection report HTML

1. Log in to the old ERP admin panel in your browser.
2. Open **Finance Reports → Collection Report**.
3. Set the date filter to the academic year, for example:
   - `search_type=period`
   - `date_from=01-04-2026`
   - `date_to=31-03-2027`
4. Run the report and save the full results page as HTML.

Do **not** commit ERP login credentials into this repository.

## Import order in the new ERP

1. Deploy the latest `app.js` (and CSS if changed) to Vercel.
2. **Students → Import CSV** → upload the student register → choose **Replace existing details**.
3. **Fee Management → Import Old ERP Fees** → upload the fee history CSV.
4. Spot-check a few students, for example admission **1556**, **2439**, and totals against the old ERP.

## CSV columns

```
AdmissionNo,PaidMonths,PreviousSessionDue,ReceiptNo,PaymentDate,TotalPaid,TuitionPaid,AnnualPaid,ExamPaid,PaymentMode,Notes
```

- **PaidMonths** can be blank for annual-only or exam-only receipts.
- **PaymentDate** should be `YYYY-MM-DD`.
- Amount columns must be plain numbers (no Rs, commas, or symbols).

## Known edge cases

### Annual / exam only receipts

The old ERP often creates one receipt number per fee item. Annual charges usually have blank `PaidMonths`. The new ERP import accepts those rows.

### Disabled or left students

Historical collections may include students who are no longer in the active register. Example from the 2026-27 export:

- Admission **2176** — MANVI, Class I (B)

Those fee rows are skipped during import unless you add the student manually first.

### Do not overwrite the fee CSV with ledger scraping

Student fee ledger pages in the old ERP may show everything as unpaid even when the collection report has real payments. Always use the **collection report** as the source of truth.

## Security reminder

If login credentials were pasted into an AI chat or script while exploring the old ERP, change that password in the old system.
