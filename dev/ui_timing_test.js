// Run: node dev/ui_timing_test.js. Exercise actual UI timing handlers without a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const elements = {};
let playbackTime = 8;
const seeks = [];
function el(id) { return elements[id] ||= { value: '', setAttribute() {}, focus() {} }; }
const context = {
  J: {
    LAYOUT_ORDER: [], ENTER_ORDER: [], EXIT_ORDER: [], HOLD_ORDER: [], DECOR_ORDER: [],
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
  },
  S: {},
  $: el,
  pause() { context.S.playing = false; },
  play() { context.S.playing = true; },
  seek(t) { seeks.push(t); context.S.t = t; },
  replan() {
    const parsed = context.J.parseLyrics(context.S.project.lyrics);
    const computed = context.J.computeTiming(context.S.project, parsed, context.S.audio);
    context.S.plan = { duration: computed.duration, lines: parsed.lines.map((line, i) => ({ ...line, index: i, start: computed.starts[i], end: computed.ends[i] })) };
  },
  replanSoon() {},
  syncUI() {
    const T = context.S.project.timing;
    el('autoStart').value = String(T.autoStart ?? context.S.plan.lines[0]?.start ?? 0);
    el('autoEnd').value = T.autoEnd == null ? '' : String(T.autoEnd);
    el('offset').value = String(T.offset ?? 0.4);
  },
  renderLines() {}, autosave() {},
  AP: { time: () => playbackTime },
  performance: { now: () => 10000 },
  audioLike: () => context.S.audio,
  currentSongTime: () => context.S.audio && context.S.playing ? playbackTime : context.S.t,
};
vm.createContext(context);
vm.runInContext(read('src/08_planner.js'), context);
vm.runInContext(read('src/10b_timing.js'), context);
const source = read('src/12_ui.js');
const begin = source.indexOf('let timingUndo = null;');
const end = source.indexOf('/* ---------------- sync all inputs from project');
assert.ok(begin >= 0 && end > begin, 'UI timing handler section must be available');
vm.runInContext(source.slice(begin, end), context);

function reset() {
  playbackTime = 8;
  seeks.length = 0;
  for (const key of Object.keys(elements)) delete elements[key];
  context.S = {
    project: { lyrics: 'A\nB\nC', timing: { lineTimes: { 1: 10 }, autoTimes: { 0: 0, 1: 10, 2: 20 }, autoStart: 0, autoEnd: 30 } },
    audio: { duration: 30 }, t: 8, t0: 2000, previewRate: 1, playing: true, tap: null,
  };
  context.replan(); context.syncUI();
  el('timingFrom').value = '0'; el('timingTo').value = '2';
  el('timingShift').value = '0.5'; el('timingSpacing').value = 'lyrics';
  el('timingSnap').value = '0.65'; el('timingMode').value = 'keep';
  el('timingFollow').checked = false;
  el('timingBars').value = '1'; el('timingBeatsPerBar').value = '4';
  el('timingDurationBpm').value = ''; el('timingSpeed').value = '1';
}

// A newly inserted row must not inherit the old row's manual correction.
reset();
context.updateLyrics('X\nA\nB\nC');
assert.equal(context.S.project.timing.lineTimes[2], 10);
assert.equal(context.S.project.timing.lineTimes[1], undefined);
assert.equal(Object.keys(context.S.project.timing.autoTimes).length, 0);
assert.equal(elements.btnUndoTiming.disabled, true);
assert.match(elements.timingStatus.textContent, /仮配置/);

// Correcting words in place retains the row's manual timestamp.
reset();
context.updateLyrics('A\nB corrected\nC');
assert.equal(context.S.project.timing.lineTimes[1], 10);

// Reordering corrected rows never retains mutually contradictory manual anchors.
reset();
context.S.project.timing.lineTimes = { 0: 2, 1: 10, 2: 20 };
context.updateLyrics('C\nB\nA');
const anchors = Object.values(context.S.project.timing.lineTimes);
assert.ok(anchors.every((t, i) => !i || t > anchors[i - 1]));

