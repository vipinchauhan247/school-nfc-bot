# Role Permissions + Admit Card

Two additions to `js/app.js`. Upload to Vercel and bump `?v=`.

## 1. Role Permissions (set once per role)

**User Management → Role Permissions** (purple button, Super Admin / Principal only).

- Pick a role (Receptionist, Accountant, Subject Teacher, …)
- Tick rights across five tabs: **Dashboard Widgets**, Students, Fees, Exams, Faculty, Master
- **Save & apply to all** pushes those rights onto every staff account with that role

No more configuring 20 teachers one by one. Individual staff can still be fine-tuned afterwards from their **Access Rights** button — a per-user setting always wins over the role template.

Resolution order:

```
user Access Rights  →  role template  →  built-in role default  →  denied
```

### Role vs per-user — which wins?

**The per-user Access Rights screen always wins.** If you untick something in Role Permissions and then tick it in that person's Access Rights, only that person gets it; everyone else on the role stays blocked.

| You do this | Result |
|---|---|
| Untick in Role, tick in a user's Access Rights | That one person gets it, rest of the role does not |
| Tick in Role, untick in a user's Access Rights | That one person loses it, rest of the role keeps it |
| Save Role Permissions again | **Overwrites everyone**, including personal overrides |

Rows that no longer match the role are highlighted **"differs from role"** in the user's Access Rights screen. Use **Follow role again** to drop that person's overrides.

Super Admin and Principal always bypass every check.

### Dashboard Widgets tab

Each dashboard card is now its own permission:

| Widget | Key |
|---|---|
| Total Enrolled | `dash_total_students` |
| Present Today | `dash_present_today` |
| Absent Today | `dash_absent_today` |
| Pending Dues (school total) | `dash_pending_dues` |
| Attendance Register Preview | `dash_attendance_preview` |
| Collect Fee Now button | `dash_collect_fee_button` |
| New Admission button | `dash_new_admission_button` |
| Left / Inactive button | `dash_left_students_button` |

Receptionist default: student counts, attendance, Collect Fee, New Admission — **no Pending Dues total**.

## 2. Admit Card (#exams-admit-card)

**Exams → Admit Card.** Prints each student's admit card with **that class's own date sheet**.

1. **Exams → Exam Schedule** — pick the Class and Exam Term at the top, then add rows (subject, date, start/end time, max marks). Because the class and term are already chosen above, those columns are hidden and new rows inherit them; set either filter back to **All** if you want to edit them per row. Use **Copy To Another Class** when two classes share papers.
2. **Exams → Admit Card** — choose Exam Term + Class + Section. The date sheet preview shows the papers that will print.
3. Every student of that class/section is listed and ticked by default → **Print Selected Admit Cards** (or Print on one row).

Each card prints: school name/logo/address, ADMIT CARD + term + session, student name, father's name, admission no, roll no, class & section, DOB, an optional photo box, the numbered date sheet (subject / date / day / time / max marks), instructions, and Class Teacher + Principal signature lines. Two cards per A4 page.

**Photo** — "Print student photo box" is on by default. Students with an uploaded photo get it printed; students without get an empty *Affix Photo* box. Stock/demo avatar URLs are ignored so a stranger's face never prints on a card.

**Roll No** — editable directly in the student list on the Admit Card page. Changes save against the active session immediately. **Auto-number Roll (A–Z)** fills 1…n in the displayed alphabetical order.

A class with no rows for that term prints "Date sheet not published yet" and the page links back to Exam Schedule.

Permissions: `exam_schedule_manage` and `admit_card_print` (Exams tab). Teachers get view/print by default; only admins can edit the date sheet.
