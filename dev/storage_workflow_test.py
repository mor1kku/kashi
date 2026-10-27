"""Browser regressions for recoverable storage failures (KAS03/KAS04).

Build first with python3 build.py, then serve the repository on port 8765.
Run: python3 dev/storage_workflow_test.py
Requires Playwright and Chromium; JIZURA_TEST_URL / CHROMIUM_PATH override defaults.
"""
import asyncio
import json
import os
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright, expect

URL = os.environ.get('JIZURA_TEST_URL', 'http://127.0.0.1:8765')
PRIMARY = 'jizura.project.v1'
RECOVERY = PRIMARY + '.recovery'


async def fresh_context(browser):
    context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    await context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
    await context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
    return context


async def stored(page):
    return await page.evaluate('''keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)]))''', [PRIMARY, RECOVERY])


async def photo_failure_test(browser):
    context = await fresh_context(browser)
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(URL, wait_until='domcontentloaded')
    await expect(page.locator('#lyrics')).to_be_visible()
    result = await page.evaluate('''async () => {
      const image = async color => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 24, 24);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return new File([blob], color + '.png', {type: 'image/png'});
      };
      const [a] = await J.photo.addFiles([await image('red')]);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('jizura', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const persisted = await new Promise((resolve, reject) => {
        const request = db.transaction('photos', 'readonly').objectStore('photos').get(a);
        request.onsuccess = () => resolve(!!request.result); request.onerror = () => reject(request.error);
      });
      db.close();
      const put = IDBObjectStore.prototype.put;
      let b;
      try {
        IDBObjectStore.prototype.put = function () { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
        [b] = await J.photo.addFiles([await image('blue')]);
      } finally { IDBObjectStore.prototype.put = put; }
      const readable = [];
      for (const id of [a, b]) {
        const url = await J.photo.thumbURL(id);
        if (!url) { readable.push(false); continue; }
        const blob = await (await fetch(url)).blob();
        const bitmap = await createImageBitmap(blob);
        readable.push(bitmap.width > 0 && bitmap.height > 0); bitmap.close();
      }
      const filtered = await J.photo.filterExisting([a, b]);
      // Reload with only the persistent ID: a temporary read failure must not
      // turn an inaccessible photo into a proven missing photo.
      J.ui.project.photo.ids = [a];
      localStorage.setItem('jizura.project.v1', JSON.stringify(J.ui.project));
      return {a, b, persisted, readable, filtered};
    }''')
    assert result['a'] and result['b'] and result['a'] != result['b'], result
    assert result['persisted'] and result['readable'] == [True, True], result
    assert result['filtered']['ids'] == [result['a'], result['b']], result
    assert result['filtered']['missing'] == 0, result
    await page.add_init_script('''
      window.originalPhotoTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
        if (mode === 'readonly') throw new DOMException('Injected transient read failure', 'UnknownError');
        return window.originalPhotoTransaction.call(this, store, mode, ...rest);
      };
    ''')
    await page.reload(wait_until='domcontentloaded')
    await expect(page.locator('#lyrics')).to_be_visible()
    await page.wait_for_timeout(1100)
    assert await page.evaluate('J.ui.project.photo.ids') == [result['a']]
    assert json.loads((await stored(page))[PRIMARY])['photo']['ids'] == [result['a']]
    recovered = await page.evaluate('''async id => {
      IDBDatabase.prototype.transaction = window.originalPhotoTransaction;
      return J.photo.filterExisting([id]);
    }''', result['a'])
    assert recovered['ids'] == [result['a']] and recovered['missing'] == 0, recovered
    assert not errors, errors
    print('PASS KAS03: failed new photo write preserves old IndexedDB photo and new memory photo; transient read preserves project references')
    await context.close()


async def corrupt_project_test(browser, recovery):
    context = await fresh_context(browser)
    originals = {PRIMARY: '{"lyrics":"unfinished', RECOVERY: recovery}
    await context.add_init_script('''(() => {
      const records = %s;
      for (const [key, raw] of Object.entries(records)) {
        if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw);
      }
    })();''' % json.dumps(originals))
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(URL, wait_until='domcontentloaded')
    await expect(page.locator('#storageWarning')).to_be_visible()
    await expect(page.locator('#storageBackupLink')).to_be_visible()
    await page.wait_for_timeout(1100)
    assert await stored(page) == originals, 'startup autosave overwrote original corrupt data'
    await page.locator('#lyrics').fill('Uncommitted recovery edit')
    await page.wait_for_timeout(900)
    await page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    assert await stored(page) == originals, 'autosave or pagehide overwrote original corrupt data'

    # Exercise the real export/recovery entry point; image encoding is unrelated
    # to storage, so return a small generated blob at that boundary.
    await page.evaluate("J.exportPNGZip = async () => new Blob(['test zip'], {type: 'application/zip'})")
    await page.locator('#modePro').click()
    await page.locator('[data-tab="out"]').click()
    await page.locator('#btnPNG').click()
    await expect(page.locator('#downloadResult')).to_be_visible(timeout=15000)
    assert await stored(page) == originals, 'export recovery overwrote original corrupt data'
    await expect(page.locator('#storageWarning')).to_be_visible()

    async with page.expect_download() as download_info:
        await page.locator('#storageBackupLink').click()
    download = await download_info.value
    assert await download.failure() is None
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'originals.json'
        await download.save_as(str(output))
        backup = json.loads(output.read_text())
    records = {record['key']: record['raw'] for record in backup['records']}
    for key, raw in originals.items():
        if raw is not None:
            assert records.get(key) == raw, (records, originals)

    await expect(page.locator('#storageResume')).to_be_enabled()
    await page.evaluate('''() => {
      window.originalStorageSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('jizura.project.v1.quarantine.')) throw new DOMException('Injected archive quota failure', 'QuotaExceededError');
        return window.originalStorageSetItem.call(this, key, value);
      };
    }''')
    await page.locator('#storageResume').click()
    await expect(page.locator('#storageWarning')).to_be_visible()
    assert await stored(page) == originals, 'failed quarantine must prevent replacement'
    await page.evaluate('() => { Storage.prototype.setItem = window.originalStorageSetItem; }')
    # An explicit acknowledgement is the only point where replacing keys is allowed.
    await page.locator('#storageResume').click()
    await expect(page.locator('#storageWarning')).to_be_hidden()
    assert json.loads((await stored(page))[PRIMARY])['lyrics'] == 'Uncommitted recovery edit'
    quarantine = await page.evaluate('''() => Object.keys(localStorage)
      .filter(k => k.startsWith('jizura.project.v1.quarantine.')).map(k => JSON.parse(localStorage.getItem(k)))''')
    assert quarantine, 'explicit replacement must archive original records first'
    archived = {record['key']: record['raw'] for bundle in quarantine for record in bundle['records']}
    for key, raw in originals.items():
        if raw is not None:
            assert archived.get(key) == raw, (archived, originals)
    assert not errors, errors
    print('PASS KAS04: corrupt %s preserved through boot, autosave, pagehide and export; raw backup and explicit archived replacement' % ('primary and recovery' if recovery else 'primary without recovery'))
    await context.close()


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        try:
            await photo_failure_test(browser)
            await corrupt_project_test(browser, None)
            await corrupt_project_test(browser, '[broken recovery')
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
