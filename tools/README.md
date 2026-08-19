# index.html ビルドツール

`index.html` は BIOS ROM・フォントROM・エミュレータ本体(np21-wasm)・
`fddimage.zip` をすべて base64 で埋め込んだ自己完結ファイルです。

`fddimage.zip`（中身: fddimage/index.json とディスクイメージ）を更新したら、
プロジェクトルートで:

    node tools/build.mjs

を実行すると index.html が再生成されます（Node.js 18+）。

- コア切替: `CORE=np2 node tools/build.mjs` （既定は np21）
- BIOS/FONT/ITF ROM は index.html には含まれず、実行時に fddimage.zip 内の
  `bios.rom` / `font.rom` / `itf.rom` から読み込みます（除算例外の8086互換
  パッチも読み込み時に適用。詳細: docs/valiant-divide-fault-freeze.md）
