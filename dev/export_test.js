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
    configure() { if (options.configureError) throw new Error('configure failed'); this.state = 'configured'; }
    encode(frame) {
      if (options.encodeError) throw new Error('encode failed');
      if (options.stall || options.asyncError) {
        this.encodeQueueSize = 5;
        if (options.asyncError) setTimeout(() => this.callbacks.error(new Error('encoder failed')), 0);
      } else this.callbacks.output({ byteLength: options.chunkBytes || 1 }, {});
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
      addAudioChunk() { if (options.audioMuxError) throw new Error('audio mux failed'); }
      finalize() { state.finalized = true; }
    } }
  };
  if (options.audioSupport) {
    context.AudioEncoder = class extends Encoder {
      encode(frame) {
        if (options.audioStall) { this.encodeQueueSize = 17; return; }
        if (options.audioEncodeError) throw new Error('audio encode failed');
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
  vm.runInNewContext(source, context);
  return { J, state, context };
}
const args = { plan: { fps: 30, duration: 0.1, W: 1280 }, project: {} };
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
  await assert.rejects(J.exportMP4({ ...args, audio: { buffer: { numberOfChannels: 2 } } }), /音声付きMP4/);
});
test('audio export completes and closes both encoders', async () => {
  const { J, state } = setup({ audioSupport: true });
  const result = await J.exportMP4({ ...args, audio: { buffer: { numberOfChannels: 2 } } });
  assert.equal(result.audio, 'aac'); assert.equal(state.encoders.length, 2); cleaned(J, state);
});
for (const [option, message] of [['audioEncodeError', 'audio encode failed'], ['audioMuxError', 'audio mux failed']]) {
  test(`${option} rejects and frees both encoders`, async () => {
    const { J, state } = setup({ audioSupport: true, [option]: true });
    await assert.rejects(J.exportMP4({ ...args, audio: { buffer: { numberOfChannels: 2 } } }), new RegExp(message));
    assert.equal(state.finalized, false); cleaned(J, state);
  });
}
test('cancel interrupts audio queue backpressure', { timeout: 2000 }, async () => {
  const { J, state } = setup({ audioSupport: true, audioStall: true }); const controller = new AbortController();
  const promise = J.exportMP4({ ...args, audio: { buffer: { numberOfChannels: 2 } }, signal: controller.signal });
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
  await J.exportMP4({ ...args, plan: { ...args.plan, fps: 1, duration }, audio: { buffer: { numberOfChannels: 2, duration: 11 } } });
  assert.deepEqual(state.resampleWindows, [{ length: 240000, offset: 0 }, { length: 240000, offset: 5 }, { length: 98400, offset: 10 }]);
  let samples = 0;
  for (const frame of state.audioData) {
    assert.equal(frame.timestamp, Math.round(samples * 1e6 / sr));
    samples += frame.numberOfFrames;
  }
  assert.equal(samples, Math.ceil(duration * sr), 'partial final audio block keeps the exact duration');
  cleaned(J, state);
});
