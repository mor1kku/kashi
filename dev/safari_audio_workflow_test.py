"""Reproduce WebKit bug302253 with real AAC packets and Safari's exact cookie.

Build and serve on :8765, then run with Playwright, Chromium and ffmpeg installed.
This emulates the affected native AudioEncoder output; it is not an iPhone test.
"""
import asyncio
import base64
import io
import json
import math
import os
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from playwright.async_api import async_playwright, expect

URL = os.environ.get('JIZURA_TEST_URL', 'http://127.0.0.1:8765')

# Keep the native export route (AudioData -> EncodedAudioChunk -> addAudioChunk).
# Only the encoder is substituted: real bundled AAC packets, incorrect Safari
# metadata. A Linux WebKit build cannot exercise Apple's CoreAudio backend.
SAFARI_ENCODER = r"""
globalThis.AudioEncoder = class {
  static async isConfigSupported(config) { return {supported:config.codec==='mp4a.40.2',config}; }
  constructor(callbacks) { this.callbacks=callbacks; this.state='unconfigured'; this.encodeQueueSize=0; }
  configure(config) {
    this.state='configured';
    this.pending=J.createSoftwareAacEncoder(config,(packet,metadata)=>{
      if (metadata?.decoderConfig) {
        const cookie=new Uint8Array([3,128,128,128,34,0,0,0,4,128,128,128,20,64,20,0,24,0,0,0,0,0,0,0,0,0,5,128,128,128,2,17,136,6,128,128,128,1,2]);
        cookie[32]=config.numberOfChannels===2?144:136;
        metadata={decoderConfig:{...metadata.decoderConfig,description:cookie}};
      }
      this.callbacks.output(new EncodedAudioChunk({...packet,type:'key'}),metadata);
    }).then(encoder=>{ this.encoder=encoder; });
  }
  encode(frame) {
    const n=frame.numberOfFrames, channels=frame.numberOfChannels;
    const data=new Float32Array(n*channels);
    for(let c=0;c<channels;c++) {
      const plane=new Float32Array(n); frame.copyTo(plane,{planeIndex:c,format:'f32-planar'});
      for(let i=0;i<n;i++) data[i*channels+c]=plane[i];
    }
    this.encodeQueueSize++;
    this.pending=this.pending.then(()=>this.encoder.encode(data))
      .catch(error=>{ this.failure=error; this.callbacks.error(error); })
      .finally(()=>{this.encodeQueueSize--;});
  }
  async flush() { await this.pending; if(this.failure) throw this.failure; await this.encoder.flush(); }
  close() { this.state='closed'; this.encoder?.close(); }
};
"""


def source_wav(channels):
    sr = 16000
    samples = bytearray()
    for i in range(sr * 7):
        for channel in range(channels):
            # The selected five-second range starts at 2s. Different tones
            # before/after it catch a range that trims only video, not music.
            frequency = (220 if i < 2 * sr else 440) * (1 + channel * .5)
            samples.extend(struct.pack('<h', int(16000 * math.sin(2 * math.pi * frequency * i / sr))))
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setnchannels(channels); wav.setsampwidth(2); wav.setframerate(sr)
        wav.writeframes(samples)
    return out.getvalue()


def decoded_audio(path):
    return subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], capture_output=True, timeout=30)


