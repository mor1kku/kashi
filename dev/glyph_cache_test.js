/* Run with: node dev/glyph_cache_test.js (no dependencies). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/02_fonts.js'), 'utf8');
function setup() {
  const document = { createElement() {
    const canvas = { width: 0, height: 0, text: '' };
    const context = {
      measureText: () => ({ width: 50 }),
      fillText: text => { canvas.text = text; },
      getImageData: (_x, _y, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        // One eight-by-eight connected component; exercises real decomposition.
        if (canvas.text !== ' ') for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) data[(y * width + x) * 4 + 3] = 255;
        return { data };
      },
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: image => { canvas.image = image; },
      drawImage: image => { canvas.source = image; },
      fillRect: () => { canvas.painted = true; },
    };
    canvas.getContext = () => context;
    return canvas;
  } };
  const J = {};
  vm.runInNewContext(source, { J, document });
  return { cache: J.glyphs, document };
}
function piece(document, id, width, height = width) {
  const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
  return { id, cv };
}
function assertTintAccounting(cache) {
  const actual = [...cache.tint.values()].reduce((sum, cv) => sum + cv.width * cv.height * 4, 0);
  assert.equal(cache.tintBytes, actual);
  assert.ok(actual <= cache.maxTintBytes);
  assert.ok(cache.tint.size <= cache.maxTintEntries);
}
test('many animated colors stay within the default 32 MiB tint budget', () => {
  const { cache, document } = setup(); const glyphPiece = piece(document, 1, 64);
  for (let color = 0; color < 20000; color++) cache.sprite(glyphPiece, `rgb(${color},1,2)`);
  assertTintAccounting(cache);
  assert.equal(cache.tintBytes, 32 * 1024 * 1024);
  assert.equal(cache.tint.size, 2048);
});
test('small sprites also have bounded metadata entry count', () => {
  const { cache, document } = setup(); const glyphPiece = piece(document, 1, 1);
  for (let color = 0; color < 10000; color++) cache.sprite(glyphPiece, `color-${color}`);
  assertTintAccounting(cache); assert.equal(cache.tint.size, 4096);
});
test('tint cache reuses hot entries and evicts the least recently used without erasing returned canvases', () => {
  const { cache, document } = setup(); cache.maxTintBytes = 32;
  const glyphPiece = piece(document, 1, 2);
  const red = cache.sprite(glyphPiece, 'red'), green = cache.sprite(glyphPiece, 'green');
  assert.equal(cache.sprite(glyphPiece, 'red'), red);
  cache.sprite(glyphPiece, 'blue');
  assert.equal(cache.sprite(glyphPiece, 'red'), red);
  assert.equal(cache.tint.has('1|green'), false);
  assert.equal(green.width, 2); assert.equal(green.height, 2); assert.equal(green.painted, true);
  assertTintAccounting(cache);
});
test('white sprites reuse source and oversized tinted canvases are returned but not cached', () => {
  const { cache, document } = setup(); cache.maxTintBytes = 100;
  const glyphPiece = piece(document, 1, 10);
  assert.equal(cache.sprite(glyphPiece, '#fff'), glyphPiece.cv);
  assert.equal(cache.sprite(glyphPiece, '#ffffff'), glyphPiece.cv);
  const red = cache.sprite(glyphPiece, 'red'); assert.equal(red.width, 10); assert.equal(red.painted, true);
  assert.equal(cache.tint.size, 0); assert.equal(cache.tintBytes, 0);
});
test('glyph cache enforces byte budget using actual piece canvas dimensions', () => {
  const { cache } = setup(); cache.maxGlyphBytes = 4 * 8 * 8 * 4;
  const first = cache.get('gothic_bold', 'A', 64);
  assert.equal(first.pieces.length, 1); assert.equal(first.cacheBytes, 256);
  for (let i = 0; i < 20; i++) cache.get('gothic_bold', String.fromCharCode(66 + i), 64);
  assert.equal(cache.map.size, 4); assert.equal(cache.glyphBytes, 1024);
  assert.equal([...cache.map.values()].reduce((sum, g) => sum + g.cacheBytes, 0), cache.glyphBytes);
  assert.equal(first.pieces[0].cv.width, 8); assert.equal(first.pieces[0].cv.height, 8);
  assert.ok(first.pieces[0].cv.image.data.some(value => value === 255));
});
test('glyph LRU keeps recently used decompositions; oversized glyphs are not retained', () => {
  const { cache } = setup(); cache.maxGlyphBytes = 512;
  const a = cache.get('gothic_bold', 'A', 64), b = cache.get('gothic_bold', 'B', 64);
  assert.equal(cache.get('gothic_bold', 'A', 64), a);
  cache.get('gothic_bold', 'C', 64);
  assert.equal(cache.map.has('gothic_bold|B|64'), false);
  assert.equal(cache.get('gothic_bold', 'A', 64), a);
  assert.equal(b.pieces[0].cv.width, 8);
  cache.clear(); cache.maxGlyphBytes = 128;
  const oversized = cache.get('gothic_bold', 'A', 64);
  assert.equal(oversized.pieces.length, 1); assert.equal(cache.map.size, 0); assert.equal(cache.glyphBytes, 0);
});
test('empty glyph entries are count bounded; clearing resets all accounting', () => {
  const { cache, document } = setup(); cache.maxGlyphEntries = 3;
  for (let i = 0; i < 10; i++) cache.get(`font-${i}`, ' ', 64);
  assert.equal(cache.map.size, 3); assert.equal(cache.glyphBytes, 0);
  cache.sprite(piece(document, 99, 2), 'blue'); assert.ok(cache.tintBytes > 0);
  cache.clear(); assert.equal(cache.map.size, 0); assert.equal(cache.tint.size, 0);
  assert.equal(cache.glyphBytes, 0); assert.equal(cache.tintBytes, 0);
});
