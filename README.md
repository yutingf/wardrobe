# Wardrobe: what to wear today

A zero-token daily outfit recommender, live at
https://d4f-gif.github.io/wardrobe/. Pick the occasion (Work / School / Kids
event) and it recommends layered outfits from your own closet based on live
Washington, DC weather.

## How it works

- **Daily use costs zero tokens.** The page fetches the forecast from the free
  Open-Meteo API (no key needed) and runs a local rules engine. It makes no AI
  calls and needs no server.
- **Adding clothes also costs zero tokens.** The Add clothes tab has a camera
  button (opens the phone camera) and a photo picker. Two vision models
  (transformers.js, downloaded once and cached, ~150 MB) run in the browser:
  RMBG-1.4 removes the background and splits a photo holding several
  separated pieces into one garment each; CLIP groups photos of the same
  garment shot from different angles and drafts category, pattern, and
  material with confidence scores. Color comes from the garment's own pixels.
  Every saved photo becomes a product-style catalog shot: cutout on white,
  auto-straightened, light corrected. Low-confidence drafts ask for specific
  extra angles. You review and correct the drafts, then save. Items and
  photos persist in the browser's IndexedDB; **photos never leave the
  device**, so nothing personal reaches the public repo or any server.

## The rules engine (`webapp/engine.js`)

Every feasible combination of bottom + base + optional mid + optional outer +
footwear is scored on six dimensions:

1. **Warmth fit.** Feels-like temperature bands set a layering target;
   morning-to-afternoon swings add a "shed-able layer" requirement.
2. **Formality.** Each occasion has a dress-code band (work is business casual,
   configurable in `OCCASIONS`); outfits lose points for pieces outside the
   band and for mixing distant dress levels.
3. **Color harmony.** A 12-step color wheel plus neutral and earth-tone
   handling: neutrals go with everything, one accent is classic, analogous
   colors score well, clashing mid-distance hues and 3+ competing accents lose
   points; bonuses for tonal outfits and brown shoes with navy or gray.
4. **Pattern mixing.** At most one bold pattern; two different patterns pass in
   casual settings, same-pattern pairs and graphic pieces at work do not.
5. **Material and season.** Linen in heat, wool/flannel/cashmere in cold, a
   denim-on-denim penalty, water-resistant outers and no suede when rain is
   likely.
6. **Variety.** The first top pick shown each day is logged automatically and
   its pieces are demoted for the next three days.

The top pick plus up to four diverse alternatives appear with a "why this
works" explanation drawn from whichever rules fired.

## Storage model

Uploaded items live in IndexedDB, per browser, per device. The Closet tab can
export the catalog as JSON (photos excluded) and import it on another device.
Sample clothes in `closet/catalog.js` (flagged `sample: true`) make the app
work out of the box and hide automatically, layer by layer, as real items come
in. Claude can also append committed items to `closet/catalog.js` directly
(see `CLAUDE.md`), which is useful for entries that should sync via git.

## Layout

```
webapp/     index.html + engine.js (scoring) + app.js (UI, weather)
            + cataloger.js (in-browser CLIP cataloging) + db.js (IndexedDB)
            + style.css
closet/     catalog.js (committed items + samples) + photos/ (optional,
            for committed items only)
test/       engine-test.js, run with `node test/engine-test.js`
```