def verify_audio(path, channels, duration):
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)]))
    audio = [s for s in probe['streams'] if s['codec_type'] == 'audio']
    assert len(audio) == 1 and audio[0]['codec_name'] == 'aac', probe
    assert audio[0]['sample_rate'] == '48000' and audio[0]['channels'] == channels, audio
    assert abs(float(audio[0]['duration']) - duration) < .05, audio
    result = decoded_audio(path)
    assert result.returncode == 0, result.stderr.decode()
    samples = struct.unpack('<' + 'f' * (len(result.stdout) // 4), result.stdout)
    rms = math.sqrt(sum(x*x for x in samples) / len(samples))
    assert rms > .05, rms
    return samples, probe


async def direct_export(page, path):
    data = await page.evaluate('''async () => {
      const r=await J.exportMP4({plan:{...J.ui.plan,fps:24},project:{...J.ui.project,res:480,includeAudio:true},audio:J.ui.audio,range:{start:0,duration:1}});
      return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(r.blob);});
    }''')
    path.write_bytes(base64.b64decode(data))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width':390,'height':844}, accept_downloads=True)
        await context.add_init_script(SAFARI_ENCODER)
        await context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        await context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
        page = await context.new_page(); errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until='domcontentloaded')
        await expect(page.locator('#btnSoundTest')).to_be_disabled()
        await page.locator('#lyrics').fill('one\ntwo\nthree')
        await page.locator('#audioFile').set_input_files({'name':'mono.wav','mimeType':'audio/wav','buffer':source_wav(1)})
        await page.wait_for_function('J.ui.audio && !J.ui.audioBusy')
        assert await page.evaluate('(async()=>!(await J.pickAudioCodec(48000,1)).software)()')

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            await page.evaluate('window.normalizeAac = J.normalizeAacMetadata; J.normalizeAacMetadata = metadata => metadata;')
            broken = folder/'before.mp4'
            await direct_export(page, broken)
            decoded = decoded_audio(broken)
            assert decoded.returncode != 0 and not decoded.stdout, 'Fixture must reproduce undecodable audio before the fix'
            print('PASS: exact Safari cookie produces an MP4 whose AAC audio cannot be decoded before normalization', flush=True)

            await page.evaluate('J.normalizeAacMetadata = window.normalizeAac')
            fixed = folder/'after.mp4'
            await direct_export(page, fixed)
            verify_audio(fixed, 1, 1)
            print('PASS: identical native-route AAC packets decode with sound after metadata normalization (mono, 48kHz)', flush=True)

            await page.locator('#audioFile').set_input_files({'name':'stereo.wav','mimeType':'audio/wav','buffer':source_wav(2)})
            await page.wait_for_function('!J.ui.audioBusy && J.ui.audio.buffer.numberOfChannels===2')
            await page.locator('#scrub').fill('2857')
            await page.locator('#scrub').dispatch_event('change')
            # Sound-test settings must not overwrite the user's full export settings.
            before = await page.evaluate('''() => {
              J.ui.project.includeAudio=false;
              return JSON.stringify(J.ui.project);
            }''')
            await page.locator('#btnSoundTest').click()
            await expect(page.locator('#btnSoundTest')).to_be_disabled()
            await expect(page.locator('#downloadResult')).to_be_visible(timeout=120000)
            await expect(page.locator('#downloadAudioNote')).to_contain_text('AAC')
            assert await page.evaluate('JSON.stringify(J.ui.project)') == before
            async with page.expect_download() as info:
                await page.locator('#downloadLink').click()
            download = await info.value
            assert download.suggested_filename.endswith('_sound-test.mp4')
            small = folder/'sound-test.mp4'
            await download.save_as(str(small))
            samples, probe = verify_audio(small, 2, 5)
            video = next(s for s in probe['streams'] if s['codec_type']=='video')
            assert video['height'] == 480 and video['avg_frame_rate'] == '24/1', video
            assert small.stat().st_size < 3_000_000
            # 440Hz in the selected section must dominate the earlier 220Hz.
            segment = samples[800:4800]
            def energy(f):
                return abs(sum(x * complex(math.cos(2*math.pi*f*i/8000), math.sin(2*math.pi*f*i/8000)) for i,x in enumerate(segment)))
            assert energy(440) > 10 * energy(220)
            await expect(page.locator('#btnSoundTest')).to_be_enabled()
            print(f'PASS: mobile UI exports selected 5s with stereo AAC, sound, 480p/24fps, {small.stat().st_size} bytes; original settings retained', flush=True)
        assert not errors, errors
        await browser.close()
        print('PASS: zero browser page errors')


if __name__ == '__main__':
    asyncio.run(main())