// A partial tap is staged; stopping places remaining lyrics after the tapped anchor.
reset();
context.S.project.timing.lineTimes = {};
context.startTap();
context.tapNow();
assert.equal(Object.keys(context.S.project.timing.lineTimes).length, 0);
context.stopTap();
assert.equal(context.S.project.timing.lineTimes[0], 8);
assert.ok(context.S.project.timing.autoTimes[1] > 8);
assert.ok(context.S.project.timing.autoTimes[2] > context.S.project.timing.autoTimes[1]);
assert.equal(elements.btnUndoTiming.disabled, false);

// Contradictory untapped manual anchors reject the session without altering the project.
reset();
context.S.project.timing.lineTimes = { 1: 4 };
const beforeTap = JSON.stringify(context.S.project.timing);
context.startTap();
context.tapNow();
context.stopTap();
assert.equal(JSON.stringify(context.S.project.timing), beforeTap);
assert.match(elements.timingStatus.textContent, /元のタイミング/);

// Rounding cannot move a correction onto its neighbour's timestamp.
reset();
context.S.project.timing.autoTimes = { 0: 1.001, 1: 1.5, 2: 2 };
context.S.project.timing.lineTimes = {};
context.S.plan.lines = [{ start: 1.001 }, { start: 1.5 }, { start: 2 }];
context.setLineTime(1, 1.0014);
assert.equal(context.S.project.timing.lineTimes[1], undefined);

// Clearing a correction must not expose an automatic timestamp before the previous row.
reset();
context.S.project.timing.autoTimes = { 0: 0, 1: 5, 2: 10 };
context.S.project.timing.lineTimes = { 0: 7, 1: 8 };
context.S.plan.lines = [{ start: 7 }, { start: 8 }, { start: 10 }];
context.setLineTime(1, NaN);
assert.equal(context.S.project.timing.lineTimes[1], 8);

const actualStarts = () => Array.from(context.effectiveTiming().starts);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

// Newly pasted LRC is an explicit new timeline, even after a previous replacement.
reset();
Object.assign(context.S.project.timing, { ignoreLrc: true, lineTimes: { 0: 1, 1: 12, 2: 21 } });
context.updateLyrics('[00:02]A\n[00:05]B\n[00:08]C');
assert.equal(context.S.project.timing.ignoreLrc, false);
assert.equal(context.S.project.timing.autoStart, undefined);
assert.equal(context.S.project.timing.autoEnd, undefined);
assert.deepEqual(Object.keys(context.S.project.timing.lineTimes), [], 'new timestamped rows cannot inherit old corrections');
assert.deepEqual(actualStarts(), [2, 5, 8]);

reset();
context.S.project.lyrics = '[00:01]A\n[00:05]B\n[00:09]C';
Object.assign(context.S.project.timing, { ignoreLrc: true, lineTimes: { 1: 12 } });
context.updateLyrics('[00:01]A\n[00:06]B\n[00:09]C');
assert.equal(context.S.project.timing.lineTimes[1], undefined, 'changed LRC timestamp supersedes that row\'s correction');
assert.equal(context.S.project.timing.ignoreLrc, false);
assert.deepEqual(actualStarts(), [1, 6, 9]);

reset();
context.S.project.lyrics = '[00:01]A\n[00:05]B\n[00:09]C';
Object.assign(context.S.project.timing, { ignoreLrc: true, lineTimes: { 1: 12 } });
context.updateLyrics('[00:01]A\n[00:05]B corrected\n[00:09]C');
assert.equal(context.S.project.timing.ignoreLrc, true, 'text-only edits retain the decision to ignore source timestamps');
assert.equal(context.S.project.timing.lineTimes[1], 12);
assert.equal(context.S.project.timing.autoEnd, 30);

