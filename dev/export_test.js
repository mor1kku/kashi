/* Run with: node dev/export_test.js (no dependencies). */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/11_export.js'), 'utf8');
function setup(options = {}) {
  const state = { encoders: [], frames: [], revoked: [], clicked: [], finalized: false, resampleWindows: [], audioData: [] };
  class Encoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.encodeQueueSize = 0; state.encoders.push(this); }
    configure(config) { this.config = config; if (options.configureError) throw new Error('configure failed'); this.state = 'configured'; }
    encode(frame) {
      if (options.encodeError) throw new Error('encode failed');
      if (options.stall || options.asyncError) {
        this.encodeQueueSize = 5;
        if (options.asyncError) setTimeout(() => this.callbacks.error(new Error('encoder failed')), 0);
      } else this.callbacks.output({ byteLength: options.chunkBytes || 1 }, this.config?.codec === 'mp4a.40.2' ? options.audioMetadata || {} : {});
    }
    async flush() { if (options.flushError) this.callbacks.error(new Error('flush failed')); }
    close() { this.state = 'closed'; }
  }
  class Frame { constructor() { state.frames.push(this); } close() { this.closed = true; } }
  const J = { outputSize: () => options.size || [1280, 720], glyphs: { maxRes: 123 }, Renderer: class { frame() { if (options.renderError) throw new Error('render failed'); } } };
  const context = {
    J, Blob, TextEncoder, Uint8Array, Float32Array, DataView, ArrayBuffer,
    window: {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => state.revoked.push(url) },
    setTimeout, document: {
      body: { appendChild() {} },
      createElement: tag => tag === 'canvas' ? { getContext: () => ({}), toBlob: callback => callback(options.pngNull ? null : new Blob(['png'])) } : { click() { state.clicked.push(this.href); }, remove() {} }
    },
    VideoEncoder: Encoder, VideoFrame: Frame,
    Mp4Muxer: { ArrayBufferTarget: class { constructor() { this.buffer = new ArrayBuffer(8); } }, Muxer: class {
      constructor(config) { state.muxConfig = config; }
      addVideoChunk() { if (options.muxError) throw new Error('mux failed'); }
      addAudioChunk(chunk, metadata) { state.audioMetadata = metadata; if (options.audioMuxError) throw new Error('audio mux failed'); }
      addAudioChunkRaw(data) { state.rawAudioBytes = (state.rawAudioBytes || 0) + data.byteLength; }
      finalize() { state.finalized = true; }
    } }
  };
  if (options.audioSupport) {
    context.AudioEncoder = class extends Encoder {
      static async isConfigSupported(config) { state.audioProbe = config.codec; return { supported: options.aacSupport !== false }; }
      encode(frame) {
        if (options.audioStall) { this.encodeQueueSize = 17; return; }
        if (options.audioEncodeError) throw new Error('audio encode failed');
        if (options.noAudioChunks) return;
        super.encode(frame);
      }
    };
    context.AudioData = class extends Frame { constructor(config) { super(); state.audioData.push(config); } };
    context.OfflineAudioContext = class {
      constructor(channels, length) { this.channels = channels; this.length = length; this.window = { length }; state.resampleWindows.push(this.window); }
      createBufferSource() { return { connect() {}, start: (_, offset) => { this.window.offset = offset; } }; }
      async startRendering() { return { numberOfChannels: this.channels, length: this.length, getChannelData: () => new Float32Array(this.length) }; }
    };
  }
  if (options.noAudioData) delete context.AudioData;
  if (options.softwareAudio) J.createSoftwareAacEncoder = async (config, output, signal) => {
    if (options.softwareInitError) throw new Error('software init failed');
    state.softwareConfig = config; state.softwareInputs = []; state.softwareClosed = false;
    return {
      async encode(data) { state.softwareInputs.push(data.length); if (!options.noAudioChunks) output({data: new Uint8Array(12), timestamp: 0, duration: 1000}, {}); },
      async flush() { state.softwareFlushed = true; },
      close() { state.softwareClosed = true; }
    };
  }
  vm.runInNewContext(source, context);
  return { J, state, context };
}
const args = { plan: { fps: 30, duration: 0.1, W: 1280 }, project: { includeAudio: false } };
function cleaned(J, state) { assert.equal(J.glyphs.maxRes, 123); assert.ok(state.encoders.every(e => e.state === 'closed')); assert.ok(state.frames.every(f => f.closed)); }
test('completed export returns MP4 and releases frame/encoder resources', async () => {
  const { J, state } = setup();
  const result = await J.exportMP4(args);
  assert.equal(result.blob.type, 'video/mp4'); assert.equal(result.blob.size, 8);
  assert.equal(state.muxConfig.fastStart, false, 'do not retain a duplicate set of compressed samples for fast start');
  assert.equal(state.finalized, true); cleaned(J, state);
});
for (const [option, message] of [['configureError', 'configure failed'], ['renderError', 'render failed'], ['encodeError', 'encode failed'], ['muxError', 'mux failed'], ['asyncError', 'encoder failed'], ['flushError', 'flush failed']]) {
  test(`${option} rejects and frees resources`, { timeout: 2000 }, async () => {
    const { J, state } = setup({ [option]: true });
    await assert.rejects(J.exportMP4(args), new RegExp(message));
    assert.equal(state.finalized, false); cleaned(J, state);
  });
}
test('cancel interrupts a blocked encoder queue', { timeout: 2000 }, async () => {
  const { J, state } = setup({ stall: true }); const controller = new AbortController();
  const promise = J.exportMP4({ ...args, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /キャンセル/); cleaned(J, state);
});
test('pre-aborted export does not start encoding', async () => {
  const { J, state } = setup(); const controller = new AbortController(); controller.abort();
  await assert.rejects(J.exportMP4({ ...args, signal: controller.signal }), /キャンセル/);
  assert.equal(state.encoders.length, 0);
});
test('unsupported audio fails explicitly rather than silently exporting mute video', async () => {
  const { J } = setup();
  await assert.rejects(J.exportMP4({ ...args, project: { includeAudio: true }, audio: { buffer: { numberOfChannels: 2 } } }), /音声付きMP4/);
});
test('audio export completes and closes both encoders', async () => {
  const { J, state } = setup({ audioSupport: true });
  const result = await J.exportMP4({ ...args, project: { includeAudio: true }, audio: { buffer: { numberOfChannels: 2 } } });
  assert.equal(result.audio, 'aac'); assert.equal(state.encoders.length, 2); cleaned(J, state);
});
for (const [option, message] of [['audioEncodeError', 'audio encode failed'], ['audioMuxError', 'audio mux failed']]) {
  test(`${option} rejects and frees both encoders`, async () => {
    const { J, state } = setup({ audioSupport: true, [option]: true });
    await assert.rejects(J.exportMP4({ ...args, project: { includeAudio: true }, audio: { buffer: { numberOfChannels: 2 } } }), new RegExp(message));
    assert.equal(state.finalized, false); cleaned(J, state);
  });
}
test('cancel interrupts audio queue backpressure', { timeout: 2000 }, async () => {
  const { J, state } = setup({ audioSupport: true, audioStall: true }); const controller = new AbortController();
  const promise = J.exportMP4({ ...args, project: { includeAudio: true }, audio: { buffer: { numberOfChannels: 2 } }, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, /キャンセル/); assert.equal(state.encoders.length, 2); cleaned(J, state);
});
test('prepared download stays available until disposed, and disposal is idempotent', () => {
  const { J, state } = setup(); const download = J.prepareDownload('video.mp4', new Blob(['video']));
  assert.equal(download.filename, 'video.mp4'); assert.equal(download.url, 'blob:test'); assert.equal(download.blob.size, 5);
  assert.deepEqual(state.revoked, []); download.dispose(); download.dispose();
  assert.deepEqual(state.revoked, ['blob:test']);
});
test('automatic download reports initiated, not confirmed saved', async () => {
  const { J, state, context } = setup(); const timers = []; context.setTimeout = callback => timers.push(callback);
  assert.equal(await J.saveFile('video.mp4', new Blob(['video'])), 'initiated');
  assert.deepEqual(state.clicked, ['blob:test']); assert.deepEqual(state.revoked, []);
  timers[0](); assert.deepEqual(state.revoked, ['blob:test']);
});
test('PNG allocation failure has an actionable error', async () => {
  const { J } = setup({ pngNull: true });
  await assert.rejects(J.exportPNGZip(args), /解像度を下げて/);
});
test('bitrate remains bounded for common resolutions, high fps and quality levels', () => {
  const { J } = setup();
  assert.equal(J.exportBitrate(1920, 1080, 30), 10e6);
  assert.equal(J.exportBitrate(1080, 1920, 30), 10e6, 'portrait and landscape use the same pixel budget');
  assert.equal(J.exportBitrate(3840, 2160, 60), 42e6);
  assert.equal(J.exportBitrate(3840, 2160, 60, 'max'), 60e6);
  assert.ok(J.exportBitrate(1280, 720, 24, 'standard') < J.exportBitrate(1280, 720, 24));
});
test('large MP4 is rejected before allocating encoders or muxer buffers', async () => {
  const { J, state } = setup({ size: [3840, 2160] });
  await assert.rejects(J.exportMP4({ ...args, plan: { ...args.plan, duration: 240, fps: 60 } }), /容量が大きすぎます.*720p/);
  assert.equal(state.encoders.length, 0);
  assert.equal(state.muxConfig, undefined);
});
test('actual encoded size is also bounded when a codec exceeds its target bitrate', async () => {
  const { J, state } = setup({ chunkBytes: 257 * 1024 * 1024 });
  await assert.rejects(J.exportMP4(args), /容量が大きすぎます/);
  assert.equal(state.finalized, false); cleaned(J, state);
});
test('audio resampling is bounded to five seconds with continuous absolute timestamps', async () => {
  const { J, state } = setup({ audioSupport: true });
  const duration = 12.05, sr = 48000;
  await J.exportMP4({ ...args, project: { includeAudio: true }, plan: { ...args.plan, fps: 1, duration }, audio: { buffer: { numberOfChannels: 2, duration: 11 } } });
  assert.deepEqual(state.resampleWindows, [{ length: 240000, offset: 0 }, { length: 240000, offset: 5 }, { length: 98400, offset: 10 }]);
  let samples = 0;
  for (const frame of state.audioData) {
    assert.equal(frame.timestamp, Math.round(samples * 1e6 / sr));
    samples += frame.numberOfFrames;
  }
  assert.equal(samples, Math.ceil(duration * sr), 'partial final audio block keeps the exact duration');
  cleaned(J, state);
});

test('audio requested without a loaded song fails before encoding', async () => {
  const { J, state } = setup();
  await assert.rejects(J.exportMP4({ ...args, project: {} }), /音声が未読込/);
  await assert.rejects(J.exportMP4({ ...args, project: { includeAudio: true }, audio: {} }), /音声が未読込/);
  assert.equal(state.encoders.length, 0);
  assert.equal(state.muxConfig, undefined);
});

test('AAC unsupported uses software AAC, never substitutes Opus', async () => {
  const {J,state} = setup({audioSupport:true,aacSupport:false,softwareAudio:true});
  const result=await J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:2,duration:1}}});
  assert.equal(state.audioProbe,'mp4a.40.2'); assert.equal(result.audio,'aac');
  assert.equal(state.muxConfig.audio.codec,'aac'); assert.equal(state.softwareFlushed,true);
  assert.equal(state.softwareClosed,true); assert.equal(state.rawAudioBytes,12); cleaned(J,state);
});
test('software AAC also works without the AudioData API', async () => {
  const {J,state} = setup({audioSupport:true,noAudioData:true,softwareAudio:true});
  const result=await J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:1,duration:1}}});
  assert.equal(result.audio,'aac'); assert.equal(state.softwareConfig.numberOfChannels,1); cleaned(J,state);
});
test('AAC worker initialization failure rejects before any video encoding', async () => {
  const {J,state} = setup({audioSupport:true,aacSupport:false,softwareAudio:true,softwareInitError:true});
  await assert.rejects(J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:2}}}),/software init failed/);
  assert.equal(state.encoders.length,0); assert.equal(state.finalized,false);
});
for (const softwareAudio of [false,true]) test('no audio packets prevents a completed silent MP4: software='+softwareAudio,async()=>{
  const {J,state}=setup({audioSupport:true,aacSupport:!softwareAudio,softwareAudio,noAudioChunks:true});
  await assert.rejects(J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:2,duration:1}}}),/音声を書き出せなかった/);
  assert.equal(state.finalized,false); if(softwareAudio) assert.equal(state.softwareClosed,true); cleaned(J,state);
});

