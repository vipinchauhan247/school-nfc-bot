# Teachers must be ERP users (marks fix)

Your concern was real.

## Old bug
- Teachers Directory allowed free-text names with no login
- Subject mapping worked on that fake profile
- After deleting users, teachers remained but could not enter marks

## New rule
1. Create login in **User Management** with a **Teacher** role
2. In **Teachers Directory**, click **Link Teacher From Users** (dropdown of teacher users only)
3. Then map subjects — blocked if no login is linked
4. Deleting a staff user also removes their teacher profile
5. Auto-invented mystery passwords for orphan teachers are turned off

## Deploy to website (Vercel)
Copy this file onto the live site as:

`js/app.js`

Then hard-refresh browsers (Ctrl+F5). If `index.html` has `app.js?v=...`, change the version string so teachers get the new file.

No Render bot change needed. Do not touch @Vipinbellbot.