// Tapping immediately after a debounced lyric edit must use the new row count.
reset();
elements.timingFrom.value = '2';
context.updateLyrics('A');
assert.equal(context.S.plan.lines.length, 3, 'fixture retains a stale preview until its scheduled replan');
context.startTap();
assert.equal(context.S.plan.lines.length, 1);
assert.equal(context.S.tap.from, 0);
assert.ok(Number.isFinite(seeks.at(-1)) && seeks.at(-1) >= 0, 'outdated row selection cannot produce a NaN seek');
assert.equal(elements.tapLine.textContent, '1. A');
context.tapNow();
assert.equal(context.S.tap, null);
assert.deepEqual(actualStarts(), [8]);

reset();
context.updateLyrics('');
context.startTap();
assert.equal(context.S.tap, null, 'a stale nonempty preview cannot start tapping after all lyrics were deleted');
assert.equal(seeks.length, 0);

// Range edits act immediately and keep relative intervals plus anchor classification.
reset();
const beforeRange = JSON.stringify(context.S.project.timing);
context.changeTimingRange(2, 26);
assert.deepEqual(actualStarts(), [2, 10, 18]);
assert.deepEqual(Object.keys(context.S.project.timing.lineTimes), ['1']);
assert.equal(context.S.project.timing.autoEnd, 26);
assert.equal(context.S.project.timing.ignoreLrc, true);
assert.equal(JSON.stringify(vm.runInContext('timingUndo', context)), beforeRange, 'range edit has a complete undo snapshot');

reset();
context.S.project.lyrics = '[00:02]A\n[00:10]B\n[00:20]C';
context.S.project.timing.lineTimes = { 1: 12 };
context.replan();
context.changeTimingRange(4, 28);
actualStarts().forEach((actual, i) => close(actual, [4, 4 + 10 / 28 * 24, 4 + 18 / 28 * 24][i]));
assert.deepEqual(Object.keys(context.S.project.timing.lineTimes), ['0', '1', '2'], 'transformed LRC timestamps remain explicit anchors');
assert.equal(context.S.project.timing.ignoreLrc, true, 'old source LRC timestamps cannot override transformed times');

reset();
context.S.audio = null;
delete context.S.project.timing.autoEnd;
context.replan();
const oldEnd = context.effectiveTiming().ends.at(-1);
context.changeTimingRange(5, '');
assert.deepEqual(actualStarts(), [5, 15, 25]);
close(context.S.project.timing.autoEnd, oldEnd + 5);

reset();
const beforeInvalidRange = JSON.stringify(context.S.project.timing);
elements.autoStart.value = '40'; elements.autoEnd.value = '20';
context.changeTimingRange(40, 20);
assert.equal(JSON.stringify(context.S.project.timing), beforeInvalidRange, 'invalid range cannot partially mutate timing');
assert.equal(elements.autoStart.value, '0');
assert.equal(elements.autoEnd.value, '30');
assert.match(elements.timingStatus.textContent, /歌い始め/);
context.changeTimingRange(1, 31);
assert.equal(JSON.stringify(context.S.project.timing), beforeInvalidRange, 'range must remain inside audio duration');

// Selected bulk shifts leave unselected rows unchanged and preserve anchor types.
reset();
elements.timingFrom.value = '1'; elements.timingTo.value = '2';
context.shiftTiming(2);
assert.deepEqual(actualStarts(), [0, 12, 22]);
assert.deepEqual(Object.keys(context.S.project.timing.lineTimes), ['1']);
assert.equal(context.S.project.timing.lineTimes[1], 12);
assert.equal(context.S.project.timing.autoEnd, 30, 'last-row shift caps the singing end to the song');
const beforeInvalidShift = JSON.stringify(context.S.project.timing);
context.shiftTiming(11, 1, 1);
assert.equal(JSON.stringify(context.S.project.timing), beforeInvalidShift, 'crossing the next row rejects the whole shift');
context.shiftTiming(-1, 0, 0);
assert.equal(JSON.stringify(context.S.project.timing), beforeInvalidShift, 'crossing zero rejects the whole shift');
context.shiftTiming(-2, 1, 2);
assert.deepEqual(actualStarts(), [0, 10, 20]);
assert.equal(context.S.project.timing.autoEnd, 28, 'shifting the final row shifts its end too');

