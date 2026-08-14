/**
 * Keeps the website dashboard in sync with the same ERP API the Android app uses.
 * Soft-reloads when attendance counts change (NFC / app / admin marks).
 */
(function () {
  const badge = document.createElement("div");
  badge.id = "live-sync-badge";
  badge.textContent = "Live sync · connecting…";
  badge.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:50;background:#0F766E;color:#fff;" +
    "font:600 12px/1.2 system-ui,sans-serif;padding:8px 12px;border-radius:999px;" +
    "box-shadow:0 8px 24px rgba(15,118,110,.28);opacity:.95";
  document.body.appendChild(badge);

  let lastKey = "";

  async function poll() {
    try {
      const resp = await fetch("/api/mobile/school", { cache: "no-store" });
      if (!resp.ok) throw new Error("bad status");
      const data = await resp.json();
      const key = `${data.stats.present}-${data.stats.absent}-${data.stats.total}`;
      const now = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      badge.textContent = `Live sync · ${now}`;
      if (lastKey && lastKey !== key) {
        badge.textContent = "Updating…";
        location.reload();
        return;
      }
      lastKey = key;
    } catch {
      badge.style.background = "#DC2626";
      badge.textContent = "Sync offline";
    }
  }

  poll();
  setInterval(poll, 12000);
})();
