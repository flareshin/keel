# Review notes

## PR 12: weather card

- `src/weather.js` called the global `fetch(` directly instead of `getJson` from `src/http.js`, so a 503 page was parsed as weather data. Fixed by switching to `getJson`.

## PR 15: footer links

- `src/links.js` joins the docs URL by string concatenation; `new URL` would be clearer.

## PR 19: feed card

- `src/legacy-feed.js` calls the global `fetch(` directly instead of `getJson` from `src/http.js`; a non-2xx response would be read as feed items. Left as is for the release.
