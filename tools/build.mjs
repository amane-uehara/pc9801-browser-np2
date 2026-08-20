// Build a self-contained index.html that boots the PC-98 emulator (np2-wasm)
// with the user's real BIOS/FONT ROMs and the game D88 image, all inlined
// as base64 so it works from file:// (double-click).
//
// Features: live speed slider (time scaling), CPU clock presets (applied via
// reload), full PC-98 virtual keyboard, physical-key remapping.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const HERE = dirname(fileURLToPath(import.meta.url));

const DIST = join(HERE, 'dist');
const PROJ = join(HERE, '..');
const CORE = process.env.CORE || 'np21';
const OUT = process.env.OUT || `${PROJ}/index.html`;

const b64 = (p) => readFileSync(p).toString('base64');

let glue = readFileSync(`${DIST}/${CORE}.js`, 'utf8');
glue = glue.replaceAll('import.meta.url', '"file:///np2/"');
glue = glue.replace('export default Module;', 'window.__np2factory = Module;');
if (!glue.includes('window.__np2factory')) throw new Error('export patch failed');

const wasmB64 = b64(`${DIST}/${CORE}.wasm`);


// Page script kept in a separate template to avoid escaping issues.
const pageScript = readFileSync(join(HERE, 'page.js'), 'utf8');
const pageCss = readFileSync(join(HERE, 'page.css'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>PC-98 Game Library</title>
<style>
${pageCss}
</style>
</head>
<body>
<div id="wrap">
  <div id="main-row">
  <div id="left-col">
  <div id="crt-panel">
    <div id="crt-sliders">
      <label><span class="nm">明るさ</span><input id="crt-br" type="range" min="40" max="120" step="1"><span id="crt-br-v" class="vl"></span></label>
      <label><span class="nm">彩度</span><input id="crt-sat" type="range" min="30" max="120" step="1"><span id="crt-sat-v" class="vl"></span></label>
      <label><span class="nm">コントラスト</span><input id="crt-con" type="range" min="60" max="120" step="1"><span id="crt-con-v" class="vl"></span></label>
      <label><span class="nm">走査線</span><input id="crt-scan" type="range" min="0" max="60" step="1"><span id="crt-scan-v" class="vl"></span></label>
      <label><span class="nm">にじみ</span><input id="crt-blur" type="range" min="0" max="100" step="1"><span id="crt-blur-v" class="vl"></span></label>
      <label><span class="nm">湾曲</span><input id="crt-curve" type="range" min="0" max="100" step="1"><span id="crt-curve-v" class="vl"></span></label>
      <label><span class="nm">余白</span><input id="crt-margin" type="range" min="0" max="60" step="1"><span id="crt-margin-v" class="vl"></span></label>
    </div>
    <div id="crt-side">
      <div class="prow">
        <button id="crt-preset-crt">ブラウン管風</button>
        <button id="crt-preset-off">補正なし</button>
      </div>
      <div class="prow">
        <label><input id="crt-fill200" type="checkbox" checked>200ライン補間</label>
        <label><input id="dispsync" type="checkbox" checked>チラつき低減</label>
      </div>
    </div>
  </div>
  <div id="ops-panel">
  <div id="fddbar">
    <span id="lib-missing" class="ctl">
      <button id="zip-pick">fddimage.zipを読み込む</button>
      <input type="file" id="zip-file" class="hidden" accept=".zip">
    </span>
    <span id="lib-ready" class="ctl hidden">
      <label class="ctl">FDD1 <select id="fdd0-sel"><option value="">（空）</option></select></label>
      <label class="ctl">FDD2 <select id="fdd1-sel"><option value="">（空）</option></select></label>
      <button id="zip-change" title="別のfddimage.zipを読み込み直す">zip変更</button>
    </span>
  </div>
  <div id="toolbar">
    <div class="prow">
      <button id="btn-reset">リセット</button>
      <button id="btn-pause">一時停止</button>
    </div>
    <div class="prow">
      <span class="nm">速度</span>
      <input id="speed" type="range" min="10" max="300" step="5" value="100">
      <span id="speed-val" class="vl">100%</span>
    </div>
    <div class="prow">
      <span class="nm">CPU</span>
      <select id="cpu-clock">
        <optgroup label="2.5MHz系">
          <option value="2457600,1">2.5MHz</option>
          <option value="2457600,2">5.0MHz</option>
          <option value="2457600,4" selected>10MHz</option>
          <option value="2457600,8">20MHz</option>
        </optgroup>
        <optgroup label="2.0MHz系">
          <option value="1996800,1">2.0MHz</option>
          <option value="1996800,2">4.0MHz</option>
          <option value="1996800,4">8.0MHz</option>
          <option value="1996800,8">16MHz</option>
        </optgroup>
      </select>
      <span class="nm">遅延</span>
      <select id="latency">
        <option value="50">50ms</option>
        <option value="100" selected>100ms</option>
        <option value="150">150ms</option>
        <option value="250">250ms</option>
      </select>
    </div>
  </div>
  </div>
  </div>
  <div id="mon-area">
  <div id="monitor"><div id="glass">
  <div id="screen-box">
    <canvas id="canvas" width="640" height="400" tabindex="1"></canvas>
    <div id="raster-glow"></div>
    <div id="scanlines"></div>
    <div id="overlay">クリックして電源ON</div>
  </div>
  </div></div>
  </div>
  </div>
  <div id="status"></div>
  <div id="speed-warn" class="hidden">※速度スライダーの低速はコマ落ちします。滑らかなまま動作を遅くするにはCPUクロックを下げてください</div>
  <svg width="0" height="0" style="position:absolute">
    <filter id="nijimi" x="-5%" y="-5%" width="110%" height="110%">
      <feGaussianBlur id="nijimi-blur" stdDeviation="0 0"/>
    </filter>
    <filter id="curve" x="-5%" y="-5%" width="110%" height="110%">
      <feImage id="curve-map" result="cmap" preserveAspectRatio="none"/>
      <feDisplacementMap id="curve-disp" in="SourceGraphic" in2="cmap"
        scale="0" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </svg>
  <div id="vkbd">
    <div id="kb-head">
      <button id="btn-assign">割当モード</button>
      <span id="kb-target" class="target"></span>
      <span id="kb-msg" class="msg"></span>
    </div>
    <div id="kb-inner"></div>
    <div id="kb-maps"></div>
  </div>
  <div id="hint">画面クリック後にキー入力が有効。CPUクロックは動作中でも同系列内なら即時変更できます（系列をまたぐ変更は電源ON前のみ）。チラつき低減の切替は自動で再起動します。割当モード: キーボード上のキーをクリック→手元の物理キーを押すと、そのキーに割当られます。<br>fddimage.zipは一度読み込むとブラウザ(IndexedDB)に保存され、次回から自動で使えます（HTTPサーバ経由なら常に自動読込）。差し替えは「zip変更」から。ローカルのディスクイメージは画面へのドラッグ&ドロップでFDD1にセットできます。ディスク未セットで電源ONするとROM BASICが起動します。キー割当はFDD1のイメージ毎に保存されます。</div>
</div>

<script id="b64-wasm" type="text/plain">${wasmB64}</script>

<script>
${glue}
</script>

<script>
${pageScript}
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log('wrote', OUT, (html.length / 1024 / 1024).toFixed(2), 'MB');
