# Staff / Teacher Telegram self-link (@mmmjhschoolbot)

Teachers are **not** on the Students Google Sheet. The bot knows staff vs parent by **ERP login**, not by name on the sheet.

## Teacher steps
1. Office creates login in **User Management** (Teacher role) and shares username + password.
2. Teacher opens Telegram → **@mmmjhschoolbot** → Start.
3. Teacher sends:
   ```
   /stafflink <username> <password>
   ```
   Example: `/stafflink arunima MyPass123`
4. Bot verifies ERP password and saves this phone’s Chat ID on that staff user in cloud.
5. Check with `/whoami` — it should show **Staff Link**.

Unlink:
```
/staffunlink <username> <password>
```

## Parent steps (unchanged)
```
/link <AdmissionNo>
```
Uses Students Google Sheet. Separate from staff.

## See links in ERP
After a teacher sends `/stafflink`, open **User Management** and click **Refresh Telegram Links**.
The Chat ID column shows the number and **via Telegram**.

Admin can also paste Chat ID and click **Save** (shows **in ERP**).

## Deploy
1. **Render** (bot): upload/redeploy
   - `api/mmmjhs-bot.js`
   - `api/erp-cloud.js`
2. **Vercel** (website): upload `js/app.js` and bump `?v=`
3. Do **not** touch @Vipinbellbot / NFC bot.

Requires Render env: Supabase + `ERP_CLOUD_SCHOOL_ID` (same as ERP cloud).
