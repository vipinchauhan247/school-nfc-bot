# Marks entry: freeze Name columns on mobile

On phones/tablets, S.No / Student Name / Father Name now stay frozen while subject columns slide (same as PC).

## Cause
Live `css/styles.css` had:

```css
@media (max-width: 1024px) {
  .sticky-col-1, .sticky-col-2, .sticky-col-3 {
    position: static !important;
  }
}
```

That turned off freeze on every phone.

## Upload to Vercel (website)
1. `css/styles.css` ← from `mmmjhschoolbot/css/styles.css` (bump `?v=` in index.html)
2. `js/app.js` ← from `mmmjhschoolbot/js/app.js` (bump `?v=`)

Hard refresh on the phone (or clear cache). Open Exams marks sheet and swipe subjects sideways — names should stay put.

Not for Render / Telegram bot.
