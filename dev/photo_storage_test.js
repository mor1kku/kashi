/* Run with: node dev/photo_storage_test.js (no dependencies). */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/11q_photo.js'), 'utf8');

function setup({ noIDB = false } = {}) {
  const state = { records: new Map(), failPut: false, failGet: null, failDelete: false, failOpen: 0, opens: 0, transactions: [], notifications: [], urls: new Map(), closes: 0 };
  const db = {
    objectStoreNames: { contains: () => true },
    close() { state.closes++; },
    transaction(_store, mode) {
      const tx = { error: null };
      tx.objectStore = () => Object.fromEntries(['put', 'get', 'delete'].map(operation => [operation, value => {
        const request = { result: undefined, error: null };
        state.transactions.push({ mode, operation, value });
        setTimeout(() => {
          const fail = operation === 'put' ? state.failPut : operation === 'get' ? state.failGet : state.failDelete;
          if (operation === 'get') request.result = state.records.get(value);
          if (fail === 'abort-after-success') { request.result = undefined; request.onsuccess?.(); }
          if (fail) {
            tx.error = new Error(`${operation}-failed`);
            // Abort-only events deliberately exercise the formerly missing handler.
            if (fail === 'request-error') { request.error = tx.error; request.onerror?.(); }
            tx.onabort?.(); return;
          }
          if (operation === 'put') { state.records.set(value.id, value); request.result = value.id; }
          if (operation === 'delete') state.records.delete(value);
          request.onsuccess?.(); tx.oncomplete?.();
        }, 0);
        return request;
      }]));
      return tx;
    }
  };
  const indexedDB = { open() {
    state.opens++; const request = {};
    setTimeout(() => {
      if (state.failOpen > 0) { state.failOpen--; request.error = new Error('temporary-open-failure'); request.onerror?.(); }
      else { request.result = db; request.onsuccess?.(); }
    }, 0);
    return request;
  } };
  const J = {};
  const context = {
    J, Blob, setTimeout, createImageBitmap: async () => ({ width: 4, height: 3, close() {} }),
    OffscreenCanvas: class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob(['jpeg'], { type: 'image/jpeg' }); } },
    URL: { createObjectURL(blob) { const url = 'blob:test-' + state.urls.size; state.urls.set(url, blob); return url; }, revokeObjectURL(url) { state.urls.delete(url); } }
  };
  if (!noIDB) context.indexedDB = indexedDB;
  vm.runInNewContext(source, context);
  J.photoNotify = message => state.notifications.push(message);
  const add = async () => (await J.photo.addFiles([{ type: 'image/png', name: 'photo.png' }]))[0];
  const seed = id => state.records.set(id, { id, blob: new Blob(['photo']), thumb: new Blob(['thumb']), w: 4, h: 3 });
  return { photo: J.photo, state, add, seed, db };
}
const ids = result => Array.from(result.ids);

test('failed B write falls back per record while previously persisted A stays readable', async () => {
  const { photo, state, add } = setup();
  const a = await add(); assert.ok(state.records.has(a));
  state.failPut = true;
  const b = await add(); assert.ok(b); assert.ok(!state.records.has(b));
  const result = await photo.filterExisting([a, b]);
  assert.deepEqual(ids(result), [a, b]); assert.equal(result.missing, 0); assert.equal(result.unavailable, 0);
  assert.ok(await photo.thumbURL(a)); assert.ok(await photo.thumbURL(b));
  assert.equal(state.notifications.length, 1);
  state.failPut = false;
  const c = await add(); assert.ok(state.records.has(c), 'future writes retry persistent storage');
});

test('persistent and memory-only records can both be removed after write fallback', async () => {
  const { photo, state, add } = setup();
  const a = await add(); state.failPut = true; const b = await add();
  await photo.thumbURL(a); await photo.thumbURL(b);
  await photo.remove(a); assert.ok(!state.records.has(a));
  await photo.remove(b);
  assert.equal(state.urls.size, 0);
  const result = await photo.filterExisting([a, b]);
  assert.deepEqual(ids(result), []); assert.equal(result.missing, 2);
  assert.ok(state.transactions.some(tx => tx.operation === 'delete' && tx.value === a));
});

for (const failure of ['request-error', 'abort-after-success', true]) {
  test(`transient read ${failure} preserves photo references and retries`, async () => {
    const { photo, state, seed } = setup(); seed('A'); state.failGet = failure;
    const result = await photo.filterExisting(['A', 'unknown']);
    assert.deepEqual(ids(result), ['A', 'unknown']); assert.equal(result.missing, 0); assert.equal(result.unavailable, 2);
    assert.equal(await photo.thumbURL('A'), null);
    state.failGet = null;
    const retry = await photo.filterExisting(['A', 'unknown']);
    assert.deepEqual(ids(retry), ['A']); assert.equal(retry.missing, 1); assert.equal(retry.unavailable, 0);
    assert.ok(await photo.thumbURL('A'), 'thumbnail failure was not cached as absence');
  });
}

test('failed persistent delete rejects and keeps record and cached thumbnail for retry', async () => {
  const { photo, state, seed } = setup(); seed('A');
  const url = await photo.thumbURL('A'); state.failDelete = true;
  await assert.rejects(photo.remove('A'), /delete-failed/);
  assert.ok(state.records.has('A')); assert.ok(state.urls.has(url));
  assert.deepEqual(ids(await photo.filterExisting(['A'])), ['A']);
  state.failDelete = false; await photo.remove('A');
  assert.ok(!state.records.has('A')); assert.ok(!state.urls.has(url));
});

test('failed database open is retried instead of cached permanently', async () => {
  const { photo, state, seed } = setup(); seed('A'); state.failOpen = 1;
  const first = await photo.filterExisting(['A']);
  assert.deepEqual(ids(first), ['A']); assert.equal(first.unavailable, 1);
  const retry = await photo.filterExisting(['A']);
  assert.deepEqual(ids(retry), ['A']); assert.equal(retry.unavailable, 0); assert.equal(state.opens, 2);
});

test('version change closes old connection and the next read reopens', async () => {
  const { photo, state, seed, db } = setup(); seed('A');
  await photo.filterExisting(['A']); db.onversionchange();
  assert.equal(state.closes, 1);
  assert.deepEqual(ids(await photo.filterExisting(['A'])), ['A']); assert.equal(state.opens, 2);
});

test('without IndexedDB, new memory photos work and unavailable old photos are retained', async () => {
  const { photo, add } = setup({ noIDB: true }); const b = await add();
  assert.ok(await photo.thumbURL(b));
  const result = await photo.filterExisting(['old-photo', b]);
  assert.deepEqual(ids(result), ['old-photo', b]); assert.equal(result.missing, 0); assert.equal(result.unavailable, 1);
  await photo.remove(b); // memory-only deletion must not require IndexedDB
  assert.equal(await photo.thumbURL(b), null);
  await assert.rejects(photo.remove('old-photo'), /no-idb/);
});