// A strong anchor may cross provisional neighbours, but never true anchors.
reset();
playbackTime = 25;
context.anchorLineNow(1);
assert.equal(context.S.project.timing.lineTimes[1], 25);
assert.ok(actualStarts()[2] > 25 && actualStarts()[2] < 30);
reset();
context.S.project.timing.lineTimes = { 2: 20 };
const beforeAnchorConflict = JSON.stringify(context.S.project.timing);
playbackTime = 25;
context.anchorLineNow(1);
assert.equal(JSON.stringify(context.S.project.timing), beforeAnchorConflict);
reset();
playbackTime = 3.237;
context.anchorLineNow(0);
assert.equal(actualStarts()[0], 3.237);
assert.equal(context.S.project.timing.autoStart, 3.237);
assert.equal(context.S.project.timing.lineTimes[1], 10);

reset();
context.S.project.lyrics = '[00:00]A\n[00:05]B\n[00:20]C';
Object.assign(context.S.project.timing, { ignoreLrc: true, lineTimes: { 1: 12 }, spacing: 'equal', snapStrength: 0 });
context.releaseLineTime(1);
assert.equal(context.S.project.timing.lineTimes[1], undefined);
assert.deepEqual(actualStarts(), [0, 10, 20], 'released anchor is reallocated instead of reviving raw LRC');

// Explicit replacement clears both manual and imported LRC anchors.
reset();
context.S.project.lyrics = '[00:02]A\n[00:05]B\n[00:20]C';
context.S.project.timing.lineTimes = { 1: 12 };
elements.timingMode.value = 'replace'; elements.timingSpacing.value = 'equal'; elements.timingSnap.value = '0';
elements.autoStart.value = '1'; elements.autoEnd.value = '28';
context.autoTiming();
assert.deepEqual(actualStarts(), [1, 10, 19]);
assert.deepEqual(Object.keys(context.S.project.timing.lineTimes), []);
assert.equal(context.S.project.timing.ignoreLrc, true);
assert.equal(context.S.project.timing.spacing, 'equal');
assert.equal(context.S.project.timing.snapStrength, 0);

reset();
context.S.project.timing.lineTimes = { 1: 14 };
elements.timingMode.value = 'keep'; elements.timingSpacing.value = 'equal'; elements.timingSnap.value = '0';
elements.autoStart.value = '2'; elements.autoEnd.value = '26';
context.autoTiming();
assert.deepEqual(actualStarts(), [2, 14, 20]);
assert.equal(context.S.project.timing.lineTimes[1], 14);

// Tapping can resume partway through the lyrics without reassigning earlier rows.
reset();
elements.timingFrom.value = '1';
context.startTap();
assert.equal(seeks.at(-1), 9, 'tap playback begins one second before the selected row');
playbackTime = 12;
context.tapNow();
context.stopTap();
assert.equal(actualStarts()[0], 0);
assert.equal(context.S.project.timing.lineTimes[1], 12);
assert.ok(actualStarts()[2] > 12);
assert.match(elements.timingStatus.textContent, /2行目から1行/);
assert.ok(Object.values(context.S.project.timing.autoTimes).every(Number.isFinite), 'partial tap never passes an undefined first timestamp');

reset();
elements.timingFrom.value = '1';
const beforeEmptyTap = JSON.stringify(context.S.project.timing);
context.startTap(); context.stopTap();
assert.equal(JSON.stringify(context.S.project.timing), beforeEmptyTap, 'starting and stopping without taps preserves all timing');

