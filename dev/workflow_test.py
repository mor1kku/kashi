"""Full browser workflow regression. Build first, serve the repository on port 8765.
Run: python3 dev/workflow_test.py
Requires Playwright and Chromium (CHROMIUM_PATH overrides /usr/bin/chromium).
"""
import asyncio
import io
import json
import math
import os
import struct
import tempfile
import wave
import zipfile
from pathlib import Path
from playwright.async_api import async_playwright, expect

URL = os.environ.get('JIZURA_TEST_URL', 'http://127.0.0.1:8765')


def wav_bytes(duration=4):
    # Audible pulses: real decoding/beat analysis, no external asset.
    sample_rate = 16000
    samples = bytearray()
    for i in range(sample_rate * duration):
        t = i / sample_rate
        amplitude = 0.65 if t % 0.5 < 0.12 else 0.12
        samples.extend(struct.pack('<h', int(32767 * amplitude * math.sin(2 * math.pi * 440 * t))))
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples)
    return output.getvalue()


async def starts(page):
    return await page.locator('#lineList .time').evaluate_all('(els) => els.map(e => Number(e.value))')


async def change_number(page, selector, value):
    control = page.locator(selector)
    await control.fill(str(value))
    await control.dispatch_event('change')


async def saved_project(page):
    return await page.evaluate("JSON.parse(localStorage.getItem('jizura.project.v1'))")


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        # External fonts are optional and make an offline test nondeterministic.
        await context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        await context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(URL, wait_until='domcontentloaded')
        await expect(page.locator('#lyrics')).to_be_visible()
        await page.locator('#lyrics').fill('one\ntwo\nthree')
        await expect(page.locator('#lineList .time')).to_have_count(3)
        upload = {'name': 'pulses.wav', 'mimeType': 'audio/wav', 'buffer': wav_bytes()}
        await page.locator('#audioFile').set_input_files(upload)
        await expect(page.locator('#btnAutoTiming')).to_be_enabled()
        await expect(page.locator('#timingStatus')).to_contain_text('仮配置しました')
        initial = await starts(page)
        assert len(initial) == 3 and all(a < b for a, b in zip(initial, initial[1:])), initial
        assert initial[0] >= 0 and initial[-1] < 4, initial
        await change_number(page, '#autoStart', 0.2)
        await change_number(page, '#autoEnd', 3.8)
        await page.locator('#btnAutoTiming').click()
        draft = await starts(page)
        assert draft[0] >= 0.2 and draft[-1] < 3.8, draft
        numeric = round((draft[0] + draft[2]) / 2, 2)
        await change_number(page, '#lineList li:nth-child(2) .time', numeric)
        assert (await starts(page))[1] == numeric
        await page.locator('#lineList li:nth-child(2) .later').click()
        assert abs((await starts(page))[1] - (numeric + 0.1)) < 0.011
        await page.locator('#btnUndoTiming').click()
        assert (await starts(page))[1] == numeric
        # Scrub through the real transport and place the final lyric at that time.
        await page.locator('#scrub').fill('8750')
        await page.locator('#scrub').dispatch_event('change')
        await page.locator('#lineList li:nth-child(3) .set-now').click()
        assert abs((await starts(page))[2] - 3.5) < 0.011
        before_realign = await starts(page)
        await page.locator('#btnAutoTiming').click()
        realigned = await starts(page)
        assert realigned[1:] == before_realign[1:], (before_realign, realigned)
        await page.wait_for_timeout(900)
        persisted = await saved_project(page)
        assert persisted['timing']['lineTimes']['1'] == numeric
        assert persisted['timing']['lineTimes']['2'] == 3.5
        assert len(persisted['timing']['autoTimes']) == 3
        await page.reload(wait_until='domcontentloaded')
        await expect(page.locator('#lineList .time')).to_have_count(3)
        assert await starts(page) == realigned
        await page.locator('#audioFile').set_input_files(upload)
        await expect(page.locator('#timingStatus')).to_contain_text('保存済みのタイミングを保持')
        assert await starts(page) == realigned
        print('PASS: WAV analysis, auto placement, numeric/+0.1/undo/current-position corrections, reallocation anchors, reload persistence')

        # Seven seconds crosses the five-second audio resampling window boundary.
        await page.locator('#audioFile').set_input_files({'name': 'long-pulses.wav', 'mimeType': 'audio/wav', 'buffer': wav_bytes(7)})
        await expect(page.locator('#audioName')).to_contain_text('long-pulses.wav')
        await expect(page.locator('#timingStatus')).to_contain_text('保存済みのタイミングを保持')
        downloads = []
        page.on('download', lambda download: downloads.append(download))
        await page.locator('#modePro').click()
        await page.locator('[data-tab="out"]').click()
        await page.locator('#outRes').select_option('720')
        await page.locator('#outFps').select_option('24')
        await page.locator('#outQuality').select_option('standard')
        await expect(page.locator('#btnMP4')).to_be_enabled(timeout=15000)
        # Export must snapshot even an edit whose debounced autosave has not run.
        await page.locator('#songArtist').fill('Recovery Test')
        await page.locator('#btnMP4').click()
        await expect(page.locator('#recoveryLink')).to_be_visible()
        recovery = await page.evaluate("JSON.parse(localStorage.getItem('jizura.project.v1.recovery'))")
        assert recovery['artist'] == 'Recovery Test'
        assert recovery['timing']['lineTimes']['2'] == 3.5
        await expect(page.locator('#downloadResult')).to_be_visible(timeout=120000)
        await expect(page.locator('#downloadLink')).to_have_attribute('download', 'jizura.mp4')
        assert not downloads, 'Export completion must wait for an explicit save click'
        mp4_url = await page.locator('#downloadLink').get_attribute('href')
        metadata = await page.evaluate('''url => new Promise((resolve, reject) => {
          const video = document.createElement('video');
          video.onloadedmetadata = () => resolve({duration: video.duration, width: video.videoWidth, height: video.videoHeight});
          video.onerror = () => reject(new Error('Exported MP4 could not be decoded'));
          video.src = url;
        })''', mp4_url)
        assert abs(metadata['duration'] - 7) < 0.1, metadata
        assert (metadata['width'], metadata['height']) == (1280, 720), metadata
        async with page.expect_download() as download_info:
            await page.locator('#downloadLink').click()
        download = await download_info.value
        assert await download.failure() is None
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'test.mp4'
            await download.save_as(str(output))
            data = output.read_bytes()
            assert len(data) > 1000 and data[4:8] == b'ftyp', data[:24]
            assert b'moov' in data and b'mdat' in data and b'soun' in data and b'vide' in data
            print(f'PASS: real MP4 with audio across resampling windows, playable metadata, and explicit download ({len(data)} bytes)')
        async with page.expect_download() as download_info:
            await page.locator('#downloadLink').click()
        assert await (await download_info.value).failure() is None
        assert await page.locator('#downloadLink').get_attribute('href') == mp4_url
        print('PASS: completed MP4 can be downloaded again without re-encoding')

        await page.locator('#btnPNG').click()
        await expect(page.locator('#downloadLink')).to_have_attribute('download', 'jizura_png.zip', timeout=120000)
        async with page.expect_download() as download_info:
            await page.locator('#downloadLink').click()
        download = await download_info.value
        assert await download.failure() is None
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'test.zip'
            await download.save_as(str(output))
            with zipfile.ZipFile(output) as archive:
                files = archive.namelist()
                assert len(files) == 168, len(files)
                assert archive.testzip() is None
                assert archive.read(files[0]).startswith(b'\x89PNG\r\n\x1a\n')
                print(f'PASS: actual PNG ZIP explicit download ({len(files)} frames)')
        async with page.expect_download() as download_info:
            await page.locator('#recoveryLink').click()
        backup = await download_info.value
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'backup.json'
            await backup.save_as(str(output))
            saved = json.loads(output.read_text())
            assert saved['lyrics'] == 'one\ntwo\nthree'
            assert saved['artist'] == 'Recovery Test'
            assert saved['timing']['lineTimes']['2'] == 3.5
        # Apply corruption before the next document's app startup (pagehide saves
        # valid primary state, so setting it before page.reload would not test recovery).
        await page.add_init_script("if (sessionStorage.getItem('testCorruptPrimary')) { localStorage.setItem('jizura.project.v1', '{broken'); sessionStorage.removeItem('testCorruptPrimary'); }")
        await page.evaluate("sessionStorage.setItem('testCorruptPrimary', '1')")
        await page.reload(wait_until='domcontentloaded')
        await expect(page.locator('#lineList .time')).to_have_count(3)
        assert await starts(page) == realigned
        await expect(page.locator('#songArtist')).to_have_value('Recovery Test')
        print('PASS: export-time backup download and recovery after primary storage corruption')
        assert not errors, errors
        print('PASS: zero uncaught page errors')
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