// Exact CoreAudio ES_Descriptor reported in WebKit bug302253 (48kHz mono).
const safariCookie = [3,128,128,128,34,0,0,0,4,128,128,128,20,64,20,0,24,0,0,0,0,0,0,0,0,0,5,128,128,128,2,17,136,6,128,128,128,1,2];
function meta(description) { return {decoderConfig:{codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:1,description}}; }
test('Safari ES descriptor is reduced to the actual AAC AudioSpecificConfig',()=>{
  const {J}=setup();
  const raw=meta(new Uint8Array(safariCookie));
  assert.deepEqual(Array.from(J.normalizeAacMetadata(raw,48000,1).decoderConfig.description),[17,136]);
  assert.equal(raw.decoderConfig.description.length,39,'do not mutate the encoder metadata');
});
test('valid ASC including extensions passes through, respecting typed-array offsets',()=>{
  const {J}=setup();
  for (const bytes of [[17,136],[17,144,86,229,0]]) {
    const input=meta(Uint8Array.from([99,...bytes,99]).subarray(1,1+bytes.length));
    assert.equal(J.normalizeAacMetadata(input,48000,bytes[1]===136?1:2),input);
  }
  const wrapped=Uint8Array.from([99,...safariCookie,99]).subarray(1,40);
  assert.deepEqual(Array.from(J.normalizeAacMetadata(meta(wrapped),48000,1).decoderConfig.description),[17,136]);
});
test('invalid, truncated, mismatched and oversized AAC descriptors are rejected',()=>{
  const {J}=setup();
  for(const bytes of [[0,0],[],safariCookie.slice(0,-1),[3,255,255,255,255],safariCookie.slice(0,30),[17,144]])
    assert.throws(()=>J.normalizeAacMetadata(meta(new Uint8Array(bytes)),48000,1),/音声の設定情報/);
  assert.equal(J.normalizeAacMetadata(undefined,48000,1),undefined);
});
test('native Safari output is normalized before the MP4 muxer receives it',async()=>{
  const {J,state}=setup({audioSupport:true,audioMetadata:meta(new Uint8Array(safariCookie))});
  await J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:1,duration:1}}});
  assert.deepEqual(Array.from(state.audioMetadata.decoderConfig.description),[17,136]);
});
test('invalid native AAC metadata cannot produce a completed MP4',async()=>{
  const {J,state}=setup({audioSupport:true,audioMetadata:meta(new Uint8Array([0,0]))});
  await assert.rejects(J.exportMP4({...args,project:{includeAudio:true},audio:{buffer:{numberOfChannels:1,duration:1}}}),/音声の設定情報/);
  assert.equal(state.finalized,false); cleaned(J,state);
});
test('short sound test uses the same source offset for audio and video',async()=>{
  const {J,state}=setup({audioSupport:true}); const times=[]; J.Renderer=class { frame(ctx,plan,t){times.push(t);} };
  await J.exportMP4({...args,plan:{...args.plan,duration:7,fps:2},project:{includeAudio:true},audio:{buffer:{numberOfChannels:1,duration:7}},range:{start:2,duration:5}});
  assert.equal(times[0],2);assert.equal(times.at(-1),6.5);assert.equal(times.length,10);
  assert.deepEqual(state.resampleWindows,[{length:240000,offset:2}]);
  assert.equal(state.audioData[0].timestamp,0);
  await assert.rejects(J.exportMP4({...args,range:{start:1,duration:5}}),/書き出す区間/);
});
