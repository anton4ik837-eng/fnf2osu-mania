/*
 * Чтение ZIP по HTTP Range напрямую с CDN GameBanana.
 * Не качаем весь архив (500+ МБ) — только каталог, чарты и выбранное аудио.
 * CORS и Range у filecache*.gamebanana.com разрешены, прокси не нужен.
 */
(function (global) {
  'use strict';

  var cache = {};

  function encPath(name) {
    return String(name).split('/').map(encodeURIComponent).join('/');
  }
  function concat(chunks, total) {
    var out = new Uint8Array(total), p = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return out;
  }

  async function probe(url) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 4000);
    try {
      var r = await fetch(url, { headers: { Range: 'bytes=0-15' }, signal: ctl.signal });
      if (r.status === 206) { await r.arrayBuffer(); clearTimeout(timer); ctl.abort(); return true; }
    } catch (e) { /* пробуем другое зеркало */ }
    clearTimeout(timer);
    return false;
  }

  /** Находит живое зеркало filecacheN.gamebanana.com для файла. */
  async function discover(fileName, onProgress) {
    if (cache[fileName]) return cache[fileName];
    var path = encPath(fileName);
    var preferred = [31, 41, 20, 28, 35, 36, 51, 21, 11, 5];
    var hosts = preferred.map(function (n) { return 'filecache' + n + '.gamebanana.com'; });
    for (var n = 1; n <= 60; n++) {
      if (preferred.indexOf(n) < 0) hosts.push('filecache' + n + '.gamebanana.com');
    }
    var found = [];
    for (var i = 0; i < hosts.length && found.length < 2; i += 12) {
      var batch = hosts.slice(i, i + 12);
      await new Promise(function (resolve) {
        var finished = 0;
        batch.forEach(function (h) {
          probe('https://' + h + '/mods/' + path).then(function (ok) {
            if (ok && found.length < 2) found.push('https://' + h + '/mods/' + path);
            if (++finished === batch.length || found.length >= 2) resolve();
          });
        });
      });
      if (onProgress) onProgress('Ищу зеркало... ' + Math.min(i + 12, hosts.length) + '/60');
    }
    if (!found.length) return null;
    var res = { url: found[0], alternates: found.slice(1), fileName: fileName };
    cache[fileName] = res;
    return res;
  }

  function RemoteZip(info, size, onProgress) {
    this.info = info;
    this.size = size;
    this.onProgress = onProgress || function () {};
    this.urls = [info.url].concat(info.alternates || []);
    this.entries = null;
  }

  /** Читает [a, b] через Range, переключая зеркала при ошибке. */
  RemoteZip.prototype.fetchRange = async function (a, b) {
    var len = b - a + 1, last;
    for (var attempt = 0; attempt < this.urls.length * 3; attempt++) {
      var u = this.urls[attempt % this.urls.length];
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 15000);
      try {
        var r = await fetch(u, { headers: { Range: 'bytes=' + a + '-' + b }, signal: ctl.signal });
        if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
        if (r.status === 206) {
          var out = new Uint8Array(await r.arrayBuffer());
          clearTimeout(timer);
          return out;
        }
        // Сервер проигнорировал Range — читаем только нужный кусок и обрываем.
        var reader = r.body.getReader(), chunks = [], got = 0;
        while (got < len) {
          var x = await reader.read();
          if (x.done) break;
          chunks.push(x.value); got += x.value.length;
        }
        reader.cancel(); clearTimeout(timer); ctl.abort();
        return concat(chunks, Math.min(got, len));
      } catch (e) { clearTimeout(timer); last = e; }
    }
    throw last || new Error('Не удалось прочитать архив');
  };

  function zip64Value(extra, want) {
    // want: 'usize' | 'csize' | 'offset'
    var p = 0;
    while (p + 4 <= extra.length) {
      var id = extra[p] | (extra[p + 1] << 8);
      var sz = extra[p + 2] | (extra[p + 3] << 8);
      var body = p + 4;
      if (id === 0x0001) {
        var q = body, vals = [];
        for (var k = 0; k < 3 && q + 8 <= body + sz; k++, q += 8) {
          var v = 0;
          for (var b = 0; b < 8; b++) v += extra[q + b] * Math.pow(256, b);
          vals.push(v);
        }
        if (want === 'usize') return vals[0];
        if (want === 'csize') return vals[1];
        if (want === 'offset') return vals[2];
      }
      p = body + sz;
    }
    return null;
  }

  /** Читает центральный каталог (без данных файлов). */
  RemoteZip.prototype.init = async function () {
    if (this.entries) return this.entries;
    var tailLen = Math.min(65557, this.size);
    var tail = await this.fetchRange(this.size - tailLen, this.size - 1);
    var dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    var eo = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
    }
    if (eo < 0) throw new Error('Не найден конец ZIP-каталога');

    var total = dv.getUint16(eo + 10, true);
    var cdSize = dv.getUint32(eo + 12, true);
    var cdOff = dv.getUint32(eo + 16, true);

    // ZIP64
    if ((total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && eo >= 20) {
      var loc = await this.fetchRange(this.size - tailLen + eo - 20, this.size - tailLen + eo - 1);
      var ldv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
      if (ldv.getUint32(0, true) === 0x07064b50) {
        var zOff = Number(ldv.getBigUint64(8, true));
        var z = await this.fetchRange(zOff, zOff + 55);
        var zdv = new DataView(z.buffer, z.byteOffset, z.byteLength);
        if (zdv.getUint32(0, true) === 0x06064b50) {
          total = Number(zdv.getBigUint64(32, true));
          cdSize = Number(zdv.getBigUint64(40, true));
          cdOff = Number(zdv.getBigUint64(48, true));
        }
      }
    }
    this.onProgress('Каталог: ' + total + ' файлов');

    var cd = await this.fetchRange(cdOff, cdOff + cdSize - 1);
    var c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    var td = new TextDecoder(), off = 0, out = [];
    while (off + 46 <= cd.length && c.getUint32(off, true) === 0x02014b50) {
      var flags = c.getUint16(off + 8, true);
      var method = c.getUint16(off + 10, true);
      var csize = c.getUint32(off + 20, true);
      var usize = c.getUint32(off + 24, true);
      var nl = c.getUint16(off + 28, true);
      var el = c.getUint16(off + 30, true);
      var cl = c.getUint16(off + 32, true);
      var lho = c.getUint32(off + 42, true);
      var name = td.decode(cd.subarray(off + 46, off + 46 + nl));
      var extra = cd.subarray(off + 46 + nl, off + 46 + nl + el);
      if (usize === 0xffffffff) usize = zip64Value(extra, 'usize') || usize;
      if (csize === 0xffffffff) csize = zip64Value(extra, 'csize') || csize;
      if (lho === 0xffffffff) lho = zip64Value(extra, 'offset') || lho;
      if (name.charAt(name.length - 1) !== '/') {
        out.push({ name: name.replace(/\\/g, '/'), method: method, flags: flags, csize: csize, usize: usize, offset: lho });
      }
      off += 46 + nl + el + cl;
    }
    this.entries = out;
    return out;
  };

  async function inflateRaw(comp) {
    if (typeof global.DecompressionStream === 'undefined') {
      throw new Error('Нужен DecompressionStream (Chrome/Edge/Safari 16.4+)');
    }
    var ds = new global.DecompressionStream('deflate-raw');
    var stream = new Blob([comp]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Достаёт один файл из архива. */
  RemoteZip.prototype.extract = async function (entry, onProgress) {
    // Локальный заголовок и данные лежат рядом — берём их одним Range-запросом.
    var end = Math.min(this.size - 1, entry.offset + 512 + entry.csize - 1);
    var buf = await this.fetchRange(entry.offset, end);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('Плохой заголовок ZIP');
    var dataStart = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    var comp = buf.subarray(dataStart, dataStart + entry.csize);
    if (comp.length < entry.csize) throw new Error('ZIP-файл обрезан');
    if (onProgress) onProgress(entry.csize, entry.csize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) return await inflateRaw(comp);
    throw new Error('Неизвестный метод сжатия ZIP: ' + entry.method);
  };

  var API = { discover: discover, RemoteZip: RemoteZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.FnfRemote = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
