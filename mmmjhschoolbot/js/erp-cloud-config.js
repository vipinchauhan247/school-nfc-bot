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
