// Finanzo – Texterkennung für Kassenbons. Läuft im Hintergrund, alles auf dem Gerät.
// Nachricht rein: {id, image: ArrayBuffer (JPEG/PNG)}  →  raus: {id, text} oder {id, error}
// Zwischendurch: {progress: 0…1, stage: 'load' | 'read'}
/* global TesseractCore */
let mod = null, api = null, ready = null;

// Kann das Gerät WebAssembly-SIMD? (dann die schnellere Version)
const SIMD = (() => {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) { return false; }
})();

async function init() {
  postMessage({ progress: 0, stage: 'load' });
  importScripts(SIMD ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js');
  const model = fetch('deu.traineddata').then((r) => {
    if (!r.ok) throw new Error('model ' + r.status);
    return r.arrayBuffer();
  });
  mod = await TesseractCore({
    TesseractProgress(p) { postMessage({ progress: Math.max(0, Math.min(1, (p - 30) / 70)), stage: 'read' }); },
  });
  mod.FS.writeFile('deu.traineddata', new Uint8Array(await model));
  api = new mod.TessBaseAPI();
  if (api.Init(null, 'deu', 1) === -1) throw new Error('init');
  api.SetVariable('tessedit_pageseg_mode', '6');   // ein Textblock, Zeilen bleiben zusammen (Name … Preis)
  api.SetVariable('user_defined_dpi', '300');
  postMessage({ progress: 1, stage: 'load' });
}

self.onmessage = async (e) => {
  const { id, image } = e.data || {};
  try {
    if (!ready) ready = init();
    await ready;
    mod.FS.writeFile('/input', new Uint8Array(image));
    if (api.SetImageFile(1, 0) === 1) throw new Error('image');
    api.Recognize(null);
    const text = api.GetUTF8Text();
    api.Clear();
    try { mod.FS.unlink('/input'); } catch (x) { /* egal */ }
    postMessage({ id, text });
  } catch (err) {
    if (!api) ready = null;   // Laden fehlgeschlagen: beim nächsten Mal neu versuchen
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
