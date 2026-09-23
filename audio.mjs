const DEFAULTS = { voice: true, sfx: true, ambience: false, volume: 0.8 };
const KEYS = { voice: 'hz.audio.voice', sfx: 'hz.audio.sfx', ambience: 'hz.audio.ambience', volume: 'hz.audio.volume' };
const SEAT_PAN = [0, 0.45, 0, -0.45];
const embeddedNode = typeof document !== 'undefined' ? document.getElementById('hz-audio') : null;
let manifestPromise;
let context = null;
let master = null;
const channelGains = {};
let unlocked = false;
let currentVoice = null;
let pendingVoicePriority = 0;
let voiceSerial = 0;
let ambienceSource = null;
let ambienceGain = null;
let ambienceStartedAt = 0;
let ambienceOffset = 0;
const sfxSources = new Set();
const buffers = new Map();
const settings = { ...DEFAULTS };
// 胡牌类喊得更响：播放时额外 +4 dB，总输出前有限幅器兜住峰值
const WIN_IDS = new Set(['win', 'selfDraw', 'gangKai']);
const WIN_BOOST = 10 ** (4 / 20);
// 人声预计念完的时刻（performance.now 毫秒）。app 排下一手时据此等一等，
// 免得上一家的牌名还没念完，下一家就出牌把它打断
let voiceBusyUntil = 0;
let manifestSync = null;

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function loadSettings() {
  settings.voice = readSetting(KEYS.voice, '1') !== '0';
  settings.sfx = readSetting(KEYS.sfx, '1') !== '0';
  settings.ambience = readSetting(KEYS.ambience, '0') === '1';
  const volume = Number(readSetting(KEYS.volume, String(DEFAULTS.volume)));
  settings.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULTS.volume;
}
function debug(kind, id, seat, played, reason = '') {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('audiodebug')) return;
  (window.__hzAudioLog ||= []).push({ t: Date.now(), kind, id, seat, played, reason });
}
function embeddedData() {
  if (!embeddedNode) return null;
  try { return JSON.parse(embeddedNode.textContent); } catch { return null; }
}
async function getManifest() {
  if (!manifestPromise) manifestPromise = (async () => {
    const embedded = embeddedData();
    if (embedded?.manifest && embedded.files) { manifestSync = embedded.manifest; return embedded; }
    const response = await fetch('assets/audio/voice/manifest.json');
    if (!response.ok) throw new Error(`音频清单读取失败：${response.status}`);
    manifestSync = await response.json();
    return { manifest: manifestSync, files: null };
  })();
  return manifestPromise;
}
/** 某条人声的时长（毫秒），清单还没读到时按 700 估。 */
function clipMs(seat, id) {
  const group = id === 'draw' ? 'narrator' : `s${seat}`;
  return manifestSync?.clips?.[group]?.[id]?.ms ?? 700;
}
/** 距离当前人声念完还有多少毫秒；人声关着或还没解锁时为 0。 */
function voiceRemainingMs() {
  if (!settings.voice || !unlocked || (typeof document !== 'undefined' && document.hidden)) return 0;
  return Math.max(0, voiceBusyUntil - performance.now());
}
async function fileUrl(path) {
  const data = await getManifest();
  if (data.files?.[path]) return data.files[path];
  return `assets/audio/${path}`;
}
async function loadBuffer(path) {
  if (buffers.has(path)) return buffers.get(path);
  const promise = (async () => {
    const url = await fileUrl(path);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`音频读取失败：${path}`);
    const bytes = await response.arrayBuffer();
    return context.decodeAudioData(bytes.slice(0));
  })();
  buffers.set(path, promise);
  try { return await promise; } catch (error) { buffers.delete(path); throw error; }
}
function ensureContext() {
  if (!context) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    context = new Ctx();
    master = context.createGain();
    master.gain.value = masterGain();
    // 限幅器：胡牌加响、多路叠在一起时不削顶
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(context.destination);
    for (const kind of ['voice', 'sfx', 'ambience']) {
      channelGains[kind] = context.createGain();
      channelGains[kind].gain.value = 1;
      channelGains[kind].connect(master);
    }
  }
  return context;
}
function channelNode(kind, seat = 0) {
  const ctx = ensureContext();
  if (!ctx) return null;
  const gain = ctx.createGain();
  const panner = ctx.createStereoPanner();
  panner.pan.value = kind === 'voice' ? (SEAT_PAN[seat] || 0) : 0;
  gain.connect(panner).connect(channelGains[kind]);
  return { gain, panner };
}
function masterGain() {
  return Math.max(0, Math.min(1, settings.volume));
}
function fadeOutVoice() {
  if (!currentVoice || !context) return;
  const { source, gain } = currentVoice;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
  try { source.stop(now + 0.025); } catch { /* already stopped */ }
  currentVoice = null;
}
function stopAmbience(fade = true, preserve = true) {
  if (!ambienceSource || !context) return;
  const source = ambienceSource;
  const gain = ambienceGain;
  if (preserve && source.buffer?.duration) ambienceOffset = (context.currentTime - ambienceStartedAt) % source.buffer.duration;
  else ambienceOffset = 0;
  ambienceSource = null;
  ambienceGain = null;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (fade ? 1.5 : 0.01));
  try { source.stop(now + (fade ? 1.55 : 0.02)); } catch { /* already stopped */ }
}
async function unlock() {
  const ctx = ensureContext();
  if (!ctx) return;
  try { await ctx.resume(); unlocked = ctx.state === 'running'; } catch { unlocked = false; }
  if (unlocked) {
    void Promise.all(['sfx/tile1.mp3', 'sfx/tile2.mp3', 'sfx/tile3.mp3', 'sfx/tile4.mp3']
      .map(path => loadBuffer(path).catch(() => null)));
    void Promise.all(['voice/s0/chi.mp3', 'voice/s0/pong.mp3', 'voice/s0/kong.mp3', 'voice/s0/win.mp3']
      .map(path => loadBuffer(path).catch(() => null)));
    if (settings.ambience) void playAmbience();
  }
}
function onUnlockGesture() { void unlock(); }
if (typeof document !== 'undefined') {
  loadSettings();
  document.addEventListener('pointerdown', onUnlockGesture, { passive: true });
  document.addEventListener('keydown', onUnlockGesture, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { fadeOutVoice(); for (const source of sfxSources) { try { source.stop(); } catch {} } sfxSources.clear(); stopAmbience(false); }
    else if (settings.ambience && unlocked) void playAmbience();
  });
}

