/*
 * Простой аудио-фингерпринтинг в духе Shazam: STFT -> пики -> хеши пар пиков.
 * Без внешних библиотек. Используется страницей audio-search.html.
 */
(function (global) {
  'use strict';

  function fft(re, im) {
    var n = re.length, j = 0;
    for (var i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var k = 0; k < n; k += len) {
        var cr = 1, ci = 0;
        for (var m = 0; m < len / 2; m++) {
          var a = k + m, b = a + len / 2;
          var ur = re[a], ui = im[a];
          var vr = re[b] * cr - im[b] * ci;
          var vi = re[b] * ci + im[b] * cr;
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  var WIN = 2048, HOP = 512, BANDS = 48, FMIN = 80, FMAX = 8000;

  function bandEdges(sampleRate) {
    var edges = [];
    for (var b = 0; b <= BANDS; b++) {
      var f = FMIN * Math.pow(FMAX / FMIN, b / BANDS);
      edges.push(Math.min(WIN / 2 - 1, Math.round(f / sampleRate * WIN)));
    }
    return edges;
  }

  /** Возвращает {peaks:[{f,t,v}], duration, sampleRate} */
  function landmarks(audioBuffer) {
    var sr = audioBuffer.sampleRate;
    var chans = Math.min(audioBuffer.numberOfChannels, 2);
    var data = audioBuffer.getChannelData(0);
    if (chans === 2) {
      var r = audioBuffer.getChannelData(1);
      // смешиваем в моно
      var mono = new Float32Array(data.length);
      for (var z = 0; z < data.length; z++) mono[z] = (data[z] + r[z]) * 0.5;
      data = mono;
    }
    var edges = bandEdges(sr);
    var frames = Math.max(0, Math.floor((data.length - WIN) / HOP));
    var spec = new Float32Array(frames * BANDS);
    var win = new Float32Array(WIN);
    for (var w = 0; w < WIN; w++) win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / (WIN - 1));

    for (var i = 0; i < frames; i++) {
      var re = new Float64Array(WIN), im = new Float64Array(WIN);
      var off = i * HOP;
      for (var k = 0; k < WIN; k++) { re[k] = data[off + k] * win[k]; im[k] = 0; }
      fft(re, im);
      for (var b = 0; b < BANDS; b++) {
        var lo = edges[b], hi = Math.max(lo + 1, edges[b + 1]), max = 0;
        for (var f = lo; f < hi; f++) {
          var mag = Math.sqrt(re[f] * re[f] + im[f] * im[f]);
          if (mag > max) max = mag;
        }
        spec[i * BANDS + b] = 20 * Math.log10(max + 1e-9);
      }
    }

    // адаптивный порог: среднее по всей записи + 6 дБ
    var sum = 0, cnt = 0;
    for (var s = 0; s < spec.length; s++) { if (isFinite(spec[s])) { sum += spec[s]; cnt++; } }
    var mean = cnt ? sum / cnt : 0, threshold = mean + 6;

    var peaks = [];
    for (var t = 2; t < frames - 2; t++) {
      for (var bb = 2; bb < BANDS - 2; bb++) {
        var v = spec[t * BANDS + bb];
        if (v < threshold) continue;
        var ok = true;
        for (var dt = -2; dt <= 2 && ok; dt++) {
          for (var db = -2; db <= 2; db++) {
            if (!dt && !db) continue;
            if (spec[(t + dt) * BANDS + bb + db] > v) { ok = false; break; }
          }
        }
        if (ok) peaks.push({ f: bb, t: t, time: t * HOP / sr, v: v });
      }
    }
    // оставляем самые сильные, чтобы хешей не было миллионы
    peaks.sort(function (a, b) { return b.v - a.v; });
    peaks = peaks.slice(0, 5000).sort(function (a, b) { return a.t - b.t; });
    return { peaks: peaks, frames: frames, duration: audioBuffer.duration, sampleRate: sr };
  }

  /** Хеши пар пиков. Возвращает Map<hash, [time1,...]> */
  function hashes(lm) {
    var out = new Map();
    var peaks = lm.peaks;
    for (var i = 0; i < peaks.length; i++) {
      var a = peaks[i];
      for (var j = i + 1; j < peaks.length && peaks[j].t - a.t <= 80; j++) {
        var b = peaks[j];
        var dt = b.t - a.t;
        if (dt < 2) continue;
        var df = Math.abs(b.f - a.f);
        if (df > 16) continue;
        var h = ((a.f << 12) | (b.f << 6) | (dt & 63)) >>> 0;
        var arr = out.get(h); if (!arr) { arr = []; out.set(h, arr); }
        arr.push(a.time);
        if (j > i + 12) break;
      }
    }
    return out;
  }

  /** Добавить запись в базу. db: Map<hash, [{id,t}]> */
  function addToDb(db, id, hs) {
    hs.forEach(function (times, hash) {
      var arr = db.get(hash); if (!arr) { arr = []; db.set(hash, arr); }
      for (var i = 0; i < times.length; i++) arr.push({ id: id, t: times[i] });
    });
  }

  /** Ищет лучшее совпадение. Возвращает {id, count, offset} или null. */
  function match(db, hs) {
    var votes = new Map();
    hs.forEach(function (times, hash) {
      var entries = db.get(hash); if (!entries) return;
      for (var i = 0; i < times.length; i++) {
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].id === '__query__') continue;
          var offset = Math.round((entries[j].t - times[i]) * 100) / 100;
          var key = entries[j].id + '@' + offset;
          votes.set(key, (votes.get(key) || 0) + 1);
        }
      }
    });
    var best = null;
    votes.forEach(function (count, key) {
      if (!best || count > best.count) {
        var at = key.lastIndexOf('@');
        best = { id: key.slice(0, at), offset: Number(key.slice(at + 1)), count: count };
      }
    });
    return best;
  }

  var API = { fft: fft, landmarks: landmarks, hashes: hashes, addToDb: addToDb, match: match, WIN: WIN, HOP: HOP };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Fingerprint = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
