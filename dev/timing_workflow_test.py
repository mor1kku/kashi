"""Browser regression for timing correction controls.
Build and serve the repository first, then run: python3 dev/timing_workflow_test.py
Requires Playwright and Chromium; JIZURA_TEST_URL / CHROMIUM_PATH override defaults.
"""
import asyncio
import json
import os
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright, expect
from workflow_test import wav_bytes

URL = os.environ.get('JIZURA_TEST_URL', 'http://127.0.0.1:8765')


async def snapshot(page):
    return await page.evaluate('''() => ({
      timing: JSON.parse(JSON.stringify(J.ui.project.timing)),
      starts: J.ui.plan.lines.map(line => line.start),
      ends: J.ui.plan.lines.map(line => line.end),
      time: J.ui.t, playing: J.ui.playing,
      tap: J.ui.tap ? JSON.parse(JSON.stringify(J.ui.tap)) : null
    })''')


def close_list(actual, expected, tolerance=0.002):
    assert len(actual) == len(expected), (actual, expected)
    assert all(abs(a - b) <= tolerance for a, b in zip(actual, expected)), (actual, expected)


async def change_number(page, selector, value):
    await page.locator(selector).fill(str(value))
    await page.locator(selector).press('Tab')


async def load_fixture(page):
    project = await page.evaluate('''() => {
      const p = J.defaultProject();
      p.lyrics = '[00:01.00]朝の光\\n[00:03.00]君の声\\n[00:05.00]風に乗せて\\n[00:07.00]歌を届ける\\n[00:09.00]夜を越えて\\n[00:11.00]また会おう';
      Object.assign(p.timing, {autoStart:1,autoEnd:11.8,autoTimes:{0:1,1:3,2:5,3:7,4:9,5:11},lineTimes:{1:3.2}});
      return p;
    }''')
    await page.locator('#fileProject').set_input_files({'name':'timing-fixture.json','mimeType':'application/json','buffer':json.dumps(project, ensure_ascii=False).encode()})
    await expect(page.locator('#lineList .time')).to_have_count(6)
    await page.wait_for_function('J.ui.project.timing.autoStart === 1')
    return project