reset();
elements.timingFrom.value = '2';
context.startTap();
assert.equal(seeks.at(-1), 19);
playbackTime = 22;
context.tapNow();
assert.equal(context.S.tap, null, 'last-row tap ends the session');
assert.deepEqual(actualStarts(), [0, 10, 22]);

reset();
context.S.audio = null;
context.S.previewRate = 0.5;
assert.equal(context.currentSongTime(), 4, 'slow preview clock reports song time for accurate manual corrections');
context.S.playing = false; context.S.t = 6.25;
assert.equal(context.currentSongTime(), 6.25);

// Exercise the actual WebAudio preview clock at both supported slow speeds.
const audioClock = { S: { previewRate: 0.5 }, window: {} };
audioClock.window.AudioContext = class {
  constructor() { this.currentTime = 100; this.state = 'running'; }
  createBufferSource() { return { playbackRate: { value: 1 }, connect() {}, start() {}, stop() {}, disconnect() {} }; }
};
vm.createContext(audioClock);
const playerStart = source.indexOf('const AP = {');
const playerEnd = source.indexOf('/* ---------------- project persistence', playerStart);
vm.runInContext(source.slice(playerStart, playerEnd) + '\nglobalThis.player = AP;', audioClock);
audioClock.player.play({ duration: 30 }, 10);
assert.equal(audioClock.player.src.playbackRate.value, 0.5);
audioClock.player.ctx.currentTime += 4;
assert.equal(audioClock.player.time(), 12, 'four wall-clock seconds at half speed advance two song seconds');
audioClock.S.previewRate = 0.75;
audioClock.player.play({ duration: 30 }, 12);
assert.equal(audioClock.player.time(), 12, 'restarting at a different preview rate preserves the song position');
audioClock.player.ctx.currentTime += 4;
assert.equal(audioClock.player.time(), 15);

const actualEnds = () => Array.from(context.effectiveTiming().ends);
function gapped() {
  reset();
  Object.assign(context.S.project.timing, { lineEnds: { 0: 4, 1: 14, 2: 24 }, autoEnd: 24 });
  context.S.audio.bpm = 120;
  context.replan(); context.syncUI();
}

// Per-row end and duration edits affect that row alone, preserving real gaps.
gapped();
context.setLineEnd(0, 3);
assert.deepEqual(actualStarts(), [0, 10, 20]);
assert.deepEqual(actualEnds(), [3, 14, 24]);
context.setLineDuration(1, 6);
assert.deepEqual(actualStarts(), [0, 10, 20]);
assert.deepEqual(actualEnds(), [3, 16, 24]);
const beforeBadDuration = JSON.stringify(context.S.project.timing);
for (const duration of [-1, 0, Infinity, NaN, 11]) {
  context.setLineDuration(1, duration);
  assert.equal(JSON.stringify(context.S.project.timing), beforeBadDuration, `invalid duration ${duration} must be atomic`);
}
context.setLineEnd(2, 31);
assert.equal(JSON.stringify(context.S.project.timing), beforeBadDuration, 'row end cannot exceed the song');
context.setLineEnd(1, 20);
assert.equal(actualEnds()[1], 20, 'end exactly at the next row start is allowed');

// Resizing a block scales its internal pauses and optionally moves later rows.
gapped();
const beforeStretch = JSON.stringify(context.S.project.timing);
context.stretchTiming({ from: 0, to: 1, duration: 7, moveFollowing: false });
assert.deepEqual(actualStarts(), [0, 5, 20]);
assert.deepEqual(actualEnds(), [2, 7, 24]);
assert.equal(JSON.stringify(vm.runInContext('timingUndo', context)), beforeStretch);
assert.equal(context.S.project.timing.lineTimes[1], 5, 'existing manual anchor is transformed with its block');
assert.equal(context.S.project.timing.lineTimes[2], undefined, 'resizing does not invent a manual anchor on an untouched row');

