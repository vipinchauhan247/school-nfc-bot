const SCHOOL_NAME =
  process.env.SCHOOL_NAME || 'Madan Mohan Malviya Junior High School';

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : '';

const APPS_SCRIPT_URL = (process.env.APPS_SCRIPT_URL || '').trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '1722022492').trim();

function publicBaseUrl() {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  ).replace(/\/$/, '');
}

module.exports = {
  SCHOOL_NAME,
  BOT_TOKEN,
  TELEGRAM_API,
  APPS_SCRIPT_URL,
  ADMIN_CHAT_ID,
  publicBaseUrl,
};
