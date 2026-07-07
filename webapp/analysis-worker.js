/* analysis-worker.js — runs the heavy vision pipeline off the main thread.
   The main thread spawns a FRESH worker per analysis and terminates it when
   done: termination is the only way wasm memory actually returns to the OS,
   which keeps the tab light after results appear (phone tabs get killed
   otherwise). OCR is not here: Tesseract already runs in its own worker on
   the main thread and is terminated after use. */

import './db.js?v=17';
import './cataloger.js?v=17';

// strip canvases/urls so drafts survive structured clone
function serializeDrafts(drafts) {
  return {
    ocr: drafts.ocr,
    list: drafts.map(d => ({
      ...d,
      photos: d.photos.map(p => ({
        blob: p.blob, colors: p.colors, embed: p.embed,
        sourceIndex: p.sourceIndex, areaFrac: p.areaFrac, categoryPrior: p.categoryPrior,
      })),
    })),
  };
}

self.onmessage = async e => {
  const { id, cmd, files, hints, draftMeta } = e.data;
  const progress = msg => self.postMessage({ id, type: 'progress', msg });
  try {
    if (cmd === 'draft') {
      const drafts = await self.CATALOGER.draftGroupsCore(files, hints, progress);
      self.postMessage({ id, type: 'result', drafts: serializeDrafts(drafts) });
    } else if (cmd === 'angles') {
      const { attrs, fresh } = await self.CATALOGER.addAnglesCore(draftMeta, files, progress);
      self.postMessage({
        id, type: 'result', attrs,
        fresh: fresh.map(p => ({
          blob: p.blob, colors: p.colors, embed: p.embed,
          sourceIndex: p.sourceIndex, areaFrac: p.areaFrac, categoryPrior: p.categoryPrior,
        })),
      });
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
