# Third-party notices

Engram Store is licensed AGPL-3.0-only (see [LICENSE](LICENSE)). This file
records the third-party components the project redistributes, either tracked
in this repository or staged into the published container image at build
time, and the licenses they carry.

## Tracked in this repository

- `apps/web/public/ocr/eng.traineddata.gz` — the Tesseract OCR English
  language model, from the [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata)
  project. Apache License 2.0.
- `apps/web/src/intel/tables/airports.json` — a derived table built by
  `tools/build-airports.mjs` from [OurAirports](https://ourairports.com) data
  (public domain) joined with [mwgg/Airports](https://github.com/mwgg/Airports)
  (MIT License).

## Fetched at build time, served by deployments

- **ONLYOFFICE Docs editor and the x2t converter** — copyright Ascensio
  System SIA, GNU AGPL v3.0. Obtained as prebuilt releases from
  [cryptpad/onlyoffice-editor](https://github.com/cryptpad/onlyoffice-editor)
  and [cryptpad/onlyoffice-x2t-wasm](https://github.com/cryptpad/onlyoffice-x2t-wasm)
  at pinned tags with recorded SHA-256 digests, then pruned to the Word and
  Excel engines and modified by the patch set recorded in
  `scripts/office-assets.mjs`. That script also writes the license notice
  served alongside the assets, and this repository is the complete
  corresponding source for the modifications.
- **MobileCLIP-S0** ([Xenova/mobileclip_s0](https://huggingface.co/Xenova/mobileclip_s0),
  a browser-ready conversion of Apple's MobileCLIP) — copyright Apple Inc.,
  distributed under Apple's own license, which permits this redistribution
  but is not an open-source license and grants no patent rights. The license
  file is staged beside the model weights in the image. Powers the on-device
  meaning search over photos and videos.
- **GLiNER small v2.1** ([onnx-community/gliner_small-v2.1](https://huggingface.co/onnx-community/gliner_small-v2.1))
  — Apache License 2.0. Powers the on-request "Find connections" entity
  extraction.

## License elections

- `jszip` is dual-licensed MIT OR GPL-3.0-or-later; this project elects MIT.

All other npm and cargo dependencies carry permissive licenses (MIT,
Apache-2.0, ISC) recorded in their own packages.
