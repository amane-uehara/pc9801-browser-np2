(function() {
  'use strict';
  var COMMON_MAP = '（共通）';       // keymap bucket used while no disk is set
  var zipEntries = null;   // Map basename -> {method, lho, compSize, size}
  var zipBytes = null;
  var libIndex = [];       // [{filename, category, title}] from index.json
  var activeImage = COMMON_MAP;      // FDD1 image; keys the per-image keymap

  // ---------- time scaling (live speed control) ----------
  var realNow = performance.now.bind(performance);
  var tsScale = 1, tsVBase = 0, tsRBase = realNow();
  performance.now = function() { return tsVBase + (realNow() - tsRBase) * tsScale; };
  function setTimeScale(s) {
    tsVBase = tsVBase + (realNow() - tsRBase) * tsScale;
    tsRBase = realNow();
    tsScale = s;
  }

  // ---------- settings ----------
  var settings = { clkBase: 2457600, clkMult: 4, speed: 100, dispSync: true,
    latency: 100, fill200: true, remapByImage: {}, lastImage: '', history: [],
    lastFdd: ['', ''],
    crt: { br: 90, sat: 50, con: 90, scan: 0, blur: 25, curve: 30, margin: 30 } };
  var autoStart = false;
  function loadSettings() {
    try {
      var s = localStorage.getItem('pc98-pinball-settings');
      if (s) Object.assign(settings, JSON.parse(s));
    } catch (e) {}
    var m = location.hash.match(/cfg=(\d+),(\d+),(\d+),(\d+)(?:,(\d+))?/);
    if (m) {
      settings.clkBase = +m[1]; settings.clkMult = +m[2];
      settings.speed = +m[3]; settings.dispSync = !!+m[4];
      if (m[5]) settings.latency = +m[5];
    }
    autoStart = /,as/.test(location.hash);
  }
  function saveSettings(withAutostart) {
    try {
      localStorage.setItem('pc98-pinball-settings', JSON.stringify(settings));
    } catch (e) {}
    var h = '#cfg=' + settings.clkBase + ',' + settings.clkMult + ',' +
      settings.speed + ',' + (settings.dispSync ? 1 : 0) + ',' +
      settings.latency + (withAutostart ? ',as' : '');
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
  }
  loadSettings();
  // migrate old single keymap into the per-image store
  if (settings.remap) {
    if (Object.keys(settings.remap).length && !settings.remapByImage['basic_game_all.d88']) {
      settings.remapByImage['basic_game_all.d88'] = settings.remap;
    }
    delete settings.remap;
  }
  function curMap() {
    if (!settings.remapByImage[activeImage]) settings.remapByImage[activeImage] = {};
    return settings.remapByImage[activeImage];
  }

  // ---------- module state ----------
  var overlay = document.getElementById('overlay');
  var canvas = document.getElementById('canvas');
  var module = null;
  var state = 'init';
  function setStatus(s) {
    var el = document.getElementById('status');
    el.textContent = s;
    el.classList.toggle('hidden', !s);
  }

  var config = {
    fontfile: 'font.rom',
    clk_base: settings.clkBase,
    clk_mult: settings.clkMult,
    ExMemory: 1,
    use_menu: true,
    DispSync: settings.dispSync,
    Latencys: settings.latency,   // sound buffer in ms (np2 default 250 = laggy)
    // 200-line games: draw the in-between raster lines at full brightness
    // instead of leaving them black (a real monitor's fat scanlines do this)
    skipline: settings.fill200,
    skplight: 255,
  };

  function getConfig(pName, type, pValue, size) {
    var name = module.UTF8ToString(pName);
    var value = config[name];
    if (value === undefined) return;
    switch (type) {
      case 0: if (typeof value === 'string') module.stringToUTF8(value, pValue, size); break;
      case 1: if (typeof value === 'boolean') module.HEAP8[pValue] = value ? 1 : 0; break;
      case 2: if (Array.isArray(value) && value.length == size) {
          for (var i = 0; i < size; i++) module.HEAPU8[pValue + i] = value[i];
        } break;
      case 3: if (typeof value === 'number') module.HEAP8[pValue] = value; break;
      case 6: case 9: if (typeof value === 'number') module.HEAPU8[pValue] = value; break;
      case 4: if (typeof value === 'number') module.HEAP16[pValue >> 1] = value; break;
      case 7: case 10: if (typeof value === 'number') module.HEAPU16[pValue >> 1] = value; break;
      case 5: if (typeof value === 'number') module.HEAP32[pValue >> 2] = value; break;
      case 8: case 11: if (typeof value === 'number') module.HEAPU32[pValue >> 2] = value; break;
    }
  }

  function decode(id) {
    var t = document.getElementById(id).textContent.trim();
    var bin = atob(t);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- fddimage.zip library ----------
  // Minimal ZIP reader: central directory scan + DecompressionStream for
  // deflate entries. Keeps everything self-contained (works from file://).
  function parseZip(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65536); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: EOCD not found');
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var entries = new Map();
    var td = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP: bad central dir');
      var method = dv.getUint16(off + 10, true);
      var compSize = dv.getUint32(off + 20, true);
      var size = dv.getUint32(off + 24, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var cmtLen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
      if (!name.endsWith('/')) {
        var base = name.split('/').pop();
        entries.set(base, { method: method, lho: lho, compSize: compSize, size: size });
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return entries;
  }
  function extractEntry(name) {
    var e = zipEntries.get(name);
    if (!e) return Promise.reject(new Error(name + ': not in fddimage.zip'));
    var dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    if (dv.getUint32(e.lho, true) !== 0x04034b50)
      return Promise.reject(new Error('ZIP: bad local header'));
    var nameLen = dv.getUint16(e.lho + 26, true);
    var extraLen = dv.getUint16(e.lho + 28, true);
    var data = zipBytes.subarray(e.lho + 30 + nameLen + extraLen,
                                 e.lho + 30 + nameLen + extraLen + e.compSize);
    if (e.method === 0) return Promise.resolve(new Uint8Array(data));
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([data]).stream().pipeThrough(ds))
      .arrayBuffer().then(function(ab) { return new Uint8Array(ab); });
  }
  // -- IndexedDB cache: the zip picked once is restored automatically --
  function idbOpen() {
    return new Promise(function(res, rej) {
      var r = indexedDB.open('pc98lib', 1);
      r.onupgradeneeded = function() { r.result.createObjectStore('kv'); };
      r.onsuccess = function() { res(r.result); };
      r.onerror = function() { rej(r.error); };
    });
  }
  function idbSet(k, v) {
    return idbOpen().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = res;
        tx.onerror = function() { rej(tx.error); };
      });
    });
  }
  function idbGet(k) {
    return idbOpen().then(function(db) {
      return new Promise(function(res, rej) {
        var q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function() { res(q.result); };
        q.onerror = function() { rej(q.error); };
      });
    });
  }
  function idbDel(k) {
    return idbOpen().then(function(db) {
      return new Promise(function(res) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(k);
        tx.oncomplete = res;
        tx.onerror = res;
      });
    });
  }

  function setLibraryFromBytes(u8, persist) {
    return new Promise(function(res) { setTimeout(res, 0); }).then(function() {
      zipBytes = u8;
      zipEntries = parseZip(zipBytes);
      return extractEntry('index.json');
    }).then(function(j) {
      libIndex = JSON.parse(new TextDecoder().decode(j));
      var cats = {};
      libIndex.forEach(function(e) {
        // only mountable disk images belong in the FDD lists
        if (!/\.(d88|88d|d98|98d|fdi|tfd|xdf|hdm)$/i.test(e.filename)) return;
        (cats[e.category] = cats[e.category] || []).push(e);
      });
      [0, 1].forEach(function(drive) {
        var sel = document.getElementById('fdd' + drive + '-sel');
        Object.keys(cats).forEach(function(c) {
          var og = document.createElement('optgroup');
          og.label = c;
          cats[c].sort(function(a, b) { return a.title.localeCompare(b.title, 'ja'); });
          cats[c].forEach(function(e) {
            var o = document.createElement('option');
            o.value = e.filename;
            o.textContent = e.title;
            og.appendChild(o);
          });
          sel.appendChild(og);
        });
      });
      renderHistory();
      [0, 1].forEach(function(drive) {
        var name = (settings.lastFdd || [])[drive];
        if (!name || !zipEntries.has(name)) return;
        var sel = document.getElementById('fdd' + drive + '-sel');
        if (sel && sel.value) return;      // something is already mounted
        extractEntry(name).then(function(bytes) {
          mountDisk(drive, name, bytes, true);
        }).catch(function(e) { console.warn('FDD復元失敗:', name, e); });
      });
      document.getElementById('lib-missing').classList.add('hidden');
      document.getElementById('lib-ready').classList.remove('hidden');
      var nDisks = libIndex.filter(function(e) {
        return /\.(d88|88d|d98|98d|fdi|tfd|xdf|hdm)$/i.test(e.filename);
      }).length;
      setStatus('ライブラリ準備完了（' + nDisks + 'タイトル）');
      if (persist) {
        idbSet('zipData', new Blob([u8])).then(function() {
          setStatus('ライブラリをブラウザに保存しました。次回から自動読込されます');
        }).catch(function(e) { console.warn('zip cache failed:', e); });
      }
    });
  }
  function loadZipFromCache() {
    return idbGet('zipData').then(function(blob) {
      if (!blob) throw new Error('no cached zip');
      return blob.arrayBuffer();
    }).then(function(ab) {
      return setLibraryFromBytes(new Uint8Array(ab), false);
    }).catch(function(e) {
      idbDel('zipData');    // drop unreadable/corrupt cache
      throw e;
    });
  }

  function loadZipViaFetch() {
    return fetch('fddimage.zip').then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function(ab) { return setLibraryFromBytes(new Uint8Array(ab)); });
  }


  var roms = null;   // { bios, font, itf } extracted from fddimage.zip

  // 8086-style INT0 (divide fault) handler: skip the faulting DIV/IDIV and
  // return, as the 8086/V30 did.  Patched into an unused 0xFF-padded area of
  // the BIOS ROM at load time (physical F8A00h = F8A0:0000).
  var INT0FIX = [
    0x55, 0x8B, 0xEC, 0x1E, 0x56, 0x50, 0x53, 0xFC,
    0xC5, 0x76, 0x02,
    0xAC, 0x8A, 0xD8, 0x80, 0xE3, 0xE7,
    0x80, 0xFB, 0x26, 0x74, 0xF5,
    0x3C, 0xF6, 0x74, 0x04, 0x3C, 0xF7, 0x75, 0x1E,
    0xAC, 0x8A, 0xD8, 0x24, 0xC0,
    0x3C, 0xC0, 0x74, 0x12,
    0x3C, 0x40, 0x74, 0x0D,
    0x3C, 0x80, 0x74, 0x08,
    0x80, 0xE3, 0x07, 0x80, 0xFB, 0x06, 0x75, 0x02,
    0x46, 0x46,
    0x89, 0x76, 0x02,
    0x5B, 0x58, 0x5E, 0x1F, 0x5D, 0xCF,
  ];
  function loadRoms() {
    if (roms) return Promise.resolve();
    if (!zipEntries) return Promise.reject(
      new Error('fddimage.zipを先に読み込んでください（BIOS ROMが必要です）'));
    var rom = function(name) {   // prefer lowercase, accept uppercase zips too
      return extractEntry(name).catch(function() {
        return extractEntry(name.toUpperCase());
      });
    };
    return Promise.all([
      rom('bios.rom').catch(function() { return null; }),
      rom('font.rom').catch(function() { return null; }),
      rom('itf.rom').catch(function() { return null; }),
      rom('font.bmp').catch(function() { return null; }),
    ]).then(function(r) {
      var bios = r[0];
      if (bios) {
        var pad = true;
        for (var i = 0x10A00; i < 0x10A00 + 0x80; i++) {
          if (bios[i] !== 0xFF) { pad = false; break; }
        }
        if (pad) {
          for (var j = 0; j < INT0FIX.length; j++) bios[0x10A00 + j] = INT0FIX[j];
        } else {
          console.warn('BIOS padding area not free; INT0 fix skipped');
        }
      }
      var font = r[1], fontname = 'font.rom';
      if (!font && r[3]) { font = r[3]; fontname = 'font.bmp'; }
      if (!font) {
        throw new Error('フォントがありません（zipに font.rom か font.bmp が必要です）');
      }
      roms = { bios: bios, font: font, fontname: fontname, itf: r[2] };
      config.fontfile = fontname;
      if (!bios) {
        console.warn('bios.rom無し: np2内蔵の互換BIOSで起動します（N88-BASICは不可）');
      }
    });
  }

  function start() {
    if (state !== 'init') return;
    state = 'starting';
    overlay.classList.add('hidden');
    setStatus('起動中...');
    setTimeScale(settings.speed / 100);

    loadRoms().then(function() {
      createModule();
    }).catch(function(e) {
      console.error(e);
      state = 'init';
      overlay.classList.remove('hidden');
      setStatus('起動失敗: ' + e.message);
    });
  }

  function createModule() {
    module = {
      canvas: canvas,
      wasmBinary: decode('b64-wasm').buffer,
      preRun: [function() {
        if (roms.bios) module.FS.writeFile('/bios.rom', roms.bios);
        module.FS.writeFile('/' + roms.fontname, roms.font);
        if (roms.itf) module.FS.writeFile('/itf.rom', roms.itf);
      }],
      onReady: function() {
        module.pauseMainLoop();
        // Mount disks chosen before power-on
        if (pendingDisks[0]) {
          fsMount(0, pendingDisks[0].name, pendingDisks[0].bytes);
        }
        if (pendingDisks[1]) {
          fsMount(1, pendingDisks[1].name, pendingDisks[1].bytes);
        }
        pendingDisks = [null, null];
        clkStructs = null;
        curBase = settings.clkBase;
        curMult = settings.clkMult;
        state = 'running';
        if (window.__updateCpuOptions) window.__updateCpuOptions();
        module._np2_resume();
        setStatus('動作中');
        canvas.focus();
      },
      onExit: function() {
        setTimeout(function() {
          module._np2_pause();
          state = 'exited';
          setStatus('電源OFF (リセットで再起動)');
        }, 0);
      },
      getConfig: getConfig,
      setConfig: function() {},
      onDiskChange: function() {},
      print: function(s) { console.log('[np2]', s); },
      printErr: function(s) { console.warn('[np2]', s); },
    };

    window.__np2factory(module).catch(function(e) {
      console.error(e);
      setStatus('起動失敗: ' + e);
    });
  }

  // ---------- FDD image loading (D88/TFD/FDI) ----------
  // np2 picks the handler from the file extension (.d88/.fdi) and falls back
  // to raw-size detection, which accepts TFD/XDF/HDM — so the file just needs
  // to land in the emulator's FS under its original name.
  var pendingDisks = [null, null];
  function titleFor(name) {
    for (var i = 0; i < libIndex.length; i++) {
      if (libIndex[i].filename === name) return libIndex[i].title;
    }
    return name;
  }
  function renderHistory() {
    if (!zipEntries) return;
    [0, 1].forEach(function(drive) {
      var sel = document.getElementById('fdd' + drive + '-sel');
      if (!sel) return;
      var kept = sel.value;
      var old = sel.querySelector('optgroup[data-mru]');
      if (old) old.remove();
      var names = (settings.history || []).filter(function(n) {
        return zipEntries.has(n);
      });
      if (names.length) {
        var og = document.createElement('optgroup');
        og.label = '最近使ったもの';
        og.setAttribute('data-mru', '1');
        names.forEach(function(n) {
          var o = document.createElement('option');
          o.value = n;
          o.textContent = titleFor(n);
          og.appendChild(o);
        });
        sel.insertBefore(og, sel.children[1] || null);
      }
      sel.value = kept;
    });
  }
  function pushHistory(name) {
    if (!zipEntries || !zipEntries.has(name)) return;
    var h = settings.history || [];
    h = h.filter(function(n) { return n !== name; });
    h.unshift(name);
    settings.history = h.slice(0, 15);
    saveSettings();
    renderHistory();
  }

  function syncFddSelect(drive, name) {
    var sel = document.getElementById('fdd' + drive + '-sel');
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === name) { sel.value = name; return; }
    }
    var o = document.createElement('option');   // local file outside the zip
    o.value = name;
    o.textContent = name + '（ローカル）';
    sel.appendChild(o);
    sel.value = name;
  }

  function fsMount(drive, name, bytes) {
    var fsname = '/fd' + drive + '_' + name;
    module.FS.writeFile(fsname, bytes);
    module.ccall('diskdrv_setfddex', undefined,
      ['number', 'string', 'number', 'number'], [drive, fsname, 0, 0]);
  }

  function mountDisk(drive, name, bytes, restoring) {
    if (!restoring) pushHistory(name);
    syncFddSelect(drive, name);
    if (!settings.lastFdd) settings.lastFdd = ['', ''];
    settings.lastFdd[drive] = (zipEntries && zipEntries.has(name)) ? name : '';
    if (drive === 0) {
      activeImage = name;
      if (zipEntries && zipEntries.has(name)) settings.lastImage = name;
      renderMaps();
    }
    saveSettings();
    if (module && (state === 'running' || state === 'paused' || state === 'exited')) {
      fsMount(drive, name, bytes);
      setStatus('FDD' + (drive + 1) + 'に「' + name + '」をセット — リセットで起動');
    } else {
      pendingDisks[drive] = { name: name, bytes: bytes };
      setStatus('FDD' + (drive + 1) + 'に「' + name + '」をセット（電源ON時に読み込み）');
    }
  }

  function loadDiskFile(drive, file) {
    var okExt = /\.(d88|88d|d98|98d|fdi|tfd|xdf|hdm)$/i;
    if (!okExt.test(file.name)) {
      setStatus('未対応の形式です: ' + file.name + '（D88/TFD/FDI等に対応）');
      return;
    }
    var reader = new FileReader();
    reader.onload = function() {
      mountDisk(drive, file.name, new Uint8Array(reader.result));
    };
    reader.onerror = function() { setStatus('読み込み失敗: ' + file.name); };
    reader.readAsArrayBuffer(file);
  }

  var screenBox = document.getElementById('screen-box');
  ['dragover', 'dragenter'].forEach(function(ev) {
    screenBox.addEventListener(ev, function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
  });
  screenBox.addEventListener('drop', function(e) {
    e.preventDefault();
    if (!e.dataTransfer.files.length) return;
    var f = e.dataTransfer.files[0];
    if (/\.zip$/i.test(f.name)) {
      f.arrayBuffer().then(function(ab) {
        return setLibraryFromBytes(new Uint8Array(ab), true);
      }).catch(function(err) { setStatus('zip読込失敗: ' + err); });
    } else {
      loadDiskFile(0, f);
    }
  });

  document.getElementById('zip-pick').addEventListener('click', function() {
    var input = document.getElementById('zip-file');
    input.value = '';
    input.click();   // synchronous: always opens, in every browser
  });
  document.getElementById('zip-file').addEventListener('change', function() {
    var f = this.files[0];
    if (!f) return;
    f.arrayBuffer().then(function(ab) {
      return setLibraryFromBytes(new Uint8Array(ab), true);
    }).catch(function(err) { setStatus('zip読込失敗: ' + err); });
  });
  document.getElementById('zip-change').addEventListener('click', function() {
    var input = document.getElementById('zip-file');
    input.value = '';
    input.click();
  });

  function ejectDisk(drive) {
    pendingDisks[drive] = null;
    if (settings.lastFdd) { settings.lastFdd[drive] = ''; saveSettings(); }
    if (module && state !== 'init' && state !== 'starting') {
      module.ccall('diskdrv_setfddex', undefined,
        ['number', 'number', 'number', 'number'], [drive, 0, 0, 0]);
    }
    setStatus('FDD' + (drive + 1) + 'を排出しました');
  }
  document.getElementById('fdd0-sel').addEventListener('change', function() {
    var name = this.value;
    if (!name) { ejectDisk(0); return; }
    if (!zipEntries || !zipEntries.has(name)) return;   // local entries stay mounted
    extractEntry(name).then(function(bytes) {
      mountDisk(0, name, bytes);
      if (state === 'running' || state === 'paused' || state === 'exited') {
        if (state !== 'running') { module._np2_resume(); state = 'running'; }
        module._np2_reset();
        setStatus('「' + name + '」から起動中...');
        canvas.focus();
      }
    }).catch(function(e) { setStatus('展開失敗: ' + e); });
  });
  document.getElementById('fdd1-sel').addEventListener('change', function() {
    var name = this.value;
    if (!name) { ejectDisk(1); return; }
    if (!zipEntries || !zipEntries.has(name)) return;
    extractEntry(name).then(function(bytes) {
      mountDisk(1, name, bytes);
    }).catch(function(e) { setStatus('展開失敗: ' + e); });
  });

  document.addEventListener('visibilitychange', function() {
    if (!module) return;
    if (document.visibilityState === 'hidden') {
      if (state === 'running') { module._np2_pause(); state = 'paused-auto'; }
    } else {
      if (state === 'paused-auto') { module._np2_resume(); state = 'running'; }
    }
  });

  // ---------- synthetic key events ----------
  function sendKey(code, down) {
    var e = new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code: code, key: code, bubbles: true, cancelable: true,
    });
    e.__np2synth = true;
    canvas.dispatchEvent(e);
  }

  // ---------- physical key handling: remap + assign capture ----------
  var capturing = false;      // waiting for a physical key (assign mode)
  var onCapture = null;
  function intercept(e) {
    if (e.__np2synth) return;
    if (capturing && e.type === 'keydown') {
      e.preventDefault(); e.stopImmediatePropagation();
      capturing = false;
      if (onCapture) onCapture(e.code);
      return;
    }
    if (capturing) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    var t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) return;
    var mapped = (settings.remapByImage[activeImage] || {})[e.code];
    if (mapped) {
      e.preventDefault(); e.stopImmediatePropagation();
      sendKey(mapped, e.type === 'keydown');
    }
  }
  window.addEventListener('keydown', intercept, true);
  window.addEventListener('keyup', intercept, true);

  // ---------- virtual keyboard: NEC PC-9801 (original 1982) layout ----------
  var U = 36;
  var VK = [];
  function key(x, y, w, code, label, o) {
    VK.push(Object.assign({ x: x, y: y, w: w, code: code, l: label }, o || {}));
  }
  var dk = { t: 'dk' };
  function dkm(extra) { return Object.assign({ t: 'dk' }, extra); }

  // function row (y=0)
  key(0, 0, 1, 'Pause', 'STOP', dk);
  key(1.25, 0, 1, 'PrintScreen', 'COPY', dk);
  for (var i = 0; i < 5; i++) key(3.25 + i, 0, 1, 'F' + (i + 1), 'f・' + (i + 1), dk);
  for (var i = 5; i < 10; i++) key(3.75 + i, 0, 1, 'F' + (i + 1), 'f・' + (i + 1), dk);
  key(17.25, 0, 1.25, 'PageUp', 'ROLL\nUP', dk);
  key(18.5, 0, 1.25, 'PageDown', 'ROLL\nDOWN', dk);

  // number row (y=1)
  key(0, 1, 1, 'Escape', 'ESC', dk);
  var digitShift = ['!', '"', '#', '$', '%', '&', "'", '(', ')', ''];
  var digitKana = ['ヌ', 'フ', 'ア', 'ウ', 'エ', 'オ', 'ヤ', 'ユ', 'ヨ', 'ワ'];
  for (var i = 0; i < 10; i++) {
    var d = (i + 1) % 10;
    key(1 + i, 1, 1, 'Digit' + d, String(d), { sh: digitShift[i], kana: digitKana[i] });
  }
  key(11, 1, 1, 'Minus', '-', { sh: '=', kana: 'ホ' });
  key(12, 1, 1, 'Equal', '^', { sh: '`', kana: 'ヘ' });
  key(13, 1, 1, 'IntlYen', '¥', { sh: '|', kana: 'ー' });
  key(14.9, 1, 1.6, 'Backspace', 'BS', dk);
  key(17.25, 1, 1, 'Insert', 'INS', dk);
  key(18.75, 1, 1, 'Delete', 'DEL', dk);
  key(20.75, 1, 1, 'Home', 'HOME\nCLR', dk);
  key(21.75, 1, 1, 'End', 'HELP', dk);
  key(22.75, 1, 1, 'NumpadSubtract', '-', dk);
  key(23.75, 1, 1, 'NumpadDivide', '/', dk);

  // QWERTY row (y=2)
  key(0, 2, 1.5, 'Tab', 'TAB', dk);
  var qRow = 'QWERTYUIOP';
  var qKana = ['タ', 'テ', 'イ', 'ス', 'カ', 'ン', 'ナ', 'ニ', 'ラ', 'セ'];
  for (var i = 0; i < 10; i++) {
    key(1.5 + i, 2, 1, 'Key' + qRow[i], qRow[i], { kana: qKana[i] });
  }
  key(11.5, 2, 1, 'BracketLeft', '@', { sh: '~', kana: '゛' });
  key(12.5, 2, 1, 'BracketRight', '[', { sh: '{', kana: '゜' });
  key(13.75, 2, 2.75, 'Enter', '⏎', dkm({ ret: 1, h: 2 }));
  key(20.75, 2, 1, 'Numpad7', '7');
  key(21.75, 2, 1, 'Numpad8', '8');
  key(22.75, 2, 1, 'Numpad9', '9');
  key(23.75, 2, 1, 'NumpadMultiply', '*', dk);

  // home row (y=3)
  key(0, 3, 1, 'ControlLeft', 'CTRL', dkm({ mod: 1 }));
  key(1, 3, 1.25, 'CapsLock', 'CAPS', dkm({ lock: 1 }));
  var aRow = 'ASDFGHJKL';
  var aKana = ['チ', 'ト', 'シ', 'ハ', 'キ', 'ク', 'マ', 'ノ', 'リ'];
  for (var i = 0; i < 9; i++) {
    key(2.25 + i, 3, 1, 'Key' + aRow[i], aRow[i], { kana: aKana[i] });
  }
  key(11.25, 3, 1, 'Semicolon', ';', { sh: '+', kana: 'レ' });
  key(12.25, 3, 1, 'Quote', ':', { sh: '*', kana: 'ケ' });
  key(13.25, 3, 1, 'Backslash', ']', { sh: '}', kana: 'ム' });
  key(17.5, 3, 2, 'ArrowUp', '↑', dk);
  key(20.75, 3, 1, 'Numpad4', '4');
  key(21.75, 3, 1, 'Numpad5', '5');
  key(22.75, 3, 1, 'Numpad6', '6');
  key(23.75, 3, 1, 'NumpadAdd', '+', dk);

  // bottom letter row (y=4)
  key(0, 4, 2.25, 'ShiftLeft', 'SHIFT', dkm({ mod: 1 }));
  var zRow = 'ZXCVBNM';
  var zKana = ['ツ', 'サ', 'ソ', 'ヒ', 'コ', 'ミ', 'モ'];
  for (var i = 0; i < 7; i++) {
    key(2.25 + i, 4, 1, 'Key' + zRow[i], zRow[i], { kana: zKana[i] });
  }
  key(9.25, 4, 1, 'Comma', ',', { sh: '<', kana: 'ネ' });
  key(10.25, 4, 1, 'Period', '.', { sh: '>', kana: 'ル' });
  key(11.25, 4, 1, 'Slash', '/', { sh: '?', kana: 'メ' });
  key(12.25, 4, 1, 'IntlRo', '_', { kana: 'ロ' });
  key(13.25, 4, 2.25, 'ShiftLeft', 'SHIFT', dkm({ mod: 1 }));
  key(17.5, 4, 1, 'ArrowLeft', '←', dk);
  key(18.5, 4, 1, 'ArrowRight', '→', dk);
  key(20.75, 4, 1, 'Numpad1', '1');
  key(21.75, 4, 1, 'Numpad2', '2');
  key(22.75, 4, 1, 'Numpad3', '3');
  key(23.75, 4, 1, 'NumpadEqual', '=', dk);

  // space row (y=5)
  key(1.75, 5, 1, 'KanaMode', 'カナ', dkm({ lock: 1 }));
  key(2.75, 5, 1, 'AltLeft', 'GRPH', dkm({ mod: 1 }));
  key(4.25, 5, 7.5, 'Space', '');
  key(12, 5, 1.5, 'Convert', 'XFER', dk);
  key(17.5, 5, 2, 'ArrowDown', '↓', dk);
  key(20.75, 5, 1, 'Numpad0', '0');
  key(21.75, 5, 1, 'Comma', ',');
  key(22.75, 5, 1, 'NumpadDecimal', '.');
  key(23.75, 5, 1, 'Enter', '⏎', dk);

  var vkbd = document.getElementById('vkbd');
  var kbMsg = document.getElementById('kb-msg');
  var kbMaps = document.getElementById('kb-maps');
  var assignBtn = document.getElementById('btn-assign');
  var kbInner = document.getElementById('kb-inner');
  var totalW = 24.75, totalRows = 6, fGap = 12;
  kbInner.style.width = (totalW * U - 4) + 'px';
  kbInner.style.height = (totalRows * U - 4 + fGap) + 'px';

  var assignMode = false;
  var assignWaitEl = null;
  var latched = {};
  function releaseLatched() {
    Object.keys(latched).forEach(function(code) {
      sendKey(code, false);
      latched[code].forEach(function(el) { el.classList.remove('down'); });
      delete latched[code];
    });
  }

  function keyName(code) {
    for (var i = 0; i < VK.length; i++) {
      if (VK[i].code === code)
        return (VK[i].l || 'SPACE').split('\n').join(' ');
    }
    return code;
  }

  function setKbMsg(text, wait) {
    kbMsg.textContent = text;
    kbMsg.classList.toggle('wait', !!wait);
  }
  function defaultMsg() {
    setKbMsg(assignMode ?
      '割当モード: 割当先のキーをクリックしてください' :
      'クリックでキー入力。SHIFT/CTRL/GRPHはクリックで押しっぱなしになります');
  }

  function cancelAssignWait() {
    capturing = false;
    onCapture = null;
    if (assignWaitEl) assignWaitEl.classList.remove('assign-wait');
    assignWaitEl = null;
  }

  function beginAssign(k, el) {
    if (assignWaitEl === el) { cancelAssignWait(); defaultMsg(); return; }
    cancelAssignWait();
    assignWaitEl = el;
    el.classList.add('assign-wait');
    setKbMsg('「' + keyName(k.code) + '」に割り当てる物理キーを押してください' +
      '（同じキーをもう一度クリックで取消）', true);
    capturing = true;
    onCapture = function(physCode) {
      curMap()[physCode] = k.code;
      saveSettings();
      cancelAssignWait();
      setKbMsg('割当を追加しました: ' + physCode + ' → ' + keyName(k.code));
      renderMaps();
    };
  }

  function makeKey(k) {
    var el = document.createElement('div');
    el.className = 'key ' + (k.t === 'dk' ? 'dk' : 'lt') + (k.ret ? ' return' : '');
    el.style.left = (k.x * U) + 'px';
    el.style.top = (k.y * U + (k.y > 0 ? fGap : 0)) + 'px';
    el.style.width = (k.w * U - 4) + 'px';
    el.style.height = ((k.h || 1) * U - 4) + 'px';
    el.innerHTML = '<span class="m">' + k.l.split('\n').join('<br>') + '</span>' +
      (k.sh ? '<span class="ss">' + k.sh + '</span>' : '') +
      (k.kana ? '<span class="sk">' + k.kana + '</span>' : '');
    el.dataset.code = k.code;

    var pressed = false;
    el.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      if (assignMode) { beginAssign(k, el); return; }
      if (k.mod) {
        if (latched[k.code]) {
          sendKey(k.code, false);
          latched[k.code].forEach(function(x) { x.classList.remove('down'); });
          delete latched[k.code];
        } else {
          sendKey(k.code, true);
          latched[k.code] = [el];
          el.classList.add('down');
        }
      } else if (k.lock) {
        // CAPS/カナ: the emulator toggles the mode on each key-make
        sendKey(k.code, true);
        setTimeout(function() { sendKey(k.code, false); }, 60);
        el.classList.toggle('down');
      } else {
        el.setPointerCapture(e.pointerId);
        pressed = true;
        el.classList.add('down');
        sendKey(k.code, true);
      }
    });
    var up = function() {
      if (!pressed) return;
      pressed = false;
      el.classList.remove('down');
      sendKey(k.code, false);
      releaseLatched();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return el;
  }
  VK.forEach(function(k) { kbInner.appendChild(makeKey(k)); });

  function renderMaps() {
    var tgt = document.getElementById('kb-target');
    if (tgt) tgt.textContent = '割当対象: ' + activeImage;
    kbMaps.innerHTML = '';
    var map = curMap();
    Object.keys(map).forEach(function(phys) {
      var chip = document.createElement('span');
      chip.className = 'map-chip';
      var b = document.createElement('b');
      b.textContent = phys + ' → ' + keyName(map[phys]);
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = '削除';
      x.addEventListener('click', function() {
        delete map[phys];
        saveSettings();
        renderMaps();
      });
      chip.appendChild(b);
      chip.appendChild(x);
      kbMaps.appendChild(chip);
    });
  }
  renderMaps();

  assignBtn.addEventListener('click', function() {
    assignMode = !assignMode;
    assignBtn.classList.toggle('active', assignMode);
    vkbd.classList.toggle('assign', assignMode);
    releaseLatched();
    cancelAssignWait();
    defaultMsg();
  });
  defaultMsg();

  // ---------- toolbar ----------
  var speedSlider = document.getElementById('speed');
  var speedVal = document.getElementById('speed-val');
  var speedWarn = document.getElementById('speed-warn');
  function updateSpeedWarn() {
    speedWarn.classList.toggle('hidden', settings.speed >= 90);
  }
  speedSlider.value = settings.speed;
  speedVal.textContent = settings.speed + '%';
  updateSpeedWarn();
  speedSlider.addEventListener('input', function() {
    settings.speed = +speedSlider.value;
    speedVal.textContent = settings.speed + '%';
    setTimeScale(settings.speed / 100);
    saveSettings();
    updateSpeedWarn();
    if (state !== 'init') setStatus(state === 'running' ? '動作中' : '一時停止中');
  });

  var cpuSel = document.getElementById('cpu-clock');
  cpuSel.value = settings.clkBase + ',' + settings.clkMult;
  if (!cpuSel.value) cpuSel.value = '2457600,4';
  cpuSel.addEventListener('change', function() {
    var p = cpuSel.value.split(',');
    applyCpuClock(+p[0], +p[1]);
    updateCpuOptions();
  });
  // after power-on only the running base-clock series can be selected
  function updateCpuOptions() {
    var started = state !== 'init' && state !== 'starting';
    for (var i = 0; i < cpuSel.options.length; i++) {
      var ob = +cpuSel.options[i].value.split(',')[0];
      cpuSel.options[i].disabled = started && ob !== curBase;
    }
  }
  window.__updateCpuOptions = updateCpuOptions;
  updateCpuOptions();

  var latSel = document.getElementById('latency');
  latSel.value = String(settings.latency);
  if (!latSel.value) latSel.value = '100';
  latSel.addEventListener('change', function() {
    settings.latency = +latSel.value;
    saveSettings(true);
    location.reload();
  });

  var dsChk = document.getElementById('dispsync');
  dsChk.checked = settings.dispSync;
  dsChk.addEventListener('change', function() {
    settings.dispSync = dsChk.checked;
    saveSettings(true);
    location.reload();
  });

  var pauseBtn = document.getElementById('btn-pause');
  pauseBtn.addEventListener('click', function() {
    if (!module) return;
    if (state === 'running') {
      module._np2_pause(); state = 'paused';
      pauseBtn.textContent = '再開'; setStatus('一時停止中');
    } else if (state === 'paused') {
      module._np2_resume(); state = 'running';
      pauseBtn.textContent = '一時停止'; setStatus('動作中');
      canvas.focus();
    }
  });

  document.getElementById('btn-reset').addEventListener('click', function() {
    if (!module) return;
    if (state === 'exited') { state = 'running'; module._np2_resume(); }
    module._np2_reset();
    setStatus('動作中');
    canvas.focus();
  });


  // ---------- CRT display adjustment ----------
  var crtPanel = document.getElementById('crt-panel');
  var scanEl = document.getElementById('scanlines');
  var glowEl = document.getElementById('raster-glow');
  var crtCtl = {
    br:   [document.getElementById('crt-br'),   document.getElementById('crt-br-v')],
    sat:  [document.getElementById('crt-sat'),  document.getElementById('crt-sat-v')],
    con:  [document.getElementById('crt-con'),  document.getElementById('crt-con-v')],
    scan: [document.getElementById('crt-scan'), document.getElementById('crt-scan-v')],
    blur: [document.getElementById('crt-blur'), document.getElementById('crt-blur-v')],
    curve: [document.getElementById('crt-curve'), document.getElementById('crt-curve-v')],
    margin: [document.getElementById('crt-margin'), document.getElementById('crt-margin-v')],
  };
  // Barrel-distortion displacement map (crt-geom style: src = dst*(1+k*r^2)).
  // R encodes x-displacement, G encodes y-displacement, both around 128.
  var curveMapSet = false;
  function ensureCurveMap() {
    if (curveMapSet) return;
    var W = 256, H = 160;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(W, H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var u = (x / (W - 1)) * 2 - 1;      // -1..1
        var v = (y / (H - 1)) * 2 - 1;
        var r2 = u * u + v * v;             // 0..2
        var i = (y * W + x) * 4;
        // unit displacement d*r^2, normalized into 0..255 (|d*r^2| <= 2)
        img.data[i]     = Math.round(128 + (u * r2 / 2) * 127);
        img.data[i + 1] = Math.round(128 + (v * r2 / 2) * 127);
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    document.getElementById('curve-map').setAttribute('href', cv.toDataURL());
    curveMapSet = true;
  }
  function updateCurveFilter() {
    var c = settings.crt;
    if (!c.curve) return;
    ensureCurveMap();
    var rect = document.getElementById('monitor').getBoundingClientRect();
    var fe = document.getElementById('curve-map');
    fe.setAttribute('x', 0); fe.setAttribute('y', 0);
    fe.setAttribute('width', rect.width || 640);
    fe.setAttribute('height', rect.height || 400);
    // displacement(px) = scale * (map/255 - 0.5); corner unit value is 0.5,
    // so corner shift = scale/2.  Map slider 100 to ~4% of the width.
    var scale = (c.curve / 100) * 0.08 * (rect.width || 640);
    document.getElementById('curve-disp').setAttribute('scale', scale.toFixed(2));
  }
  window.addEventListener('resize', function() { applyCrt(); });
  var lastMaskCurve = -1;
  function updateCurveMask() {
    var c = settings.crt;
    if (!c.curve) {
      if (lastMaskCurve !== 0) {
        var g = document.getElementById('monitor');
        g.style.maskImage = g.style.webkitMaskImage = '';
        lastMaskCurve = 0;
      }
      return;
    }
    if (c.curve === lastMaskCurve) return;
    lastMaskCurve = c.curve;
    // same geometry as the displacement: s = d*(1 + kappa*r^2)
    var kappa = 0.04 * (c.curve / 100);
    var W = 640, H = 420;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(W, H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var u = (x / (W - 1)) * 2 - 1;
        var v = (y / (H - 1)) * 2 - 1;
        var f = 1 + kappa * (u * u + v * v);
        var m = Math.max(Math.abs(u * f), Math.abs(v * f));   // >1 = outside
        var a = Math.max(0, Math.min(1, (1 - m) / 0.006 + 1));
        img.data[(y * W + x) * 4 + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    var u2 = 'url(' + cv.toDataURL() + ')';
    var g = document.getElementById('monitor');
    g.style.maskImage = g.style.webkitMaskImage = u2;
    g.style.maskSize = g.style.webkitMaskSize = '100% 100%';
  }
  // size the monitor to fill the viewport rectangle left over beside the panel
  function fitMonitor() {
    var monArea = document.getElementById('mon-area');
    var mon = document.getElementById('monitor');
    if (!monArea || !mon) return;
    var extraW = mon.offsetWidth - canvas.offsetWidth;    // bezel + glass margin
    var extraH = mon.offsetHeight - canvas.offsetHeight;
    var availW = monArea.clientWidth - extraW - 24;
    var availH = window.innerHeight - extraH - 24;
    var scale = Math.max(1, Math.min(availW / 640, availH / 400));
    canvas.style.width = Math.round(640 * scale) + 'px';
    canvas.style.height = Math.round(400 * scale) + 'px';
  }

  function applyCrt() {
    var c = settings.crt;
    if (c.blur === undefined) c.blur = 0;    // settings saved by older versions
    // CRT-style bleed: blur mostly horizontally, like a real tube smeared
    document.getElementById('nijimi-blur').setAttribute('stdDeviation',
      (c.blur * 0.018).toFixed(3) + ' ' + (c.blur * 0.006).toFixed(3));
    if (c.curve === undefined) c.curve = 0;
    if (c.margin === undefined) c.margin = 0;
    // black glass margin + plastic monitor shell — resize FIRST, because the
    // curvature filter measures the monitor box (applying it before the new
    // padding lands would distort with stale dimensions until the next call)
    var mon = document.getElementById('monitor');
    var glass = document.getElementById('glass');
    mon.classList.toggle('framed', c.margin > 0);
    glass.style.padding = c.margin > 0 ? c.margin + 'px' : '0';
    fitMonitor();
    updateCurveFilter();
    updateCurveMask();
    canvas.style.filter = 'brightness(' + (c.br / 100) + ') saturate(' +
      (c.sat / 100) + ') contrast(' + (c.con / 100) + ')' +
      (c.blur > 0 ? ' url(#nijimi)' : '');
    // curve the whole monitor face: plastic frame, black margin and raster
    // warp together, so the case edges bulge with the picture
    mon.style.filter = c.curve > 0 ? 'url(#curve)' : '';
    glowEl.style.opacity = 0;   // glass matches the picture black exactly instead
    // the picture's black passes through contrast/brightness:
    //   black' = 0.5*(1-con) * br  — paint the glass margin the same shade
    var blk = Math.round(255 * 0.5 * (1 - c.con / 100) * (c.br / 100));
    glass.style.background = c.margin > 0 ?
      'rgb(' + blk + ',' + blk + ',' + blk + ')' : '';
    // nearest-neighbor at non-integer scales creates scanline-like banding;
    // once the image is blurred anyway, smooth interpolation looks cleaner
    canvas.style.imageRendering = c.blur > 0 ? 'auto' : 'pixelated';
    scanEl.style.opacity = c.scan / 100;
    Object.keys(crtCtl).forEach(function(k) {
      crtCtl[k][0].value = c[k];
      crtCtl[k][1].textContent = c[k] + (k === 'margin' ? 'px' : '%');
    });
  }
  Object.keys(crtCtl).forEach(function(k) {
    crtCtl[k][0].addEventListener('input', function() {
      settings.crt[k] = +crtCtl[k][0].value;
      applyCrt();
      saveSettings();
    });
  });
  function crtPreset(p) {
    settings.crt = p;
    applyCrt();
    saveSettings();
  }
  document.getElementById('crt-preset-crt').addEventListener('click', function() {
    crtPreset({ br: 90, sat: 50, con: 90, scan: 0, blur: 25, curve: 30, margin: 30 });
  });
  document.getElementById('crt-preset-off').addEventListener('click', function() {
    crtPreset({ br: 100, sat: 100, con: 100, scan: 0, blur: 0, curve: 0, margin: 0 });
  });
  var fillChk = document.getElementById('crt-fill200');
  fillChk.checked = settings.fill200;
  fillChk.addEventListener('change', function() {
    settings.fill200 = fillChk.checked;
    config.skipline = settings.fill200;
    saveSettings();
    if (module && state !== 'init' && state !== 'starting') {
      if (!clkStructs || clkStructs.np2cfg < 0) clkStructs = findClockStructs();
      if (clkStructs.np2cfg >= 0) {
        var s = clkStructs.np2cfg - 32;           // struct start (model[8] at -8)
        module.HEAPU8[s + 5] = settings.fill200 ? 1 : 0;   // skipline
        module.HEAPU8[s + 6] = 255;                        // skiplight lo
        module.HEAPU8[s + 7] = 0;                          //           hi
        setStatus('200ライン補間を' + (settings.fill200 ? 'ON' : 'OFF') +
          'にしました（画面の切替時に反映）');
      } else {
        setStatus('次回の電源ONから反映されます');
      }
    }
  });

  applyCrt();

  canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  overlay.addEventListener('click', start);   // start() itself guards re-entry
  setStatus('準備完了 — クリックして電源ON');

  if (autoStart) {
    saveSettings(false);  // consume the autostart flag from the hash
    start();              // audio unlocks on the first click/keypress
  } else {
    saveSettings(false);
  }

  // ---------- live CPU clock switching ----------
  // np2 reads clk_base/clk_mult only at power-on, but everything derived from
  // them lives in wasm memory: np2cfg (applied on machine reset) and, for a
  // running machine, pccore.multiple/realclock plus four GDC timing values
  // that all scale linearly with the multiplier.
  var clkStructs = null;    // { np2cfg, pccore, real, gdc } heap offsets
  var curBase = settings.clkBase, curMult = settings.clkMult;

  function heapU32(h, off) {
    return (h[off] | (h[off+1] << 8) | (h[off+2] << 16) | (h[off+3] << 24)) >>> 0;
  }
  function putU32(h, off, v) {
    h[off] = v & 0xff; h[off+1] = (v >>> 8) & 0xff;
    h[off+2] = (v >>> 16) & 0xff; h[off+3] = (v >>> 24) & 0xff;
  }
  function findClockStructs() {
    var h = module.HEAPU8;
    var base = curBase, mult = curMult;
    var pairHits = [];
    for (var i = 0; i < h.length - 8; i += 4) {
      if (heapU32(h, i) === base && heapU32(h, i + 4) === mult) pairHits.push(i);
    }
    var np2cfgOff = -1, pccoreOff = -1;
    pairHits.forEach(function(off) {
      // np2cfg: model[8] ("VX\0...") sits right before baseclock/multiple
      if (h[off-8] === 0x56 && h[off-7] === 0x58 && h[off-6] === 0x00) {
        np2cfgOff = off;
        return;
      }
      // pccore: dipsw {3e,73,7b} at +12 and realclock (= base*mult) at +24
      if (h[off+12] === 0x3e && h[off+13] === 0x73 && h[off+14] === 0x7b &&
          heapU32(h, off + 24) === base * mult) {
        pccoreOff = off;
      }
    });
    // gdc: six consecutive u32s
    //   dispclock, vsyncclock, rasterclock, hsyncclock, hclock, vclock
    var gdcOff = -1, gdcCount = 0;
    for (var i = 16; i < h.length - 24; i += 4) {
      var hclk = heapU32(h, i + 16);
      if (hclk < 10000 || hclk > 40000) continue;
      var vclk = heapU32(h, i + 20);
      if (vclk < 200 || vclk > 1000) continue;
      var d = heapU32(h, i), v = heapU32(h, i + 4);
      var r = heapU32(h, i + 8), hs = heapU32(h, i + 12);
      if (r < 100 || r > 20000 || d < 10000) continue;
      if (d % r !== 0) continue;
      var lf = d / r;
      if (lf < 150 || lf > 600) continue;
      if (hs === 0 || hs > r || v === 0 || v >= d) continue;
      gdcOff = i; gdcCount++;
    }
    if (np2cfgOff < 0 || pccoreOff < 0 || gdcCount !== 1) {
      console.warn('clock structs not located:', np2cfgOff, pccoreOff, gdcCount);
      return { np2cfg: np2cfgOff, pccore: -1, real: -1, gdc: -1 };
    }
    return { np2cfg: np2cfgOff, pccore: pccoreOff, real: pccoreOff + 24, gdc: gdcOff };
  }

  function applyCpuClock(base, mult) {
    settings.clkBase = base;
    settings.clkMult = mult;
    config.clk_base = base;
    config.clk_mult = mult;
    saveSettings();
    if (!module || (state !== 'running' && state !== 'paused')) {
      curBase = base; curMult = mult;
      return;
    }
    var h = module.HEAPU8;
    if (!clkStructs || clkStructs.np2cfg < 0) clkStructs = findClockStructs();
    if (clkStructs.np2cfg < 0) {
      // could not even find np2cfg: last resort is a full page reload
      saveSettings(true);
      location.reload();
      return;
    }
    putU32(h, clkStructs.np2cfg, base);
    putU32(h, clkStructs.np2cfg + 4, mult);
    if (base === curBase && clkStructs.gdc >= 0) {
      // same base clock: scale the live machine in place, no reset needed
      putU32(h, clkStructs.pccore + 4, mult);
      putU32(h, clkStructs.real, base * mult);
      // dispclock, vsyncclock, rasterclock, hsyncclock scale with the
      // multiplier; hclock/vclock are real-world frequencies (unchanged)
      for (var k = 0; k < 4; k++) {
        var off = clkStructs.gdc + k * 4;
        putU32(h, off, Math.round(heapU32(h, off) * mult / curMult));
      }
      curMult = mult;
      setStatus('CPUクロックを即時変更しました');
    } else {
      // base clock differs (or gdc unknown): machine reset applies np2cfg
      curBase = base; curMult = mult;
      clkStructs = null;
      if (state === 'paused') { module._np2_resume(); state = 'running'; }
      module._np2_reset();
      setStatus('新しいクロックで再起動中...');
    }
    canvas.focus();
  }

  // ---------- 8086-style divide-fault fixup ----------
  // 1983-era software (e.g. Valiant) assumes INT 0 returns past the faulting
  // DIV/IDIV like on the 8086/V30. The ROM's stub at FD80:0166 just IRETs,
  // which on the emulated 286/386 re-executes the instruction forever. Our
  // build embeds a skip-and-return handler in unused ROM space at F8A0:0000;
  // this watchdog redirects vector 0 to it whenever the stock stub is set.
  var membase = -1;
  function findMembase() {
    if (!roms || !roms.bios) return -1;   // INT0 fix lives in the real BIOS only
    var h = module.HEAPU8;
    var sig = roms.bios.slice(0, 16);
    outer:
    for (var i = 0; i < h.length - 16; i++) {
      if (h[i] !== sig[0]) continue;
      for (var j = 1; j < 16; j++) if (h[i + j] !== sig[j]) continue outer;
      var base = i - 0xE8000;
      if (base < 0) continue;
      // machine RAM has an interrupt vector table at physical 0 whose
      // segment words are mostly ROM segments (0xFD80/0xF320...)
      var fd = 0;
      for (var v = 0; v < 64; v++) {
        var seg = h[base + v * 4 + 2] | (h[base + v * 4 + 3] << 8);
        if (seg >= 0xE800) fd++;
      }
      if (fd >= 16) return base;
    }
    return -1;
  }
  setInterval(function() {
    if (!module || state !== 'running') return;
    if (membase < 0) {
      membase = findMembase();
      if (membase < 0) return;
    }
    var h = module.HEAPU8;
    var off = h[membase] | (h[membase + 1] << 8);
    var seg = h[membase + 2] | (h[membase + 3] << 8);
    if (seg === 0xFD80 && off === 0x0166) {
      h[membase] = 0x00; h[membase + 1] = 0x00;   // offset 0000
      h[membase + 2] = 0xA0; h[membase + 3] = 0xF8; // segment F8A0
    }
  }, 1000);

  if (location.protocol !== 'file:') {
    loadZipViaFetch().catch(function() {
      return loadZipFromCache();
    }).catch(function() {
      setStatus('ライブラリ未読込 — 「fddimage.zipを読み込む」から選択してください');
    });
  } else {
    loadZipFromCache().catch(function() {
      setStatus('準備完了 — 電源ONで起動（ライブラリは「fddimage.zipを読み込む」から）');
    });
  }

  // hooks for automated testing
  window.__start = start;
  window.__sendKey = sendKey;
  window.__getState = function() { return state; };
  window.__heap = function() { return module ? module.HEAPU8 : null; };
  window.__extract = function(n) { return extractEntry(n); };
})();
