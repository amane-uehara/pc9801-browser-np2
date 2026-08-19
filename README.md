# PC-98 Browser Emulator Page

PC-9801（EPSON 386VR）のフロッピーディスクのソフトウェアをWebブラウザ
だけで動かす、単一HTMLのエミュレータページです。エミュレーションコアには
[np2-wasm](https://github.com/irori/np2-wasm)（Neko Project II の
WebAssembly移植、BSD-3-Clause）を使用しています。

## 使い方

1. `index.html` をブラウザで開く（ダブルクリックでOK。サーバ不要）
2. 「fddimage.zipを読み込む」で手元の `fddimage.zip` を指定
   （一度読み込むとブラウザに保存され、次回から自動で使えます）
3. FDD1でタイトルを選び、画面をクリックして電源ON

HTTPサーバ経由で使う場合は、`index.html` と同じ場所に `fddimage.zip`
を置けば自動で読み込まれます。

## まず試すには（サンプル同梱）

`fddimage_sample.zip` を「fddimage.zipを読み込む」から指定すると、
著作権的にクリーンな自作の起動デモディスク（sample.d88 / sample.tfd）が
エミュレータ内蔵の互換BIOSで起動します。実機ROMなしで動作確認できます。

## fddimage.zip の作り方（各自で用意してください）

このリポジトリにはROM・ディスクイメージは含まれません。
実機から吸い出した以下のファイルをzip化したものを使います
（zip直下でもフォルダ内でも可。ファイル名で認識します）:

```
index.json        ... タイトル一覧 [{"filename","category","title"}, ...]
bios.rom          ... 実機から吸い出したBIOS ROM
                      （無い場合は内蔵互換BIOSで起動。N88-BASICは不可）
font.rom          ... 実機から吸い出したフォントROM
                      （無い場合は font.bmp を入れれば代用可）
itf.rom           ... 同ITF ROM（任意）
*.d88 / *.tfd / *.fdi ... ディスクイメージ
```

ROM・市販ソフトのディスクイメージは著作物です。自分が所有する実機
・メディアからの私的複製の範囲で使用し、zipを再配布しないでください。

## 機能

- D88/TFD/FDI イメージ対応、FDD2ドライブ、使用履歴
- CPUクロック切替（動作中も同系列内なら即時）、速度スライダー
- ブラウン管風表示（にじみ・湾曲・走査線・200ライン補間・筐体枠）
- PC-9801実機配列の仮想キーボード、イメージ毎のキー割当保存
- 1983年前後のソフト向け 8086互換除算例外パッチ
  （詳細: docs/valiant-divide-fault-freeze.md）

## 再ビルド

```
node tools/build.mjs
```

## ライセンス

- このリポジトリのコード（UI・ビルドスクリプト）: MIT（LICENSE）
- 同梱のエミュレータ本体 np2-wasm / Neko Project II:
  BSD-3-Clause（LICENSE-np2-wasm.txt）
