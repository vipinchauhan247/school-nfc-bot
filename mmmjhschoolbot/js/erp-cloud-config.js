/**
 * Admin: set ERP_CLOUD_SECRET to match Render env ERP_CLOUD_SECRET.
 * Teachers only open the website URL — no Backup & Export setup needed.
 *
 * ERP_CLOUD_ONLY = true → Supabase is the only source of truth for school data.
 * Browser localStorage/IndexedDB are NOT loaded for students (they caused
 * duplicates / stale PCs). Printer + appearance stay local per device.
 */
window.ERP_CLOUD_SCHOOL_ID = 'mmm-jhs';
window.ERP_CLOUD_SECRET = window.ERP_CLOUD_SECRET || ''; // set on Vercel deploy or keep existing hosted value
window.ERP_CLOUD_NATIVE = true; // prefer native student links when API provides them
window.ERP_CLOUD_ONLY = true;

/**
 * Where the ERP API lives. Change this one line to move hosts — login, cloud
 * sync, TC and the bot proxy all follow it.
 *
 *   Render (current):  'https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot'
 *   Vercel same-site:  '/api/mmmjhs-bot'   ← after copying the api/ folder to Vercel
 *
 * Leave unset to keep the built-in Render URL.
 */
// window.MMMJHS_BOT_API_URL = '/api/mmmjhs-bot';
