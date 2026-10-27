"""Real browser regression: portable audio, reload recovery, and audible MP4.
Build and serve on :8765, then run this file. Requires Playwright, Chromium, ffmpeg.
KASHI_AUDIO_PROJECT optionally validates a production portable project (kept private).
"""
import asyncio
import base64
import json
import math
import os
import struct
import subprocess
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright, expect
from workflow_test import wav_bytes

URL = os.environ.get('JIZURA_TEST_URL', 'http://127.0.0.1:8765')

async def context_for(browser):
    context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    await context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
    await context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
    return context

async def idle(page):
    await page.wait_for_function('window.J?.ui?.project && !J.ui.audioBusy')

async def upload_project(page, project):
    await page.locator('#fileProject').set_input_files({'name': 'audio-project.json', 'mimeType': 'application/json', 'buffer': json.dumps(project).encode()})
    await idle(page)

async def download_json(page):
    async with page.expect_download() as info:
        await page.locator('#btnSave').click()
    download = await info.value
    assert await download.failure() is None
    return json.loads(Path(await download.path()).read_text())

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        ctx = await context_for(browser)
        page = await ctx.new_page(); errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until='domcontentloaded')
        await page.locator('#lyrics').fill('one\ntwo\nthree')
        await expect(page.locator('#eMP4')).to_be_enabled()
        await page.locator('#eMP4').click()
        await expect(page.locator('#audioStatus')).to_contain_text('書き出しを止めました')
        assert await page.evaluate('J.ui.exporting === null')
        assert await page.locator('#downloadResult').is_hidden()
        source = wav_bytes(7)
        await page.locator('#audioFile').set_input_files({'name':'audible.wav','mimeType':'audio/wav','buffer':source})
        await idle(page)
        await expect(page.locator('#audioStatus')).to_contain_text('読み込み済み')
        portable = await download_json(page)
        assert base64.b64decode(portable['audioData']) == source
        assert portable['audioAsset']['size'] == len(source)
        assert await page.evaluate("!('audioData' in J.ui.project) && !localStorage.getItem('jizura.project.v1').includes('audioData')")
        timing = portable['timing']
        await page.reload(wait_until='domcontentloaded'); await idle(page)
        assert await page.evaluate('J.ui.audio?.duration') == 7
        assert await page.evaluate('J.ui.project.timing') == timing
        print('PASS: missing audio blocks export; Save embeds exact source bytes; reload restores audio without bloating localStorage')

        # A new browser context has no IndexedDB song: JSON alone must suffice.
        fresh = await context_for(browser)
        second = await fresh.new_page(); second.on('pageerror', lambda e: errors.append(str(e)))
        await second.goto(URL, wait_until='domcontentloaded')
        await upload_project(second, portable)
        assert await second.evaluate('J.ui.audio?.duration') == 7
        assert await second.evaluate('J.ui.project.timing') == timing
        assert await second.evaluate('J.ui.audio.buffer.getChannelData(0).some(x=>Math.abs(x)>.05)')
        await second.locator('#btnPlay').click()
        await second.wait_for_timeout(150)
        assert await second.evaluate('J.ui.playing && J.ui.t > 0')
        await second.locator('#btnPlay').click()
        corrupt = dict(portable, audioData='broken')
        await upload_project(second, corrupt)
        await expect(second.locator('#audioStatus')).to_contain_text('以前の曲と編集内容は保持')
        assert await second.evaluate('J.ui.audio?.duration') == 7
        assert await second.evaluate('J.ui.project.timing') == timing
        print('PASS: portable JSON alone restores decoded sound and timing in a fresh browser; corrupt import preserves current edits and audio')

        await second.locator('#modePro').click()
        await second.locator('[data-tab="out"]').click()
        await second.locator('#outRes').select_option('720')
        await second.locator('#outFps').select_option('24')
        await second.locator('#outQuality').select_option('standard')
        await expect(second.locator('#btnMP4')).to_be_enabled()
        await second.locator('#btnMP4').click()
        await expect(second.locator('#downloadResult')).to_be_visible(timeout=120000)
        backup = await second.evaluate("async()=>JSON.parse(await (await fetch(document.getElementById('recoveryLink').href)).text())")
        assert base64.b64decode(backup['audioData']) == source
        async with second.expect_download() as info:
            await second.locator('#downloadLink').click()
        download = await info.value
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'audio.mp4'
            await download.save_as(str(output))
            metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))
            assert any(s['codec_type']=='audio' for s in metadata['streams'])
            if any(s.get('codec_name')=='opus' for s in metadata['streams']):
                await expect(second.locator('#downloadAudioNote')).to_contain_text('一部のスマホ')
            print('MP4 audio codec:', [s['codec_name'] for s in metadata['streams'] if s['codec_type']=='audio'], flush=True)
            for start in ['0.5','5.5']:
                raw=subprocess.check_output(['ffmpeg','-v','error','-ss',start,'-i',str(output),'-t','1','-vn','-ac','1','-ar','8000','-f','f32le','pipe:1'])
                samples=struct.unpack('<'+'f'*(len(raw)//4),raw)
                rms=math.sqrt(sum(x*x for x in samples)/len(samples))
                assert rms > .03, (start,rms)
        print('PASS: JSON-only import exports downloadable MP4 with non-silent decoded audio before and after the 5s resampling boundary; recovery JSON also includes source')

        # Abort after a successful put request: a failed new write must not poison
        # an older song, and the current in-memory source must still be portable.
        await page.evaluate('''() => {
          window.oldAudioMeta = {...J.ui.project.audioAsset};
          window.originalPut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(...args) {
            const req = window.originalPut.apply(this,args);
            if (this.name==='files') req.addEventListener('success',()=>this.transaction.abort());
            return req;
          };
        }''')
        other = wav_bytes(4)
        await page.locator('#audioFile').set_input_files({'name':'quota.wav','mimeType':'audio/wav','buffer':other})
        await idle(page)
        await expect(page.locator('#audioStatus')).to_contain_text('保存できませんでした')
        await page.evaluate('() => { IDBObjectStore.prototype.put = window.originalPut; }')
        assert await page.evaluate('(async()=> (await J.projectAudio.read(window.oldAudioMeta)).size)()') == len(source)
        assert base64.b64decode((await download_json(page))['audioData']) == other
        print('PASS: aborted audio save retains older stored songs and permits portable save of the current source')

        production = os.environ.get('KASHI_AUDIO_PROJECT')
        if production:
            third = await fresh.new_page()
            await third.goto(URL,wait_until='domcontentloaded')
            await third.locator('#fileProject').set_input_files(production)
            await idle(third)
            original=json.loads(Path(production).read_text())
            report=await third.evaluate('''() => ({duration:J.ui.audio?.duration,lines:J.ui.plan.lines.map(l=>({start:l.start,end:l.end})),rms:Math.sqrt(J.ui.audio.buffer.getChannelData(0).slice(48000*12,48000*13).reduce((s,x)=>s+x*x,0)/48000),embeddedInState:'audioData' in J.ui.project})''')
            assert report['duration'] > 224 and report['rms'] > .005, report
            assert len(report['lines']) == 28 and not report['embeddedInState']
            for i,line in enumerate(report['lines']):
                assert abs(line['start']-original['timing']['lineTimes'][str(i)]) < .001
                assert abs(line['end']-original['timing']['lineEnds'][str(i)]) < .001
            print('PASS: production song JSON restores 224s sound and all28 timing pairs without a separate MP3 upload')
        assert not errors,errors
        await browser.close()
        print('PASS: zero page errors')

if __name__=='__main__': asyncio.run(main())
