# Third-party notices

NexusIDE includes third-party software and data. The corresponding licenses
remain with their copyright holders.

## SpeechKit wake-word models

The offline wake pipeline contains three ONNX artifacts from
[`Soulcreek2/speechkit-wakeword-models`](https://huggingface.co/Soulcreek2/speechkit-wakeword-models),
pinned at commit `479ba4f8d0233541e4b25583803afad275fcdc1f`:

- `melspectrogram.onnx` — SHA-256 `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f`
- `embedding_model.onnx` — SHA-256 `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f`
- `hey_jarvis.onnx` — SHA-256 `7256019a18029c7bea33abc3344f7a3d0e07655cf4a5f18e65c9b6329eac3fb6`

The artifacts are distributed under the Apache License 2.0. NexusIDE stores
the bytes as base64 without modifying the model weights. The shared
mel/embedding components derive from the permissive openWakeWord/Google speech
embedding pipeline; the phrase head is SpeechKit's independently trained
Apache-2.0 model. NexusIDE does **not** include openWakeWord v0.5.1's
CC BY-NC-SA `hey_jarvis_v0.1` phrase model.

The Apache License 2.0 text is included at
`third_party/licenses/Apache-2.0.txt`.

## VT323 font

`src/renderer/styles/fonts/VT323-Regular.ttf` is the VT323 font by Peter Hull,
distributed under the SIL Open Font License 1.1. The license text is included
at `third_party/licenses/OFL-1.1.txt`.

## Tesseract OCR language data

Offline English and Portuguese OCR use the pinned npm packages
`@tesseract.js-data/eng@1.0.0` and `@tesseract.js-data/por@1.0.0` (MIT package
metadata; trained data originating from the Apache-2.0 Tesseract tessdata
project). The compact `4.0.0_best_int` artifacts are verified before use:

- `eng.traineddata.gz` — SHA-256 `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`
- `por.traineddata.gz` — SHA-256 `dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c`

NexusIDE resolves these files from its signed package and copies verified bytes
to a private local runtime directory. OCR does not download language data at
runtime.

## Onlook CSS-to-Tailwind translator

Visual Edit uses the CSS-to-Tailwind translator from the
[`onlook-dev/onlook`](https://github.com/onlook-dev/onlook) project
(`packages/utility/src/tailwind.ts`), fetched from the `main` branch on
2026-07-10. Copyright remains with the Onlook contributors. The translator is
distributed under the Apache License 2.0 and credits an adaptation of
[`hymhub/css-to-tailwind`](https://github.com/hymhub/css-to-tailwind), which is
distributed under the MIT License.

The vendored translator logic is consumed without local modification. The
Apache License 2.0 text is included at
`third_party/licenses/Apache-2.0.txt`.

## JavaScript and native dependencies

The production dependency inventory and individual package licenses are
recorded in the CycloneDX SBOM shipped with every release. Package license
files remain present in their packaged npm modules when required by the
upstream package.
