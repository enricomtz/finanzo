Finanzo – Texterkennung für Kassenbons
======================================

Alles läuft auf dem Gerät. Der Kassenbon wird nicht an einen fremden Dienst geschickt.

Dateien:
- ocr-worker.js: Finanzo, liest ein Bild und gibt den Text zurück.
- tesseract-core-*.js / *.wasm: tesseract.js-core v5.1.0 (Apache License 2.0),
  https://github.com/naptha/tesseract.js-core – siehe LICENSE-tesseract.js-core.txt
- deu.traineddata: deutsches Modell aus tessdata_fast (Apache License 2.0),
  https://github.com/tesseract-ocr/tessdata_fast – siehe LICENSE-tessdata.txt
