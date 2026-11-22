/*
 * FNF -> osu!mania 4K конвертер.
 * Чистая логика без DOM: можно использовать и в браузере, и в Node (для тестов).
 */
(function (global) {
  'use strict';

  function firstDefined(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  function asNumber(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  // Поддерживаем несколько форматов чартов FNF:
  //  1) song.notes = плоский массив нот (Psych Engine / новые версии)
  //  2) song.notes = массив секций со sectionNotes (старый формат)
  //  3) song = массив нот, либо data.notes = массив нот
  function extractRawNotes(data, song) {
    var s = song || data;
    if (s && Array.isArray(s.notes)) {
      if (s.notes.length && s.notes[0] && s.notes[0].sectionNotes) {
        var out = [];
        for (var sec = 0; sec < s.notes.length; sec++) {
          var section = s.notes[sec];
          var playerSection = section.mustHitSection !== false;
          var list = section.sectionNotes || [];
          for (var j = 0; j < list.length; j++) {
            var item = list[j];
            if (Array.isArray(item)) {
              // [time, lane, holdLength, type]
              out.push({
                songTime: item[0], noteData: item[1],
                holdLength: typeof item[2] === 'number' ? item[2] : 0,
                noteType: typeof item[3] === 'string' ? item[3] : '',
                _player: playerSection
              });
            } else out.push(item);
          }
        }
        return out;
      }
      return s.notes;
    }
    if (Array.isArray(data.song)) return data.song;
    if (Array.isArray(data.notes)) return data.notes;
    return [];
  }

  function normalizeNotes(rawNotes, keys) {
    keys = keys || 4;
    var out = [];
    if (!Array.isArray(rawNotes)) return out;
    for (var i = 0; i < rawNotes.length; i++) {
      var n = rawNotes[i];
      if (Array.isArray(n)) {
        var t = asNumber(n[0], NaN);
        var d = asNumber(n[1], NaN);
        if (isFinite(t) && isFinite(d)) {
          out.push({
            time: t, lane: d,
            noteType: typeof n[3] === 'string' ? n[3] : (typeof n[2] === 'string' ? n[2] : ''),
            isTail: false,
            holdLength: typeof n[2] === 'number' ? n[2] : 0
          });
        }
        continue;
      }
      if (!n || typeof n !== 'object') continue;
      var time = asNumber(firstDefined(n, ['songTime', 'noteTime', 'time', 'strumTime', 'startTime']), NaN);
      var lane = asNumber(firstDefined(n, ['noteData', 'lane', 'column', 'data']), NaN);
      if (!isFinite(time) || !isFinite(lane)) continue;
      // В 4K-секциях Psych/Vanilla 0..3 и 4..7 — разные стороны.
      // В 5K+ дорожки 4..7 — часть игрового поля, поэтому их оставляем.
      if (n._player === false && keys <= 4) {
        if (lane < 4) continue;
        lane -= 4;
      } else if (n._player === true && keys <= 4 && lane >= 4) continue;
      if (lane >= keys) continue;
      var noteType = String(firstDefined(n, ['noteType', 'type', 'event']) || '');
      var isTail = n.isSustainNote === true || /hold.?end|holdend|tail/i.test(noteType);
      var holdLength = asNumber(firstDefined(n, ['holdLength', 'sustainLength', 'length', 'noteLength']), 0);
      out.push({
        time: time,
        lane: lane,
        noteType: noteType,
        isTail: isTail,
        holdLength: isFinite(holdLength) && holdLength > 0 ? holdLength : 0
      });
    }
    return out;
  }

  /**
   * Разбор чарта в промежуточную модель.
   * @returns {{name, bpm, speed, notes:Array<{time,lane,endTime,alt}>, warnings:string[]}}
   */
  function parseChart(raw, fileName, options) {
    var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    var keys = (options && options.keys) || 4;
    if (!data || typeof data !== 'object') throw new Error('Пустой или неверный JSON');

    var songField = data.song !== undefined ? data.song : (data.chart !== undefined ? data.chart : data);
    var songNameString = typeof songField === 'string' ? songField : null;
    var song = (songField && typeof songField === 'object' && !Array.isArray(songField)) ? songField : data;
    if (Array.isArray(song)) song = data.meta || data.metadata || {};

    var meta = firstDefined(song, ['meta', 'metadata']) || data.meta || data.metadata || {};
    var name = String(songNameString || firstDefined(song, ['name', 'songName', 'song', 'title']) ||
      firstDefined(meta, ['name', 'title', 'song']) ||
      (fileName ? fileName.replace(/\.json$/i, '') : '') || 'Untitled');

    var bpm = asNumber(firstDefined(song, ['bpm', 'BPM']), asNumber(data.bpm, 128));
    if (!(bpm > 0) && song.notes && song.notes[0] && song.notes[0].bpm) bpm = asNumber(song.notes[0].bpm, 128);
    if (!(bpm > 0)) bpm = 128;
    var speed = asNumber(firstDefined(song, ['speed', 'scrollSpeed']), 1);

    // Тайминг: секции с changeBPM дают полноценную карту смен BPM.
    var timing = [{ offset: 0, bpm: bpm }];
    if (Array.isArray(song.notes) && song.notes[0] && song.notes[0].sectionNotes) {
      var cursor = 0;
      timing = [];
      for (var si = 0; si < song.notes.length; si++) {
        var sec = song.notes[si];
        var sectBpm = asNumber(sec.bpm, bpm);
        var beats = asNumber(sec.sectionBeats, 4);
        if (sec.changeBPM && sectBpm > 0) timing.push({ offset: Math.round(cursor), bpm: sectBpm });
        cursor += beats * 60000 / (sectBpm > 0 ? sectBpm : bpm);
      }
      if (!timing.length || timing[0].offset !== 0) timing.unshift({ offset: 0, bpm: bpm });
    }

    var warnings = [];
    var events = normalizeNotes(extractRawNotes(data, song), keys).sort(function (a, b) { return a.time - b.time; });
    if (!events.length) warnings.push('В чарте не найдено ни одной ноты');
    if (keys > 4) warnings.push('Режим ' + keys + 'K: дорожки 4+ считаются игровыми');

    var notes = [];
    var open = {}; // lane -> индекс незакрытой ноты (для hold)

    for (var i = 0; i < events.length; i++) {
      var e = events[i];

      if (e.isTail) {
        var idx = open[e.lane];
        if (idx !== undefined && notes[idx].endTime == null && e.time > notes[idx].time) {
          notes[idx].endTime = e.time;
        }
        delete open[e.lane];
        continue;
      }

      var lane = Math.round(e.lane);
      if (lane < 0 || lane >= keys) {
        warnings.push('Нота вне ' + keys + ' дорожек (lane=' + lane + ') обрезана');
        lane = Math.max(0, Math.min(keys - 1, lane));
      }

      var note = {
        time: e.time,
        lane: lane,
        endTime: e.holdLength > 0 ? e.time + e.holdLength : null,
        alt: /alt/i.test(e.noteType)
      };
      notes.push(note);
      if (note.endTime == null) open[e.lane] = notes.length - 1;
      else delete open[e.lane];
    }

    notes.sort(function (a, b) { return a.time - b.time; });
    var altCount = notes.filter(function (n) { return n.alt; }).length;
    if (altCount) warnings.push('Альт-нот: ' + altCount + ' (по умолчанию они обычные)');

    return { name: name, bpm: bpm, speed: speed, notes: notes, timing: timing, keys: keys, warnings: warnings };
  }

  /**
   * Некоторые порты (V-Slice / Polymod) хранят чарт как {notes:{easy:[{d,t,l}],...}}.
   * Возвращает отдельную модель для каждой сложности.
   */
  function parseChartVariants(raw, fileName, options) {
    var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    var keys = (options && options.keys) || 4;
    if (data && data.notes && !Array.isArray(data.notes) && typeof data.notes === 'object') {
      var keys = Object.keys(data.notes).filter(function (k) {
        return Array.isArray(data.notes[k]) && data.notes[k].length;
      });
      var first = keys.length ? data.notes[keys[0]][0] : null;
      if (first && typeof first === 'object' && first.t !== undefined) {
        var bpm = asNumber(firstDefined(data, ['bpm', 'BPM']), 128);
        var base = String(firstDefined(data, ['name', 'song', 'songName', 'title']) ||
          (fileName ? fileName.replace(/-chart\.json$|\.json$/i, '') : '') || 'song');
        return keys.map(function (key) {
          var notes = [];
          var list = data.notes[key];
          for (var i = 0; i < list.length; i++) {
            var n = list[i];
            var lane = Math.round(asNumber(firstDefined(n, ['d', 'noteData', 'lane']), NaN));
            var t = asNumber(firstDefined(n, ['t', 'time', 'songTime']), NaN);
            // В 4K d 4..7 — вторая сторона (opponent); в 5K+ это игровые дорожки
            if (!isFinite(lane) || lane < 0 || lane >= keys || !isFinite(t)) continue;
            var len = asNumber(firstDefined(n, ['l', 'length', 'holdLength']), 0);
            notes.push({ time: t, lane: lane, endTime: len > 0 ? t + len : null, alt: false });
          }
          notes.sort(function (a, b) { return a.time - b.time; });
          return {
            name: base + ' ' + key, bpm: bpm, speed: 1, notes: notes,
            timing: [{ offset: 0, bpm: bpm }], keys: keys,
            warnings: bpm === 128 ? ['BPM не указан в чарте — принят 128'] : []
          };
        });
      }
    }
    return [parseChart(data, fileName, options)];
  }

  /** Сборка текста .osu для osu!mania (4K и выше) */
  function buildOsu(parsed, options) {
    var o = options || {};
    var shift = asNumber(o.timeShift, 0);
    var columns = asNumber(o.keys, parsed.keys || 4);
    if (columns < 1 || columns > 18) columns = 4;
    var beatLength = 60000 / parsed.bpm;
    var title = String(o.title || parsed.name || 'Untitled').replace(/,/g, ' ');
    var artist = String(o.artist || 'Unknown').replace(/,/g, ' ');
    var creator = String(o.creator || 'FNF2osu').replace(/,/g, ' ');
    var version = String(o.version || 'Normal').replace(/,/g, ' ');
    var audioFile = String(o.audioFile || 'audio.mp3');
    var hp = asNumber(o.hp, 5);
    var od = asNumber(o.od, 8);
    var altWhistle = !!o.altAsWhistle;

    var L = [];
    L.push('osu file format v14');
    L.push('');
    L.push('[General]');
    L.push('AudioFilename: ' + audioFile);
    L.push('AudioLeadIn: 0');
    L.push('Mode: 3');
    L.push('');
    L.push('[Metadata]');
    L.push('Title:' + title);
    L.push('Artist:' + artist);
    L.push('Creator:' + creator);
    L.push('Version:' + version);
    L.push('Source:' + String(o.source || '').replace(/,/g, ' '));
    L.push('Tags:fnf' + (o.tags ? ' ' + String(o.tags).replace(/,/g, ' ') : ''));
    L.push('BeatmapID:0');
    L.push('BeatmapSetID:-1');
    L.push('');
    L.push('[Difficulty]');
    L.push('HPDrainRate:' + hp);
    L.push('CircleSize:' + columns);
    L.push('OverallDifficulty:' + od);
    L.push('ApproachRate:5');
    L.push('SliderMultiplier:1.4');
    L.push('SliderTickRate:1');
    L.push('');
    L.push('[TimingPoints]');
    var timing = (parsed.timing && parsed.timing.length) ? parsed.timing : [{ offset: 0, bpm: parsed.bpm }];
    for (var ti = 0; ti < timing.length; ti++) {
      var tp = timing[ti];
      var tb = tp.bpm > 0 ? 60000 / tp.bpm : beatLength;
      L.push(Math.round(tp.offset + shift) + ',' + tb.toFixed(3) + ',4,2,1,60,1,0');
    }
    // Ненаследуемая точка с отрицательным beatLength задаёт SV в mania.
    var sv = asNumber(o.sv, 0);
    if (sv > 0) L.push(Math.round(shift) + ',' + (-100 * sv).toFixed(3) + ',4,2,1,60,0,0');
    L.push('');
    L.push('[HitObjects]');

    for (var i = 0; i < parsed.notes.length; i++) {
      var n = parsed.notes[i];
      var x = n.lane * (512 / columns); // 0, 128, 256, 384
      var hitSound = altWhistle && n.alt ? 2 : 0;
      var time = Math.round(n.time + shift);
      if (n.endTime != null) {
        var end = Math.round(n.endTime + shift);
        if (end <= time) end = time + 1;
        L.push(x + ',192,' + time + ',128,' + hitSound + ',' + end + ':0:0:0:0:');
      } else {
        L.push(x + ',192,' + time + ',1,' + hitSound + ',0:0:0:0:');
      }
    }
    return L.join('\n') + '\n';
  }

  // ---------- ZIP (STORE, без сжатия) без внешних библиотек ----------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
    return new TextEncoder().encode(String(data));
  }

  function safeName(name) {
    // оставляем кириллицу и скобки [Diff], убираем только запрещённые в имени файла символы
    return String(name).replace(/[\\\/:\*\?"<>\|]+/g, '_').replace(/[\x00-\x1f]/g, '').trim().slice(0, 120) || 'file';
  }

  /** files: [{name:string, data:string|Uint8Array|ArrayBuffer}] */
  function makeZip(files) {
    var enc = new TextEncoder();
    var locals = [], centrals = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var nameB = enc.encode(safeName(files[i].name));
      var data = toBytes(files[i].data);
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameB.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 имена
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, 0, true); // time
      lv.setUint16(12, 0x21, true); // date: 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameB.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameB, 30);
      locals.push(lh, data);

      var ch = new Uint8Array(46 + nameB.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); // UTF-8 имена
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameB, 46);
      centrals.push(ch);

      offset += lh.length + data.length;
    }

    var cdSize = 0;
    for (var j = 0; j < centrals.length; j++) cdSize += centrals[j].length;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + cdSize + eocd.length;
    var result = new Uint8Array(total);
    var pos = 0;
    var all = locals.concat(centrals, [eocd]);
    for (var k = 0; k < all.length; k++) {
      result.set(all[k], pos);
      pos += all[k].length;
    }
    return result;
  }

  // ---------- Аудио (Web Audio) ----------

  function newCtx() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio недоступен');
    return new Ctx();
  }

  /** Кодирует каналы (Float32Array[]) в 16-битный WAV, при желании с паузой спереди. */
  function encodeWav(channelsData, sampleRate, padMs) {
    var channels = channelsData.length;
    var frames = channelsData[0].length;
    var pad = Math.round((padMs || 0) / 1000 * sampleRate);
    var total = frames + pad;
    var bytes = new ArrayBuffer(44 + total * channels * 2);
    var view = new DataView(bytes);

    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    view.setUint32(4, 36 + total * channels * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, total * channels * 2, true);

    var peak = 0;
    for (var c = 0; c < channels; c++) {
      var src = channelsData[c];
      for (var i = 0; i < frames; i++) {
        var a = src[i] < 0 ? -src[i] : src[i];
        if (a > peak) peak = a;
      }
    }
    var gain = peak > 1 ? 1 / peak : 1;
    var off = 44;
    for (var n = 0; n < total; n++) {
      for (var ch = 0; ch < channels; ch++) {
        var v = n < pad ? 0 : channelsData[ch][n - pad] * gain;
        if (v < -1) v = -1; else if (v > 1) v = 1;
        view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        off += 2;
      }
    }
    return bytes;
  }

  async function decodeAudio(arrayBuffer) {
    var ctx = newCtx();
    try { return await ctx.decodeAudioData(arrayBuffer.slice(0)); }
    finally { if (ctx.close) ctx.close(); }
  }

  function toInt16(f) {
    var a = new Int16Array(f.length);
    for (var i = 0; i < f.length; i++) {
      var v = f[i]; if (v < -1) v = -1; else if (v > 1) v = 1;
      a[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return a;
  }

  /** Кодирует PCM в MP3 через lamejs. Возвращает null, если библиотека недоступна. */
  function encodeMp3(channelsData, sampleRate, kbps) {
    if (!global.lamejs || !global.lamejs.Mp3Encoder) return null;
    try {
      var ch = channelsData.length;
      var enc = new global.lamejs.Mp3Encoder(ch, sampleRate, kbps || 192);
      var chunks = [], len = channelsData[0].length, block = 1152;
      for (var i = 0; i < len; i += block) {
        var l = channelsData[0].subarray(i, Math.min(i + block, len));
        var r = ch > 1 ? channelsData[1].subarray(i, Math.min(i + block, len)) : l;
        var buf = enc.encodeBuffer(toInt16(l), toInt16(r));
        if (buf && buf.length) chunks.push(buf);
      }
      var end = enc.flush();
      if (end && end.length) chunks.push(end);
      var total = 0;
      for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
      var out = new Uint8Array(total), pos = 0;
      for (var k = 0; k < chunks.length; k++) { out.set(chunks[k], pos); pos += chunks[k].length; }
      return out.buffer;
    } catch (e) { return null; }
  }

  /** Смешивает Inst + Voices и кодирует в MP3 (или WAV как fallback). */
  async function mixAudio(buffers, padMs, wantMp3) {
    if (!buffers.length) throw new Error('Нет аудио для смешивания');
    var decoded = [];
    for (var i = 0; i < buffers.length; i++) decoded.push(await decodeAudio(buffers[i]));
    var rate = decoded[0].sampleRate;
    var frames = 0;
    for (var d = 0; d < decoded.length; d++) frames = Math.max(frames, decoded[d].length);
    var channels = 1;
    for (var c = 0; c < decoded.length; c++) channels = Math.max(channels, Math.min(decoded[c].numberOfChannels, 2));

    var out = [];
    for (var ch2 = 0; ch2 < channels; ch2++) out.push(new Float32Array(frames));
    var scale = decoded.length > 1 ? 0.8 : 1;
    for (var k = 0; k < decoded.length; k++) {
      var a = decoded[k];
      for (var cc = 0; cc < channels; cc++) {
        var src = a.getChannelData(Math.min(cc, a.numberOfChannels - 1));
        var dst = out[cc];
        for (var s = 0; s < a.length; s++) dst[s] += src[s] * scale;
      }
    }
    if (wantMp3) {
      var mp3 = encodeMp3(out, rate, 192);
      if (mp3) return { buffer: mp3, ext: 'mp3' };
    }
    return { buffer: encodeWav(out, rate, padMs), ext: 'wav' };
  }

  /** Смешивает несколько аудиофайлов (Inst + Voices) в один WAV. */
  async function mixToWav(buffers, padMs) {
    return (await mixAudio(buffers, padMs, false)).buffer;
  }

  /** Добавить тишину в начало аудио и перекодировать в WAV (Web Audio API). */
  async function prependSilence(arrayBuffer, ms) {
    if (!ms) return { buffer: arrayBuffer, ext: null };
    try {
      var audio = await decodeAudio(arrayBuffer);
      var channels = Math.min(audio.numberOfChannels, 2);
      var data = [];
      for (var c = 0; c < channels; c++) data.push(audio.getChannelData(c));
      return { buffer: encodeWav(data, audio.sampleRate, ms), ext: 'wav' };
    } catch (e) {
      return { buffer: null, ext: null, error: String(e && e.message || e) };
    }
  }

  var API = {
    parseChart: parseChart,
    parseChartVariants: parseChartVariants,
    buildOsu: buildOsu,
    makeZip: makeZip,
    crc32: crc32,
    prependSilence: prependSilence,
    decodeAudio: decodeAudio,
    mixToWav: mixToWav,
    mixAudio: mixAudio,
    encodeMp3: encodeMp3,
    encodeWav: encodeWav,
    safeName: safeName
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Fnf2Osu = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
