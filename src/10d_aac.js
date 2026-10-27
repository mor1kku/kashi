/* AAC-LC fallback for browsers whose WebCodecs cannot encode AAC.
   The bundled WASM runs in a disposable worker, without uploads or shared memory. */
(() => {
'use strict';
function aacWorker(createModule) {
  let mod, ctx, frame, filled = 0, submitted = 0, channels, sampleRate, frameSize, inputPtr;
  let init, send, receive, flush, packetData, packetPts, packetDuration;
  function packets() {
    const out = [];
    let size;
    while ((size = receive(ctx)) > 0) {
      const pts = Number(packetPts(ctx));
      // libavcodec's first AAC packet is encoder priming, before source time zero.
      // Discard it, so the following packets keep the source's sample timestamps.
      if (pts < 0) continue;
      const ptr = packetData(ctx);
      out.push({ data: mod.HEAPU8.slice(ptr, ptr + size),
        timestamp: Math.round(pts * 1e6 / sampleRate), duration: Math.round(packetDuration(ctx) * 1e6 / sampleRate) });
    }
    if (size < 0) throw new Error('AAC音声の生成に失敗しました');
    return out;
  }
  function sendFrame() {
    mod.HEAPU8.set(new Uint8Array(frame.buffer), inputPtr);
    if (send(ctx, BigInt(submitted)) < 0) throw new Error('AAC音声をエンコードできません');
    submitted += frameSize; filled = 0;
    return packets();
  }
  self.onmessage = async ({ data: { id, type, config, data } }) => {
    try {
      let result;
      if (type === 'init') {
        mod = await createModule();
        const wrap = (name, ret, args) => mod.cwrap(name, ret, args);
        init = wrap('init_encoder', 'number', ['number', 'number', 'number']);
        send = wrap('send_frame', 'number', ['number', 'number']);
        receive = wrap('receive_packet', 'number', ['number']);
        flush = wrap('flush_encoder_start', null, ['number']);
        packetData = wrap('get_encoded_data', 'number', ['number']);
        packetPts = wrap('get_encoded_pts', 'number', ['number']);
        packetDuration = wrap('get_encoded_duration', 'number', ['number']);
        channels = config.numberOfChannels; sampleRate = config.sampleRate;
        ctx = init(channels, sampleRate, config.bitrate);
        if (!ctx) throw new Error('AAC音声の準備に失敗しました');
        frameSize = wrap('get_encoder_frame_size', 'number', ['number'])(ctx);
        frame = new Float32Array(frameSize * channels);
        inputPtr = wrap('get_encode_input_ptr', 'number', ['number', 'number'])(ctx, frame.byteLength);
        if (!inputPtr) throw new Error('AAC音声のメモリを確保できません');
        const ptr = wrap('get_encoder_extradata', 'number', ['number'])(ctx);
        const size = wrap('get_encoder_extradata_size', 'number', ['number'])(ctx);
        result = { description: mod.HEAPU8.slice(ptr, ptr + size) };
      } else if (type === 'encode') {
        if (!ctx || data.length % channels) throw new Error('AAC音声の入力を確認してください');
        const out = [];
        for (let offset = 0; offset < data.length;) {
          const n = Math.min(frame.length - filled, data.length - offset);
          frame.set(data.subarray(offset, offset + n), filled); filled += n; offset += n;
          if (filled === frame.length) out.push(...sendFrame());
        }
        result = { packets: out };
      } else if (type === 'flush') {
        const out = [];
        if (filled) { frame.fill(0, filled); out.push(...sendFrame()); }
        flush(ctx); out.push(...packets()); result = { packets: out };
      } else throw new Error('AAC音声の処理を確認してください');
      const transfers = result.packets ? result.packets.map(p => p.data.buffer) : [result.description.buffer];
      self.postMessage({ id, result }, transfers);
    } catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
  };
}

J.createSoftwareAacEncoder = async (config, onOutput, signal) => {
  if (typeof Worker === 'undefined' || typeof globalThis.JizuraAacModule !== 'function') throw new Error('AAC音声の準備ができません。最新版のページを開き直してください。');
  const url = URL.createObjectURL(new Blob([`(${aacWorker.toString()})(${globalThis.JizuraAacModule.toString()});`], { type: 'text/javascript' }));
  let worker;
  try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
  let nextId = 0, closed = false;
  const pending = new Map();
  const fail = error => {
    if (closed) return;
    closed = true; worker.terminate();
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear(); signal?.removeEventListener('abort', abort);
  };
  const abort = () => fail(new Error('キャンセルしました'));
  worker.onerror = event => fail(new Error(event.message || 'AAC音声の処理が停止しました。ページを開き直して再試行してください。'));
  worker.onmessageerror = () => fail(new Error('AAC音声の処理結果を受け取れませんでした'));
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id); if (!call) return;
    pending.delete(data.id); clearTimeout(call.timer);
    if (data.error) { const error = new Error(data.error); call.reject(error); fail(error); }
    else call.resolve(data.result);
  };
  function request(type, extra = {}, transfers = []) {
    if (closed) return Promise.reject(new Error('AAC音声の処理は終了しています'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => fail(new Error('AAC音声の処理が応答しません。ページを開き直して再試行してください。')), 30000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, type, ...extra }, transfers); } catch (error) { fail(error); }
    });
  }
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) { abort(); throw new Error('キャンセルしました'); }
  try {
    const { description } = await request('init', { config });
    let metadata = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels, description } };
    const emit = ({ packets }) => {
      for (const packet of packets) { onOutput(packet, metadata); metadata = undefined; }
    };
    return {
      async encode(data) { emit(await request('encode', { data }, [data.buffer])); },
      async flush() { emit(await request('flush')); },
      close() { fail(new Error('AAC音声の処理は終了しました')); },
    };
  } catch (error) { fail(error); throw error; }
};
})();