async def seek_song(page, seconds):
    duration = await page.evaluate('J.ui.plan.duration')
    await page.locator('#scrub').fill(str(round(seconds / duration * 10000)))
    await page.locator('#scrub').dispatch_event('change')
    await page.wait_for_timeout(40)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width':1500,'height':1100})
        await context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        await context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(URL, wait_until='domcontentloaded')
        await expect(page.locator('#lyrics')).to_be_visible()
        await load_fixture(page)
        await page.locator('#audioFile').set_input_files({'name':'timing-pulses.wav','mimeType':'audio/wav','buffer':wav_bytes(12)})
        await expect(page.locator('#audioName')).to_contain_text('timing-pulses.wav')
        await page.wait_for_function('J.ui.audio && J.ui.audio.duration === 12')
        original = await snapshot(page)
        close_list(original['starts'], [1,3.2,5,7,9,11])

        # Editing the singing range must immediately update the actual plan,
        # including existing manual corrections and imported LRC timestamps.
        await change_number(page, '#autoStart', 2)
        shifted = await snapshot(page)
        expected = [2 + (time - 1) * (11.8 - 2) / (11.8 - 1) for time in original['starts']]
        close_list(shifted['starts'], expected)
        assert shifted['timing']['autoStart'] == 2
        await page.locator('#btnUndoTiming').click()
        undone = await snapshot(page)
        close_list(undone['starts'], original['starts'])
        assert undone['timing'] == original['timing']
        await change_number(page, '#autoEnd', 10)
        shrunk = await snapshot(page)
        close_list(shrunk['starts'], [1 + (time - 1) * 9 / 10.8 for time in original['starts']])
        await page.locator('#btnUndoTiming').click()
        before_invalid = await snapshot(page)
        await change_number(page, '#autoStart', 20)
        rejected = await snapshot(page)
        assert rejected['timing'] == before_invalid['timing']
        close_list(rejected['starts'], before_invalid['starts'])
        await seek_song(page, 2.5)
        await page.locator('#btnAutoStart').click()
        assert abs((await snapshot(page))['starts'][0]-2.5) < 0.006
        await page.locator('#btnUndoTiming').click()
        await seek_song(page, 10)
        await page.locator('#btnAutoEnd').click()
        close_list((await snapshot(page))['starts'], [1+(time-1)*9/10.8 for time in original['starts']], tolerance=0.006)
        await page.locator('#btnUndoTiming').click()
        await page.locator('#modePro').click()
        await change_number(page, '#offset', 1.5)
        assert abs((await snapshot(page))['starts'][0]-1.5) < 0.006
        await page.locator('#btnUndoTiming').click()
        await page.locator('#modeEasy').click()
        print('PASS: immediate range edits, playback-range buttons, offset alias, manual/LRC updates, undo, invalid-range rollback', flush=True)

        await page.locator('#timingFrom').select_option('1')
        await page.locator('#timingTo').select_option('3')
        await change_number(page, '#timingShift', 0.25)
        await page.locator('#btnShiftTiming').click()
        bulk = await snapshot(page)
        close_list(bulk['starts'], [1,3.45,5.25,7.25,9,11])
        await page.locator('#btnUndoTiming').click()
        assert (await snapshot(page))['timing'] == original['timing']
        await seek_song(page, 4)
        await page.locator('#btnShiftNow').click()
        aligned = await snapshot(page)
        close_list(aligned['starts'], [1,4,5.8,7.8,9,11], tolerance=0.006)
        await page.locator('#btnUndoTiming').click()
        before_invalid = await snapshot(page)
        await change_number(page, '#timingShift', 20)
        await page.locator('#btnShiftTiming').click()
        assert (await snapshot(page))['timing'] == before_invalid['timing']
        print('PASS: selected-row bulk shift/current-position alignment, undo, invalid shift rollback', flush=True)

        # A fresh draft must be able to replace imported LRC and manual timings.
        await page.locator('#timingMode').select_option('replace')
        await page.locator('#timingSpacing').select_option('equal')
        await page.locator('#timingSnap').fill('0')
        await page.locator('#timingSnap').dispatch_event('change')
        before_fresh = await snapshot(page)
        await page.locator('#btnAutoTiming').click()
        fresh = await snapshot(page)
        assert not fresh['timing'].get('lineTimes'), fresh['timing']
        assert fresh['timing'].get('ignoreLrc') is True, fresh['timing']
        close_list(fresh['starts'], [1,2.8,4.6,6.4,8.2,10], tolerance=0.01)
        await page.locator('#btnUndoTiming').click()
        assert (await snapshot(page))['timing'] == before_fresh['timing']
        await page.locator('#timingMode').select_option('replace')
        await page.locator('#btnAutoTiming').click()
        fresh = await snapshot(page)
        await seek_song(page, 6)
        await page.locator('#lineList li:nth-child(3) .anchor-now').click()
        anchored = await snapshot(page)
        assert abs(anchored['starts'][2] - 6) < 0.006, anchored
        assert abs(anchored['timing']['lineTimes']['2'] - 6) < 0.006
        assert all(a < b for a,b in zip(anchored['starts'],anchored['starts'][1:]))
        await page.locator('#timingMode').select_option('keep')
        await page.locator('#btnAutoTiming').click()
        assert abs((await snapshot(page))['starts'][2] - 6) < 0.006
        await page.locator('#lineList li:nth-child(3) .release-time').click()
        released = await snapshot(page)
        assert '2' not in released['timing'].get('lineTimes', {}), released
        assert all(a < b for a,b in zip(released['starts'],released['starts'][1:]))
        print('PASS: fresh auto replaces LRC/manual timings, undo restores them; playback anchor/fill/release work', flush=True)

        # Preview speed changes must measure positions in song seconds, not wall time.
        await page.locator('#playbackRate').select_option('0.5')
        await seek_song(page, 2)
        await page.locator('#btnPlay').click()
        await page.wait_for_timeout(100)
        t0 = (await snapshot(page))['time']
        await page.wait_for_timeout(1000)
        t1 = (await snapshot(page))['time']
        assert 0.35 < t1-t0 < 0.8, (t0,t1)
        await page.locator('#playbackRate').select_option('1')
        changed = (await snapshot(page))['time']
        assert t1-0.05 <= changed < t1+0.5, (t1,changed)
        await page.wait_for_timeout(600)
        normal = (await snapshot(page))['time']
        assert 0.4 < normal-changed < 0.9, (changed,normal)
        await page.locator('#btnPlay').click()
        print('PASS: slow preview uses song time and changing speed preserves position', flush=True)

        await page.locator('#playbackRate').select_option('0.5')
        await page.locator('#timingFrom').select_option('2')
        prior_tap = await snapshot(page)
        await page.locator('#btnTap').click()
        tap = await snapshot(page)
        assert tap['tap']['i'] == 2, tap
        assert abs(tap['time'] - max(0,prior_tap['starts'][2]-1)) < 0.3, tap
        await page.wait_for_timeout(700)
        tapped_at = (await snapshot(page))['time']
        await page.locator('#tapBtn').click()
        await page.locator('#tapStop').click()
        tapped = await snapshot(page)
        assert tapped['tap'] is None
        close_list(tapped['starts'][:2], prior_tap['starts'][:2])
        assert abs(tapped['starts'][2]-tapped_at) < 0.25, (tapped_at,tapped)
        assert all(a < b for a,b in zip(tapped['starts'],tapped['starts'][1:]))
        print('PASS: tap starts at selected row with preroll, records slowed song time, and preserves preceding rows', flush=True)

        await page.wait_for_timeout(900)
        before_reload = await snapshot(page)
        async with page.expect_download() as download_info:
            await page.locator('#btnSave').click()
        download = await download_info.value
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'project.json'
            await download.save_as(str(output))
            saved = json.loads(output.read_text())
            assert saved['timing'] == before_reload['timing']
        await page.reload(wait_until='domcontentloaded')
        await expect(page.locator('#lineList .time')).to_have_count(6)
        restored = await snapshot(page)
        close_list(restored['starts'], before_reload['starts'])
        assert restored['timing'] == before_reload['timing']
        print('PASS: corrected timing survives project download and reload', flush=True)
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(150)
        layout = await page.evaluate('''() => ({width:innerWidth, body:document.body.scrollWidth, root:document.documentElement.scrollWidth,
          overflow:[...document.querySelectorAll('body *')].filter(el => {const r=el.getBoundingClientRect();return r.width && r.right > innerWidth+1;}).slice(0,12).map(el=>({tag:el.tagName,id:el.id,cls:el.className,right:el.getBoundingClientRect().right}))})''')
        assert layout['body'] <= layout['width'] and layout['root'] <= layout['width'], layout
        for selector in ['#autoStart','#autoEnd','#timingFrom','#timingTo','#timingSpacing','#timingMode','#timingShift','#btnShiftNow']:
            box = await page.locator(selector).bounding_box()
            assert box and box['x'] >= 0 and box['x']+box['width'] <= 391, (selector,box)
        print('PASS: 390px mobile viewport keeps timing controls within screen', flush=True)
        # Pasting new LRC timestamps is a new timing source, even after a fresh
        # automatic draft disabled the previous LRC and added manual anchors.
        await page.set_viewport_size({'width':1500,'height':1100})
        await page.locator('#lyrics').fill('[00:20.00]朝の光\n[00:30.00]君の声')
        await expect(page.locator('#lineList .time')).to_have_count(2)
        imported = await snapshot(page)
        close_list(imported['starts'], [20,30])
        assert imported['timing'].get('ignoreLrc') is False, imported
        assert imported['timing'].get('autoEnd') is None, imported
        await expect(page.locator('#autoStart')).to_have_value('20')
        await expect(page.locator('#autoEnd')).to_have_value('')
        print('PASS: new LRC timestamps replace stale ignored/manual times and clear stale visible range', flush=True)

        # Editing and clicking in the same browser task beats the replan debounce.
        # The selected old last row must clamp against the new parsed row count.
        await load_fixture(page)
        await page.locator('#timingFrom').select_option('5')
        await page.locator('#playbackRate').select_option('1')
        immediate = await page.evaluate('''() => {
          const input = document.getElementById('lyrics');
          input.value = 'new first\\nnew second';
          input.dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('btnTap').click();
          return {tap:J.ui.tap, count:J.ui.plan.lines.length};
        }''')
        assert immediate['count'] == 2 and immediate['tap']['i'] == 1, immediate
        await page.wait_for_timeout(1100)
        await page.locator('#tapBtn').click()
        after_race = await snapshot(page)
        assert after_race['tap'] is None and len(after_race['starts']) == 2, after_race
        assert '1' in after_race['timing']['lineTimes'], after_race
        assert after_race['starts'][1] > after_race['starts'][0]
        if after_race['playing']:
            await page.locator('#btnPlay').click()
        print('PASS: immediate tap after deleting rows clamps selection and commits the remaining row', flush=True)
        assert not errors, errors
        print('PASS: zero uncaught page errors', flush=True)
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
