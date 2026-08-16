# Teachers must be ERP users (marks + subjects)

Your concern was real.

## Old bug
- Teachers Directory allowed free-text names with no login
- Subject Directory stored free-text teacher names (demo leftovers like Varsha / Lakshya)
- Subject mapping worked on that fake profile
- After deleting users, teachers remained but could not enter marks

## New rule
1. Create login in **User Management** with a **Teacher** role
2. In **Teachers Directory**, click **Link Teacher From Users** (dropdown of teacher users only)
3. Then map subjects — blocked if no login is linked
4. **Subjects Directory** Assigned Teacher only accepts those same Teacher-role users (dropdown). Non-login names are cleared to **Unassigned** and pushed back to cloud.
5. Saving Teachers Directory mappings also updates the matching Subject Directory teacher column
6. Deleting a staff user also removes their teacher profile
7. Auto-invented mystery passwords for orphan teachers are turned off

## How a teacher teaches a subject
They must be a user first. Flow:

User Management (create Teacher login) → Teachers Directory (link + map) **or** Subjects Directory Edit (pick that user) → marks / timetable use that login.

Nobody who is not a user can appear as an Assigned Subject Teacher.

## Deploy to website (Vercel)
Copy this file onto the live site as:

`js/app.js`

Then hard-refresh browsers (Ctrl+F5). If `index.html` has `app.js?v=...`, change the version string so teachers get the new file.

No Render bot change needed. Do not touch @Vipinbellbot.
