// Run: node dev/project_storage_test.js. Test actual storage handlers with a fault-injectable store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/12_ui.js'), 'utf8');
const begin = source.indexOf('const storageState =');
const end = source.indexOf('let recoveryDownload =', begin);
assert.ok(begin >= 0 && end > begin);
const LS = 'jizura.project.v1', RECOVERY = LS + '.recovery';
const valid = lyrics => JSON.stringify({ lyrics, timing: { lineTimes: { 0: 3 } } });

function setup(initial = {}) {
  const entries = new Map(Object.entries(initial)), writes = [], timers = new Map(), elements = {}, downloads = [];
  const faults = { read: () => false, write: () => false, afterWrite: () => {} };
  const context = {
    LS_KEY: LS, RECOVERY_KEY: RECOVERY, Blob, Date, Math,
    S: { project: { lyrics: 'current edit' } },
    J: { prepareDownload(filename, blob) { const d = { filename, blob, url: 'blob:test', dispose() {} }; downloads.push(d); return d; } },
    mergeProject: p => Object.assign({ lyrics: 'default draft' }, p || {}),
    $: id => elements[id] ||= { hidden: true, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } },
    localStorage: {
      getItem(key) { if (faults.read(key)) throw new Error('read denied'); return entries.has(key) ? entries.get(key) : null; },
      setItem(key, value) {
        if (faults.write(key)) throw new Error('write denied');
        writes.push([key, value]); entries.set(key, value); faults.afterWrite(key, value);
      },
    },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(begin, end), context);
  context.bindStorageWarning();
  return { context, entries, writes, timers, elements, downloads, faults,
    boot() { context.S.project = context.loadLocal(); return context.S.project; },
    blocked() { return vm.runInContext('storageState.blocked', context); },
  };
}
function assertProtected(h, originals) {
  assert.equal(h.blocked(), true);
  assert.equal(h.elements.storageWarning.hidden, false);
  h.context.autosave();
  assert.equal(h.context.saveNow(), false); // pagehide/visibilitychange route
  assert.equal(h.context.saveNow(true), false); // export recovery route
  for (const fn of h.timers.values()) fn();
  for (const [key, raw] of Object.entries(originals)) assert.equal(h.entries.get(key), raw);
  assert.equal(h.writes.length, 0);
}

(async () => {
  const broken = '{broken: "元データ"\n\u0000';
  let h = setup({ [LS]: broken });
  assert.equal(h.boot().lyrics, 'default draft');
  assertProtected(h, { [LS]: broken });
  let bundle = JSON.parse(await h.downloads.at(-1).blob.text());
  assert.equal(bundle.records[0].raw, broken);
  assert.equal(bundle.records[1].raw, null);

  h = setup({ [LS]: broken, [RECOVERY]: '[invalid recovery' });
  h.boot(); assertProtected(h, { [LS]: broken, [RECOVERY]: '[invalid recovery' });
  bundle = JSON.parse(await h.downloads.at(-1).blob.text());
  assert.equal(bundle.records[1].raw, '[invalid recovery');

  h = setup({ [LS]: broken, [RECOVERY]: valid('recovered lyrics') });
  assert.equal(h.boot().lyrics, 'recovered lyrics');
  assertProtected(h, { [LS]: broken, [RECOVERY]: valid('recovered lyrics') });

  h = setup({ [LS]: valid('primary lyrics'), [RECOVERY]: broken });
  assert.equal(h.boot().lyrics, 'primary lyrics');
  assertProtected(h, { [LS]: valid('primary lyrics'), [RECOVERY]: broken });

  for (const raw of ['', 'null', '[]', '{"lyrics":"x","photo":{"ids":"bad"}}', '{"lyrics":"x","timing":[]}']) {
    h = setup({ [LS]: raw }); h.boot(); assertProtected(h, { [LS]: raw });
  }

  // A read denial never grants permission to replace unread data with a default draft.
  h = setup({ [LS]: valid('unread original') });
  h.faults.read = key => key === LS;
  h.boot(); assert.equal(h.blocked(), true); assert.equal(h.elements.storageResume.disabled, true);
  assert.equal(h.context.resumeStorage(), false); assert.equal(h.writes.length, 0);
  h.faults.read = () => false;
  h.elements.storageRetry.listeners.click();
  assert.equal(h.blocked(), true); assert.equal(h.elements.storageResume.disabled, false);
  assert.equal(h.entries.get(LS), valid('unread original'));

  // Quarantine failure or failed readback must leave the original slots untouched.
  h = setup({ [LS]: broken }); h.boot();
  h.faults.write = key => key.includes('.quarantine.');
  assert.equal(h.context.resumeStorage(), false); assertProtected(h, { [LS]: broken });
  h = setup({ [LS]: broken }); h.boot();
  h.faults.read = key => key.includes('.quarantine.');
  assert.equal(h.context.resumeStorage(), false);
  assert.equal(h.entries.get(LS), broken); assert.equal(h.blocked(), true);
  assert.ok(h.writes.every(([key]) => key.includes('.quarantine.')));

  // A different tab changing originals requires renewed review, before and during backup.
  h = setup({ [LS]: broken }); h.boot(); h.entries.set(LS, valid('other tab'));
  assert.equal(h.context.resumeStorage(), false); assert.equal(h.writes.length, 0);
  assert.equal(h.entries.get(LS), valid('other tab'));
  h = setup({ [LS]: broken }); h.boot();
  h.faults.afterWrite = key => { if (key.includes('.quarantine.')) h.entries.set(LS, valid('concurrent edit')); };
  assert.equal(h.context.resumeStorage(), false); assert.equal(h.entries.get(LS), valid('concurrent edit'));
  assert.ok(h.writes.every(([key]) => key.includes('.quarantine.')));

  // Only the explicit resume action archives originals and replaces both project slots.
  h = setup({ [LS]: broken, [RECOVERY]: valid('recovered') }); h.boot();
  h.context.S.project = { lyrics: 'user approved draft' };
  assert.equal(h.context.resumeStorage(), true);
  assert.equal(h.blocked(), false); assert.equal(h.elements.storageWarning.hidden, true);
  assert.ok(h.writes[0][0].includes('.quarantine.'));
  const archived = JSON.parse(h.writes[0][1]);
  assert.equal(archived.records[0].raw, broken);
  assert.equal(archived.records[1].raw, valid('recovered'));
  assert.equal(JSON.parse(h.entries.get(LS)).lyrics, 'user approved draft');
  assert.equal(h.entries.get(LS), h.entries.get(RECOVERY));
  assert.equal(h.context.saveNow(), true);

  // A write failure after quarantine retains protection and a persistent visible message.
  h = setup({ [LS]: broken }); h.boot(); h.faults.write = key => key === LS;
  assert.equal(h.context.resumeStorage(), false);
  assert.equal(h.entries.get(LS), broken); assert.equal(h.blocked(), true);
  assert.match(h.elements.storageWarningText.textContent, /保存に失敗/);

  // Normal save failures remain visible, and a successful retry clears the warning.
  h = setup({ [LS]: valid('healthy') }); h.boot();
  h.faults.write = () => true;
  assert.equal(h.context.saveNow(), false); assert.equal(h.elements.storageWarning.hidden, false);
  h.faults.write = () => false;
  h.elements.storageRetry.listeners.click();
  assert.equal(h.elements.storageWarning.hidden, true);

  h = setup(); h.boot(); assert.equal(h.context.saveNow(), true);
  console.log('project_storage_test: corrupt bytes, fallback, read failures, explicit quarantine, races and write failures passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