gapped();
context.stretchTiming({ from: 0, to: 1, duration: 7, moveFollowing: true });
assert.deepEqual(actualStarts(), [0, 5, 13]);
assert.deepEqual(actualEnds(), [2, 7, 17]);
assert.equal(actualStarts()[2] - actualEnds()[1], 6, 'following shift preserves the original gap after the selection');

gapped();
context.stretchTiming({ from: 1, to: 1, duration: 8, moveFollowing: true });
assert.deepEqual(actualStarts(), [0, 10, 24]);
assert.deepEqual(actualEnds(), [4, 18, 28]);
assert.equal(actualStarts()[1] - actualEnds()[0], 6, 'preceding gap stays unchanged');

gapped();
const beforeInvalidStretch = JSON.stringify(context.S.project.timing);
for (const options of [
  { from: 1, to: 1, duration: 15, moveFollowing: false },
  { from: 1, to: 1, duration: 15, moveFollowing: true },
  { from: 0, to: 1, duration: 0 },
  { from: 0, to: 1, duration: -1 },
  { from: 0, to: 1, duration: NaN },
  { from: 0, to: 1, duration: Infinity },
  { from: 2, to: 1, duration: 4 },
]) {
  context.stretchTiming(options);
  assert.equal(JSON.stringify(context.S.project.timing), beforeInvalidStretch, 'invalid stretch cannot partially change starts, ends or anchors');
}

// Existing range and offset tools must carry explicit end times along too.
gapped();
context.changeTimingRange(2, 26);
assert.deepEqual(actualStarts(), [2, 12, 22]);
assert.deepEqual(actualEnds(), [6, 16, 26]);
gapped();
context.shiftTiming(2, 1, 2);
assert.deepEqual(actualStarts(), [0, 12, 22]);
assert.deepEqual(actualEnds(), [4, 16, 26]);

// Visual timing speed changes never change the preview clock, song or export fps.
gapped();
context.S.previewRate = 0.5;
context.S.project.fps = 60;
const song = context.S.audio;
const songBefore = JSON.stringify(song);
context.applyLineSpeed(0, 2);
assert.deepEqual(actualStarts(), [0, 10, 20]);
assert.deepEqual(actualEnds(), [2, 14, 24]);
assert.equal(context.S.previewRate, 0.5);
assert.equal(context.S.project.fps, 60);
assert.equal(context.S.audio, song);
assert.equal(JSON.stringify(song), songBefore);
gapped();
elements.timingFollow.checked = true;
context.applyLineSpeed(0, 2);
assert.deepEqual(actualStarts(), [0, 8, 18]);
assert.deepEqual(actualEnds(), [2, 12, 22]);

// Bars use explicit BPM first, then project BPM, then analysed audio BPM.
gapped();
elements.timingFrom.value = '0'; elements.timingTo.value = '0';
elements.timingBars.value = '2'; elements.timingBeatsPerBar.value = '3';
elements.timingDurationBpm.value = '90';
context.stretchByBars();
assert.equal(actualEnds()[0], 4, '2 bars × 3 beats × 60/90 seconds');
elements.timingDurationBpm.value = '';
context.S.project.timing.bpm = 60;
context.stretchByBars();
assert.equal(actualEnds()[0], 6, 'project BPM supplies missing duration BPM');
context.S.project.timing.bpm = 0;
context.stretchByBars();
assert.equal(actualEnds()[0], 3, 'analysed BPM is the final fallback');

gapped();
elements.timingFrom.value = '0'; elements.timingTo.value = '1';
elements.timingSpeed.value = '2';
context.stretchBySpeed();
assert.deepEqual(actualStarts(), [0, 5, 20]);
assert.deepEqual(actualEnds(), [2, 7, 24]);

console.log('ui_timing_test: lyric edits, affine ranges, shifts, anchors, taps, visual durations/speed, bars, preview clock and atomic rollback passed');
