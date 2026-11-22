/* Быстрая проверка чистой логики: node test.js */
const fs = require('fs');
const A = require('./app.js');
const assert = require('assert');

const parsed = A.parseChart(fs.readFileSync('sample-chart.json', 'utf8'), 'test.json');
console.log('parsed:', parsed.name, parsed.bpm + ' BPM', parsed.notes.length + ' notes');
assert.strictEqual(parsed.name, 'Test Bop');
assert.strictEqual(parsed.bpm, 128);
assert.strictEqual(parsed.notes.length, 6);

// hold по holdLength: 2687 + 469 = 3156
assert.strictEqual(parsed.notes.find(n => n.lane === 3).endTime, 3156);
// hold по tail-ноте: 3000 -> 3156
assert.strictEqual(parsed.notes.find(n => n.lane === 0 && n.time === 3000).endTime, 3156);
assert.strictEqual(parsed.notes.find(n => n.alt).lane, 1);

const osu = A.buildOsu(parsed, { title: 'Test Bop', artist: 'FNF', creator: 'me', version: 'Hard', audioFile: 'audio.mp3' });
assert(osu.startsWith('osu file format v14'));
assert(osu.includes('Mode: 3'));
assert(osu.includes('0,468.750,4,2,1,60,1,0')); // 60000/128
assert(osu.includes('384,192,2687,128,0,3156:0:0:0:0:')); // long note
assert(osu.includes('128,192,2437,1,2,0:0:0:0:')); // alt как hitsound=2

const zip = A.makeZip([
  { name: 'audio.mp3', data: 'AUDIO-DATA' },
  { name: 'map.osu', data: osu }
]);
assert.strictEqual(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
assert.strictEqual(new TextDecoder().decode(zip.slice(30, 39)), 'audio.mp3');
console.log('zip:', zip.length, 'bytes, sig OK');
console.log('ALL OK');