/**
 * delayMs：延后多久开口（牌名跟在落牌声后面约 80ms）。占用时间在调用当下就同步登记，
 * 这样 app 紧接着排下一手时已经能看到这段人声还要多久。
 */
async function playVoice(seat, id, priority = 1, delayMs = 0) {
  const kind = priority === 1 ? 'tile' : 'call';
  if (!settings.voice) { debug(kind, id, seat, false, 'disabled'); return; }
  if (!unlocked || (typeof document !== 'undefined' && document.hidden)) { debug(kind, id, seat, false, unlocked ? 'hidden' : 'locked'); return; }
  if ((currentVoice?.priority === 2 || pendingVoicePriority === 2) && priority === 1) { debug(kind, id, seat, false, 'call-active'); return; }
  voiceBusyUntil = Math.max(priority === 2 ? 0 : voiceBusyUntil, performance.now() + delayMs + clipMs(seat, id));
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const serial = ++voiceSerial;
  pendingVoicePriority = Math.max(pendingVoicePriority, priority);
  if (currentVoice) fadeOutVoice();
  const path = id === 'draw' ? 'voice/narrator/draw.mp3' : `voice/s${seat}/${id}.mp3`;
  try {
    const buffer = await loadBuffer(path);
    if (!unlocked || document.hidden) { if (serial === voiceSerial) pendingVoicePriority = 0; debug(kind, id, seat, false, 'hidden'); return; }
    if (serial !== voiceSerial) { debug(kind, id, seat, false, 'replaced'); return; }
    if (priority < pendingVoicePriority) { debug(kind, id, seat, false, 'call-active'); return; }
    const node = channelNode('voice', seat);
    if (!node) { if (serial === voiceSerial) pendingVoicePriority = 0; debug(kind, id, seat, false, 'unsupported'); return; }
    const source = context.createBufferSource();
    source.buffer = buffer;
    node.gain.gain.value = WIN_IDS.has(id) ? WIN_BOOST : 1;
    source.connect(node.gain);
    currentVoice = { source, gain: node.gain, priority };
    voiceBusyUntil = Math.max(voiceBusyUntil, performance.now() + buffer.duration * 1000);
    if (serial === voiceSerial) pendingVoicePriority = 0;
    source.onended = () => { if (currentVoice?.source === source) currentVoice = null; };
    source.start();
    debug(kind, id, seat, true);
  } catch (error) { if (serial === voiceSerial) pendingVoicePriority = 0; debug(kind, id, seat, false, error.message || 'load-error'); }
}
async function playTile() {
  if (!settings.sfx) { debug('sfx', 'tile', null, false, 'disabled'); return; }
  if (!unlocked || document.hidden) { debug('sfx', 'tile', null, false, unlocked ? 'hidden' : 'locked'); return; }
  const id = `tile${1 + Math.floor(Math.random() * 4)}`;
  try {
    const buffer = await loadBuffer(`sfx/${id}.mp3`);
    if (!unlocked || document.hidden) { debug('sfx', id, null, false, 'hidden'); return; }
    const node = channelNode('sfx');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 0.96 + Math.random() * 0.08;
    node.gain.gain.value = 10 ** ((Math.random() * 4 - 2) / 20);
    source.connect(node.gain);
    sfxSources.add(source);
    source.onended = () => sfxSources.delete(source);
    source.start();
    debug('sfx', id, null, true);
  } catch (error) { debug('sfx', id, null, false, error.message || 'load-error'); }
}
async function playShuffle() {
  if (!settings.sfx) { debug('sfx', 'shuffle', null, false, 'disabled'); return; }
  if (!unlocked || document.hidden) { debug('sfx', 'shuffle', null, false, unlocked ? 'hidden' : 'locked'); return; }
  try {
    const buffer = await loadBuffer('sfx/shuffle.mp3');
    if (!unlocked || document.hidden) { debug('sfx', 'shuffle', null, false, 'hidden'); return; }
    const node = channelNode('sfx');
    const source = context.createBufferSource(); source.buffer = buffer; node.gain.gain.value = 1; source.connect(node.gain); source.start();   // 总音量已由 master 管，这里不再乘一次
    debug('sfx', 'shuffle', null, true);
  } catch (error) { debug('sfx', 'shuffle', null, false, error.message || 'load-error'); }
}
async function playAmbience() {
  if (!settings.ambience) { debug('ambience', 'parlor', null, false, 'disabled'); return; }
  if (!unlocked || document.hidden || ambienceSource) return;
  try {
    const buffer = await loadBuffer('ambience/parlor.mp3');
    if (!unlocked || document.hidden || ambienceSource) return;
    const node = channelNode('ambience');
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
    node.gain.gain.setValueAtTime(0.0001, context.currentTime); node.gain.gain.exponentialRampToValueAtTime(1, context.currentTime + 1.5);
    source.connect(node.gain); source.start(0, ambienceOffset); ambienceStartedAt = context.currentTime - ambienceOffset; ambienceSource = source; ambienceGain = node.gain; debug('ambience', 'parlor', null, true);
  } catch (error) { debug('ambience', 'parlor', null, false, error.message || 'load-error'); }
}
function configure(next = {}) {
  Object.assign(settings, next);
  if (settings.ambience && unlocked && !document.hidden) void playAmbience();
  else if (!settings.ambience) stopAmbience(true, false);
  if (context && master) master.gain.setTargetAtTime(masterGain(), context.currentTime, 0.03);
}
export const audio = { playVoice, playTile, playShuffle, playAmbience, stopAmbience, configure, settings, voiceRemainingMs };
