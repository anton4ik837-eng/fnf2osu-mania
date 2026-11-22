/*
 * Импорт чартов по ссылке: GameBanana, GitHub, прямые .json / .zip.
 * Всё работает в браузере: CORS у api.gamebanana.com, api.github.com,
 * raw.githubusercontent.com и filecache.gamebanana.com разрешён (*).
 */
(function (global) {
  'use strict';
  var A = global.Fnf2Osu;

  var OWN_PROXY = 'https://fnf2osu-fetch.anton4ik837.workers.dev/?url=';
  var FALLBACK_PROXIES = [
    OWN_PROXY,
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://corsproxy.io/?url='
  ];

  function extOf(url) {
    var m = String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function baseOf(url) {
    return decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || 'file');
  }
  function bytesOf(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  function concatBytes(chunks, total) {
    var out = new Uint8Array(total), p = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return out.buffer;
  }

  async function fetchBuffer(url, proxy, timeoutMs, onProgress, signal) {
    // gamebanana.com/dl/... блокирует CORS в браузере — сразу идём через свой Worker
    var viaOwn = /gamebanana\.com\/dl\//i.test(url);
    var targets = viaOwn ? [] : [url];
    if (proxy) targets.push(proxy + encodeURIComponent(url));
    targets = targets.concat(FALLBACK_PROXIES.map(function (p) { return p + encodeURIComponent(url); }));
    var last;
    for (var i = 0; i < targets.length; i++) {
      if (signal && signal.aborted) throw new Error('Отменено');
      try {
        var ctl = new AbortController();
        var useSignal = signal ? signal : ctl.signal;
        var timer = signal ? null : setTimeout(function () { ctl.abort(); }, timeoutMs || 15000);
        var r = await fetch(targets[i], { signal: useSignal, redirect: 'follow' });
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = asNum(r.headers.get('content-length'), 0);
        if (onProgress && r.body && r.body.getReader) {
          var reader = r.body.getReader(), chunks = [], got = 0;
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            chunks.push(chunk.value); got += chunk.value.length;
            onProgress(got, total);
          }
          return concatBytes(chunks, got);
        }
        return await r.arrayBuffer();
      } catch (e) {
        if (signal && signal.aborted) throw new Error('Отменено');
        last = e;
        if (onProgress) onProgress(0, 0);
      }
    }
    throw last || new Error('Не удалось скачать файл');
  }

  function asNum(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function parseGb(url) {
    var file = url.match(/gamebanana\.com\/dl\/(\d+)/i);
    if (file) return { source: 'gamebanana-file', id: file[1], url: url };
    var item = url.match(/gamebanana\.com\/(?:apiv11\/)?(mods|sounds|wigs|textures|models|maps)\/(\d+)/i);
    if (!item) return null;
    var type = item[1].replace(/s$/i, '');
    type = type.charAt(0).toUpperCase() + type.slice(1);
    return { source: 'gamebanana', id: item[2], type: type };
  }

  async function resolveGameBanana(info, proxy) {
    var api = 'https://api.gamebanana.com/Core/Item/Data?itemtype=' + encodeURIComponent(info.type) +
      '&itemid=' + encodeURIComponent(info.id) + '&fields=name,Files().aFiles()&format=json';
    var data = JSON.parse(new TextDecoder().decode(await fetchBuffer(api, proxy)));
    var title = typeof data[0] === 'string' ? data[0] : 'GameBanana mod';
    var obj = data.find(function (x) { return x && typeof x === 'object' && !Array.isArray(x); });
    var files = Object.keys(obj || {}).map(function (k) { return obj[k]; })
      .filter(function (f) { return f && f._sDownloadUrl; })
      .map(function (f) {
        return {
          name: f._sFile || ('file-' + f._idRow + '.zip'),
          size: f._nFilesize || 0,
          url: f._sDownloadUrl,
          id: String(f._idRow),
          archived: !!f._bIsArchived
        };
      });
    if (info.source === 'gamebanana-file') {
      return { title: title, files: [{ name: 'download.zip', url: info.url, size: 0 }], source: 'gamebanana' };
    }
    return { title: title, files: files, source: 'gamebanana' };
  }

  function parseGh(url) {
    var raw = url.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(.+)$/i);
    if (raw) return { source: 'github-raw', owner: raw[1], repo: raw[2], path: raw[3], url: url };
    var m = url.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?(?:(blob|tree|archive|releases)\/([^\s#]+))?$/i);
    if (!m) return null;
    var o = { source: 'github', owner: m[1], repo: m[2], kind: m[3] || '', rest: m[4] || '' };
    if (o.kind === 'blob') {
      var p = o.rest.split('/'); o.branch = p.shift(); o.path = p.join('/');
    } else if (o.kind === 'tree') {
      var p2 = o.rest.split('/'); o.branch = p2.shift(); o.path = p2.join('/');
    } else if (o.kind === 'archive' || o.kind === 'releases') {
      return { source: 'github-zip', url: 'https://github.com/' + o.owner + '/' + o.repo + '/' + o.kind + '/' + o.rest };
    }
    return o;
  }

  async function ghApi(owner, repo, path, ref, proxy) {
    var u = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + (path ? path.split('/').map(encodeURIComponent).join('/') : '');
    if (ref) u += '?ref=' + encodeURIComponent(ref);
    var data = JSON.parse(new TextDecoder().decode(await fetchBuffer(u, proxy)));
    return Array.isArray(data) ? data : [data];
  }

  async function resolveGithub(info, proxy) {
    if (info.source === 'github-raw') {
      return { title: baseOf(info.path), files: [{ name: baseOf(info.path), url: info.url, size: 0 }], source: 'github' };
    }
    if (info.source === 'github-zip') {
      return { title: info.repo || 'GitHub archive', files: [{ name: 'archive.zip', url: info.url, size: 0 }], source: 'github' };
    }
    var entries = await ghApi(info.owner, info.repo, info.path, info.branch, proxy);
    var files = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.type === 'file' && e.download_url) {
        files.push({ name: e.name, url: e.download_url, size: e.size || 0 });
      }
    }
    // Если в папке только вложенные папки — спускаемся на один-два уровня.
    if (!files.length) {
      var dirs = entries.filter(function (e) { return e.type === 'dir'; }).slice(0, 10);
      for (var d = 0; d < dirs.length && files.length < 40; d++) {
        var sub = await ghApi(info.owner, info.repo, dirs[d].path, info.branch, proxy);
        for (var s = 0; s < sub.length; s++) {
          if (sub[s].type === 'file' && sub[s].download_url && /\.(json|zip|ogg|mp3|wav)$/i.test(sub[s].name)) {
            files.push({ name: dirs[d].name + '/' + sub[s].name, url: sub[s].download_url, size: sub[s].size || 0 });
          }
        }
      }
    }
    return { title: info.repo, files: files, source: 'github' };
  }

  /** Определяет тип ссылки и возвращает список файлов (без скачивания). */
  async function resolve(url, proxy) {
    url = String(url).trim();
    var gb = parseGb(url);
    if (gb) { var a = await resolveGameBanana(gb, proxy); a.sourceUrl = url; return a; }
    var gh = parseGh(url);
    if (gh) { var b = await resolveGithub(gh, proxy); b.sourceUrl = url; return b; }
    var name = baseOf(url);
    return { title: name.replace(/\.[a-z0-9]+$/i, ''), files: [{ name: name, url: url, size: 0 }], source: 'direct', sourceUrl: url };
  }

  /** Читает ZIP (в т.ч. deflate) через встроенный DecompressionStream. */
  async function readZip(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer), dv = new DataView(arrayBuffer);
    if (u8.length > 6 && u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72 && u8[3] === 0x21) {
      throw new Error('Это RAR-архив. Выбери .zip-версию файла в списке мода (RAR не поддерживается)');
    }
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Файл не является ZIP');
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var canInflate = typeof global.DecompressionStream !== 'undefined';
    var out = [];
    for (var n = 0; n < count; n++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true);
      var elen = dv.getUint16(off + 30, true);
      var clen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen)).replace(/\\/g, '/');
      var lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      var start = lho + 30 + lnlen + lelen;
      var comp = u8.subarray(start, start + csize);
      var data;
      if (method === 0) data = comp.slice();
      else if (method === 8) {
        if (!canInflate) throw new Error('ZIP со сжатием требует DecompressionStream (Chrome/Edge/Safari 16.4+)');
        var ds = new global.DecompressionStream('deflate-raw');
        var stream = new Blob([comp]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error('Неизвестный метод сжатия ZIP: ' + method);
      if (name.charAt(name.length - 1) !== '/') out.push({ name: name, data: data });
      off += 46 + nlen + elen + clen;
    }
    return out;
  }

  function songKey(name) {
    var lower = name.toLowerCase();
    var m = lower.match(/(?:^|\/)songs\/([^\/]+)\//);
    if (m) return m[1];
    var parts = name.split('/');
    if (parts.length > 1) return parts[parts.length - 2];
    return name.replace(/\.[^.]+$/, '');
  }

  function findAudio(key, audios) {
    var k = key.toLowerCase();
    var pool = audios.filter(function (a) { return a.name.toLowerCase().indexOf('/' + k + '/') >= 0; });
    if (!pool.length) pool = audios;
    var inst = pool.find(function (a) { return /(^|\/|\b)inst(rumental)?\./i.test(a.name); });
    var voices = pool.find(function (a) { return /(^|\/|\b)voic(e|al)s?\./i.test(a.name); });
    return { inst: inst || null, voices: voices || null, single: pool.length === 1 ? pool[0] : null };
  }

  /** Скачивает выбранные файлы, распаковывает, находит чарты и аудио. */
  async function load(files, proxy, onProgress, options) {
    var progress = onProgress || function () {};
    var opts = options || {};
    var keys = opts.keys || 4;
    var entries = [];
    for (var i = 0; i < files.length; i++) {
      progress('Скачиваю ' + files[i].name + '...');
      var buf = await fetchBuffer(files[i].url, proxy, 120000, function (got, total) {
        progress(total ? 'Скачиваю ' + files[i].name + ': ' + Math.round(got / total * 100) + '%' :
          'Скачиваю ' + files[i].name + ': ' + (got / 1048576).toFixed(1) + ' МБ');
      }, opts.signal);
      if (/\.zip$/i.test(files[i].name) || /gamebanana\.com\/dl/i.test(files[i].url)) {
        progress('Распаковываю ' + files[i].name + '...');
        entries = entries.concat(await readZip(buf));
      } else {
        entries.push({ name: files[i].name, data: new Uint8Array(buf) });
      }
    }

    progress('Ищу чарты...');
    var charts = [], audios = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (/\.json$/i.test(e.name) && e.data.length < 5000000) {
        try {
          var fName = e.name.split('/').pop();
          var variants = A.parseChartVariants(new TextDecoder().decode(e.data), fName, { keys: keys });
          variants.forEach(function (p) {
            if (!p.notes.length) return;
            var diff;
            if (variants.length > 1) {
              var prefix = /-chart-([a-z0-9]+)/i.exec(fName);
              var variant = prefix ? prefix[1] : '';
              var key = p.name.split(' ').pop() || 'diff';
              diff = (variant && variant !== key ? variant + '-' : '') + key + '.json';
            } else diff = fName;
            charts.push({ path: e.name, name: diff, parsed: p, key: songKey(e.name) });
          });
        } catch (err) { /* не чарт — пропускаем */ }
      } else if (/\.(ogg|mp3|wav|m4a|flac)$/i.test(e.name)) {
        audios.push(e);
      }
    }
    if (!charts.length) throw new Error('В архиве не найдено ни одного чарта с нотами');

    var map = {};
    for (var c = 0; c < charts.length; c++) {
      var ch = charts[c];
      if (!map[ch.key]) map[ch.key] = { key: ch.key, song: ch.key, charts: [], audio: null, audioExt: null };
      map[ch.key].charts.push(ch);
    }

    progress('Собираю аудио...');
    var groups = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var g = map[key];
      var found = findAudio(key, audios);
      try {
        if (found.inst && found.voices) {
          var mixed = await A.mixAudio([bytesOf(found.inst.data), bytesOf(found.voices.data)], 0, opts.mp3 !== false);
          g.audio = mixed.buffer; g.audioExt = mixed.ext;
          found.inst.data = null; found.voices.data = null;
        } else if (found.inst) {
          g.audio = bytesOf(found.inst.data); g.audioExt = (found.inst.name.split('.').pop() || 'ogg').toLowerCase();
        } else if (found.single) {
          g.audio = bytesOf(found.single.data); g.audioExt = (found.single.name.split('.').pop() || 'ogg').toLowerCase();
        }
      } catch (ae) {
        g.audioError = String(ae && ae.message || ae);
      }
      g.source = opts.source || null;
      groups.push(g);
    }
    return { groups: groups, entries: entries.length, audios: audios.length, source: opts.source || null };
  }

  var API = { resolve: resolve, load: load, readZip: readZip, fetchBuffer: fetchBuffer, parseGb: parseGb, parseGh: parseGh };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.FnfImport = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
