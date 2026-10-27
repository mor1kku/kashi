"""Browser regressions for explicit lyric ends and line/group duration controls.
Build and serve the repository, then run: python3 dev/duration_workflow_test.py
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
STARTS = [1, 7, 12, 17]
ENDS = [6, 10, 15, 19]


async def snapshot(page):
    return await page.evaluate('''() => ({
      timing: JSON.parse(JSON.stringify(J.ui.project.timing)),
      starts: J.ui.plan.lines.map(line=>line.start), ends:J.ui.plan.lines.map(line=>line.end),
      visibleEnds:J.ui.plan.lines.map(line=>line.visEnd),
      audioDuration:J.ui.audio?.duration, previewRate:J.ui.previewRate,
      cuts:J.ui.plan.cuts.map(c=>({line:c.line,layout:c.layout,start:c.start,end:c.end}))
    })''')


def close(actual, expected, tolerance=0.003):
    assert len(actual) == len(expected), (actual,expected)
    assert all(abs(a-b) <= tolerance for a,b in zip(actual,expected)), (actual,expected)


async def change(page, selector, value):
    await page.locator(selector).fill(str(value))
    await page.locator(selector).press('Tab')


async def load_fixture(page):
    project = await page.evaluate('''() => {
      const p = J.defaultProject(); p.lyrics='朝\\n昼\\n夕\\n夜';
      Object.assign(p.timing,{bpm:120,autoStart:1,autoEnd:19,lineTimes:{0:1,1:7,2:12,3:17},autoTimes:{0:1,1:7,2:12,3:17},lineEnds:{0:6,1:10,2:15,3:19}});
      p.overrides=Object.fromEntries([0,1,2,3].map(i=>[i,{single:true,layout:'center',enter:'cut',exit:'cut',hold:'still',decor:[],treat:'none',bg:'none'}]));
      return p;
    }''')
    await page.locator('#fileProject').set_input_files({'name':'duration-fixture.json','mimeType':'application/json','buffer':json.dumps(project,ensure_ascii=False).encode()})
    await expect(page.locator('#lineList .line-end')).to_have_count(4)
    await page.wait_for_function('J.ui.project.timing.lineEnds?.[0] === 6')
    return await snapshot(page)


async def undo(page, before):
    await page.locator('#btnUndoTiming').click()
    actual = await snapshot(page)
    assert actual['timing'] == before['timing'], (actual['timing'],before['timing'])
    close(actual['starts'], before['starts']); close(actual['ends'], before['ends'])


async def group(page, start, end):
    await page.locator('#timingFrom').select_option(str(start))
    await page.locator('#timingTo').select_option(str(end))


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context(viewport={'width':1500,'height':1100},accept_downloads=True)
        await context.route('https://fonts.googleapis.com/**',lambda route:route.abort())
        await context.route('https://fonts.gstatic.com/**',lambda route:route.abort())
        page = await context.new_page(); errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(URL,wait_until='domcontentloaded')
        await load_fixture(page)
        await page.locator('#audioFile').set_input_files({'name':'duration-pulses.wav','mimeType':'audio/wav','buffer':wav_bytes(24)})
        await expect(page.locator('#audioName')).to_contain_text('duration-pulses.wav')
        await page.wait_for_function('J.ui.audio?.duration === 24')
        original = await snapshot(page)
        close(original['starts'],STARTS);close(original['ends'],ENDS);close(original['visibleEnds'],ENDS)
        for i in range(4):
            lyric_cuts=[c for c in original['cuts'] if c['line']==i and c['layout']!='interlude']
            close([min(c['start'] for c in lyric_cuts),max(c['end'] for c in lyric_cuts)],[STARTS[i],ENDS[i]])
        drawing=await page.evaluate('''() => {
          const renderer=new J.Renderer(), canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
          const drawn=[], original=renderer.drawCut.bind(renderer);
          renderer.drawCut=env=>{drawn.push({line:env.cut.line,layout:env.cut.layout});return original(env);};
          const result={};for(const time of [0.5,5.8,6.5,10.5]) {
            drawn.length=0;renderer.frame(canvas.getContext('2d'),J.ui.plan,time,{scale:0.5,fast:true,noGhost:true,noHud:true});
            result[time]=drawn.slice();
          }return result;
        }''')
        assert any(c['line']==0 and c['layout']!='interlude' for c in drawing['5.8']),drawing
        assert not any(c['layout']!='interlude' for key in ['0.5','6.5','10.5'] for c in drawing[key]),drawing
        print('PASS: exact starts/ends survive import, explicit long line renders past old cap, gaps show no early lyrics',flush=True)

        await change(page,'#lineList li:nth-child(1) .line-end',5.5)
        changed=await snapshot(page);close(changed['starts'],STARTS);close(changed['ends'],[5.5,10,15,19])
        await undo(page,original)
        await change(page,'#lineList li:nth-child(1) .line-duration',2)
        changed=await snapshot(page);close(changed['starts'],STARTS);close(changed['ends'],[3,10,15,19])
        await undo(page,original)
        await change(page,'#lineList li:nth-child(1) .line-end',8)
        assert (await snapshot(page))['timing']==original['timing']
        print('PASS: per-line end/duration edits, no unintended following shift, overlap rejection and undo',flush=True)

        await page.locator('#timingFollow').check()
        await page.locator('#lineList li:nth-child(1) .line-speed').select_option('2')
        await page.locator('#lineList li:nth-child(1) .apply-line-speed').click()
        fast=await snapshot(page);close(fast['starts'],[1,4.5,9.5,14.5]);close(fast['ends'],[3.5,7.5,12.5,16.5])
        assert fast['audioDuration']==24 and fast['previewRate']==original['previewRate']
        await undo(page,original)
        await page.locator('#lineList li:nth-child(1) .line-speed').select_option('0.8')
        await page.locator('#lineList li:nth-child(1) .apply-line-speed').click()
        slow=await snapshot(page);close(slow['starts'],[1,8.25,13.25,18.25]);close(slow['ends'],[7.25,11.25,16.25,20.25])
        await undo(page,original)
        await page.locator('#timingFollow').uncheck()
        await page.locator('#lineList li:nth-child(1) .line-speed').select_option('0.8')
        await page.locator('#lineList li:nth-child(1) .apply-line-speed').click()
        assert (await snapshot(page))['timing']==original['timing']
        print('PASS: per-line faster/slower duration preserves following gaps; disabled following shift rejects overlap; audio speed unchanged',flush=True)

        await group(page,1,2);await page.locator('#timingFollow').check()
        await change(page,'#timingTargetDuration',6);await page.locator('#btnStretchSeconds').click()
        seconds=await snapshot(page);close(seconds['starts'],[1,7,10.75,15]);close(seconds['ends'],[6,9.25,13,17])
        await undo(page,original)
        await page.locator('#timingFollow').uncheck()
        await page.locator('#btnStretchSeconds').click()
        held=await snapshot(page);close(held['starts'],[1,7,10.75,17]);close(held['ends'],[6,9.25,13,19])
        await undo(page,original)
        await page.locator('#timingFollow').check()
        await change(page,'#timingBars',2);await page.locator('#timingBeatsPerBar').select_option('4');await change(page,'#timingDurationBpm',120)
        await page.locator('#btnStretchBars').click()
        bars=await snapshot(page);close(bars['starts'],[1,7,9.5,13]);close(bars['ends'],[6,8.5,11,15])
        await undo(page,original)
        await change(page,'#timingSpeed',1.25);await page.locator('#btnStretchSpeed').click()
        speed=await snapshot(page);close(speed['starts'],[1,7,11,15.4]);close(speed['ends'],[6,9.4,13.4,17.4])
        await undo(page,original)
        await group(page,0,3);await change(page,'#timingTargetDuration',50);await page.locator('#btnStretchSeconds').click()
        assert (await snapshot(page))['timing']==original['timing']
        print('PASS: group seconds/bars/1.25x affine duration, optional following shift, audio bounds rollback and undo',flush=True)

        await change(page,'#autoStart',2)
        ranged=await snapshot(page)
        close(ranged['starts'],[2+(t-1)*17/18 for t in STARTS]);close(ranged['ends'],[2+(t-1)*17/18 for t in ENDS])
        await undo(page,original)
        await group(page,1,2);await change(page,'#timingShift',0.25);await page.locator('#btnShiftTiming').click()
        shifted=await snapshot(page);close(shifted['starts'],[1,7.25,12.25,17]);close(shifted['ends'],[6,10.25,15.25,19])
        print('PASS: existing range and offset tools transform explicit line ends consistently',flush=True)

        await page.wait_for_timeout(900)
        async with page.expect_download() as info:await page.locator('#btnSave').click()
        download=await info.value
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'project.json';await download.save_as(str(output))
            saved=json.loads(output.read_text());assert saved['timing']['lineEnds']==shifted['timing']['lineEnds']
        await page.reload(wait_until='domcontentloaded')
        await expect(page.locator('#lineList .line-end')).to_have_count(4)
        restored=await snapshot(page);close(restored['starts'],shifted['starts']);close(restored['ends'],shifted['ends'])
        assert restored['timing']['lineEnds']==shifted['timing']['lineEnds']
        await page.set_viewport_size({'width':390,'height':844});await page.wait_for_timeout(100)
        layout=await page.evaluate('({width:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth})')
        assert layout['body']<=layout['width'] and layout['root']<=layout['width'],layout
        assert not errors,errors
        print('PASS: explicit ends persist in JSON/reload, mobile controls fit, zero page errors',flush=True)
        await browser.close()


if __name__=='__main__':asyncio.run(main())
