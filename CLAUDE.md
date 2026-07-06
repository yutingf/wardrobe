# CLAUDE.md: Wardrobe repo

Zero-token daily outfit recommender. `README.md` explains the design. Pure
static site (GitHub Pages at https://d4f-gif.github.io/wardrobe/, public repo
under the separate `d4f-gif` account so it never shows on the yutingf
profile; yutingf has admin collaborator access for pushes) + Open-Meteo +
in-browser CLIP cataloging.

## How clothes get cataloged

Primary path (zero tokens, no Claude involved): the user photographs clothes
in the Add clothes tab; `webapp/cataloger.js` groups photos into garments and
drafts category/color/pattern/material; the user corrects and saves. Items and
photos persist in the browser's IndexedDB on that device only. Photos never
reach the repo or any server.

Fallback path (tokens, once per item): the user can still hand Claude photos
to catalog. Then follow: propose entries matching the schema at the top of
`closet/catalog.js` (colors from `COLORS` in `webapp/engine.js`, patterns
from `PATTERN_BOLDNESS`, `set:` tags for suits), show them, wait for
greenlight, append to the `CATALOG` array, run `node test/engine-test.js`,
commit and push. Committed entries sync via git and show on every device;
IndexedDB entries do not.

## Constraints

- Photos taken in the app stay in IndexedDB; never suggest committing them.
  The repo is public, so anything committed (including `closet/photos/`) is
  visible to anyone.
- The site must keep working over plain file:// for the Today tab, so
  `catalog.js` stays a `.js` global (not fetched JSON). The Add clothes tab
  needs https (camera + CDN model): use the Pages URL.
- Sample items (`sample: true`) hide automatically per layer once the user has
  a real item in that layer; delete a sample from `catalog.js` only when asked.
- Location is hardcoded to Washington, DC in `webapp/app.js` (`LOCATION`).
- Engine limitation, deliberate: dresses map to layer "base" and the engine
  still requires a bottom, so dress-based outfits are not supported yet.
