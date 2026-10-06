'use strict';

// Live Follow (experimental) -- /live/'s own script, deliberately separate
// from app.js. app.js's entire state object exists to drive a recorded
// video's playback (scrubber, YouTube/HTML5 player, segment timestamps);
// none of that applies here. Live Follow has no video and no recording --
// it streams this device's own microphone straight to ElevenLabs' realtime
// speech-to-text over a browser-opened WebSocket (see live-token.mjs's own
// comment for why the API key itself never reaches this file) and will,
// once the next step lands, match what comes back against the daf's text
// live. For now (see Task #5) it only gets the transcript pipeline itself
// working end-to-end: mic -> resample -> ElevenLabs -> partial/committed
// transcript, visible in the debug panel. There is deliberately no fuzzy
// matcher or Vilna-page highlighting wired up yet.

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
// Same fixed, daf-independent discourse-marker list voice_align.py's own
// COMMON_GEMARA_TERMS seeds every batch sync with (see that file) -- a
// cheap, free starting point for realtime's much tighter 50-keyterm cap.
// Per-daf keyterms (names, rare words actually appearing on THIS daf, the
// bulk of what build_keyterm_list() picks for batch) need the daf's own
// canonical word list, which Live Follow doesn't fetch yet -- that lands
// together with the matcher in the next step, since both need the same data.
const COMMON_GEMARA_TERMS = [
  'תא שמע', 'איתמר', 'תניא', 'מתניתין', 'גמרא', 'אמר מר', 'מאי טעמא',
  'והתניא', 'אמר רבא', 'אמר אביי', 'בעי מיניה', 'איבעיא להו',
];
// ElevenLabs recommends 16kHz mono for realtime STT as the right bandwidth/
// quality tradeoff; pcm_16000 (the audio_format below) is 16-bit signed
// little-endian PCM at that rate, which is what everything in this file's
// audio pipeline is built to produce.
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms at 16kHz -- small enough to feel live, large enough not to spam the socket
const MAX_RECONNECT_DELAY_MS = 10000;
const PREVIOUS_TEXT_CHARS = 300; // how much committed context survives a reconnect

function $(id) { return document.getElementById(id); }

let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', type === 'error');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), Math.min(12000, Math.max(3200, 1200 + message.length * 60)));
}

// ---- Audio pipeline ---------------------------------------------------
// AudioWorkletProcessor that does nothing but batch raw Float32 frames and
// hand them to the main thread every ~2048 samples (~46ms at 44.1kHz) --
// small enough for low latency, large enough that postMessage isn't called
// on every single 128-sample render quantum. Loaded from a Blob URL so the
// whole pipeline stays in this one file rather than needing a second
// script the page has to fetch and keep in sync.
const MIC_WORKLET_SOURCE = `
class LiveMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._bufferedLength = 0;
    this._flushAt = 2048;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this._chunks.push(channel.slice());
      this._bufferedLength += channel.length;
      if (this._bufferedLength >= this._flushAt) {
        const merged = new Float32Array(this._bufferedLength);
        let offset = 0;
        for (const chunk of this._chunks) { merged.set(chunk, offset); offset += chunk.length; }
        this.port.postMessage(merged);
        this._chunks = [];
        this._bufferedLength = 0;
      }
    }
    return true;
  }
}
registerProcessor('live-mic-processor', LiveMicProcessor);
`;

// Plain linear interpolation, not a proper windowed-sinc resampler --
// cheap, dependency-free, and fuzzy phonetic matching downstream doesn't
// need audiophile-grade output. Each call resamples independently (no
// carried-over fractional phase across chunk boundaries), which can leave a
// sub-millisecond seam every ~46ms; inaudible-to-ASR in practice, not worth
// the extra bookkeeping for this experiment.
function resampleLinear(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(float32.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = srcIndex - i0;
    result[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0, offset = 0; i < float32.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // String.fromCharCode.apply chokes on very large arg lists
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

// ---- Live Follow session ----------------------------------------------
const live = {
  micStream: null,
  audioContext: null,
  workletNode: null,
  ws: null,
  resampleTail: new Float32Array(0), // leftover resampled-but-not-yet-sent samples
  manualStop: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  firstChunkSentThisConnection: false,
  previousText: '', // rolling committed-transcript tail, carried across reconnects
  ref: '',
};

function setStatus(kind, text, detail) {
  const dot = $('liveStatusDot');
  const label = $('liveStatusText');
  const detailEl = $('liveStatusDetail');
  if (dot) dot.className = `status-dot${kind ? ' ' + kind : ''}`;
  if (label) label.textContent = text;
  if (detailEl) detailEl.textContent = detail || '';
}

function setMicLevel(level) {
  const fill = $('liveMicMeterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, level * 100))}%`;
}

function setDebug(field, value) {
  const el = $(`liveDebug${field}`);
  if (el) el.textContent = value === undefined || value === null || value === '' ? '—' : value;
}

function appendPreviousText(text) {
  if (!text) return;
  live.previousText = (live.previousText + ' ' + text).trim().slice(-PREVIOUS_TEXT_CHARS);
}

async function fetchLiveToken() {
  const response = await fetch('/api/live-token', { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(body.error || 'Could not get a Live Follow token.');
  return body.token;
}

function buildWsUrl(token) {
  const params = new URLSearchParams();
  params.set('model_id', 'scribe_v2_realtime');
  params.set('audio_format', 'pcm_16000');
  // 'vad' (server-side voice-activity detection) rather than 'manual' -- the
  // server decides when a committed_transcript boundary happens (e.g. the
  // maggid shiur pausing between phrases), so the client never has to send
  // its own commit signal. See input_audio_chunk's own 'commit' field below,
  // which this file always sends as false for exactly that reason.
  params.set('commit_strategy', 'vad');
  // Talmudic Hebrew/Aramaic is the primary signal; English is the realistic
  // secondary language for a maggid shiur's own explanation in between.
  params.set('language_code', 'he');
  params.append('secondary_languages', 'en');
  params.set('include_language_detection', 'true');
  // NOTE: array query params are sent here as repeated keys
  // (keyterms=a&keyterms=b), the most common convention -- unconfirmed
  // against ElevenLabs' actual parser since this hasn't been exercised
  // against a real API key yet. If keyterms turn out silently ignored,
  // this is the first thing to check.
  for (const term of COMMON_GEMARA_TERMS) params.append('keyterms', term);
  params.set('token', token);
  return `${ELEVENLABS_WS_BASE}?${params.toString()}`;
}

function clearReconnectTimer() {
  if (live.reconnectTimer) {
    clearTimeout(live.reconnectTimer);
    live.reconnectTimer = null;
  }
}

async function connectWebSocket() {
  clearReconnectTimer();
  let token;
  try {
    token = await fetchLiveToken();
  } catch (error) {
    setStatus('error', 'Error', error.message);
    showToast(error.message, 'error');
    scheduleReconnect();
    return;
  }
  if (live.manualStop) return; // Stop was clicked while the token request was in flight

  live.firstChunkSentThisConnection = true; // next chunk sent is this connection's first
  const ws = new WebSocket(buildWsUrl(token));
  live.ws = ws;

  ws.addEventListener('open', () => {
    setDebug('Connection', 'Connected, waiting for session_started…');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        live.reconnectAttempt = 0;
        setStatus('listening', 'Listening', `Following ${live.ref}`);
        setDebug('Connection', `session ${msg.session_id || ''} started`);
        break;
      case 'partial_transcript':
        setDebug('Partial', msg.text);
        break;
      case 'committed_transcript':
        setDebug('Partial', '—');
        setDebug('Committed', msg.text);
        appendPreviousText(msg.text);
        break;
      // Matcher isn't wired up yet (see this file's header comment and
      // Task #5) -- committed_transcript_with_timestamps/_entities and
      // edited_transcript aren't requested yet, so they're not handled.
      default:
        if (String(msg.message_type || '').includes('error') || msg.error) {
          console.error('[live] ElevenLabs error:', msg);
          showToast(msg.error || `Live Follow error: ${msg.message_type}`, 'error');
        }
        break;
    }
  });

  ws.addEventListener('close', (event) => {
    if (live.ws !== ws) return; // a newer connection already replaced this one
    live.ws = null;
    if (live.manualStop) return;
    setStatus('searching', 'Reconnecting…', `Lost the connection (code ${event.code}) -- retrying`);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // onclose always follows onerror for a WebSocket -- the close handler
    // above is where reconnect actually gets scheduled.
    console.error('[live] WebSocket error on the ElevenLabs connection.');
  });
}

function scheduleReconnect() {
  if (live.manualStop) return;
  clearReconnectTimer();
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** live.reconnectAttempt);
  live.reconnectAttempt += 1;
  live.reconnectTimer = setTimeout(connectWebSocket, delay);
}

function sendAudioChunk(int16Buffer) {
  const ws = live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const message = {
    message_type: 'input_audio_chunk',
    audio_base_64: arrayBufferToBase64(int16Buffer),
    commit: false, // commit_strategy=vad: the server decides, never the client
    sample_rate: TARGET_SAMPLE_RATE,
  };
  if (live.firstChunkSentThisConnection) {
    message.previous_text = live.previousText;
    live.firstChunkSentThisConnection = false;
  }
  ws.send(JSON.stringify(message));
}

function handleRawMicFrames(float32AtNativeRate) {
  setMicLevel(Math.min(1, rms(float32AtNativeRate) * 6));
  const resampled = resampleLinear(float32AtNativeRate, live.audioContext.sampleRate, TARGET_SAMPLE_RATE);
  let combined = resampled;
  if (live.resampleTail.length) {
    combined = new Float32Array(live.resampleTail.length + resampled.length);
    combined.set(live.resampleTail, 0);
    combined.set(resampled, live.resampleTail.length);
  }
  let offset = 0;
  while (combined.length - offset >= CHUNK_SAMPLES) {
    sendAudioChunk(floatTo16BitPCM(combined.subarray(offset, offset + CHUNK_SAMPLES)));
    offset += CHUNK_SAMPLES;
  }
  live.resampleTail = combined.slice(offset);
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access (or the page was not loaded over HTTPS).');
  }
  live.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  // Not relying on { sampleRate: 16000 } in the AudioContext constructor
  // actually producing 16kHz -- some browsers (notably older Safari) are
  // known to ignore that option and keep the hardware rate. Reading back
  // audioContext.sampleRate after construction and resampling in
  // handleRawMicFrames regardless is what actually guarantees pcm_16000,
  // whatever the browser decided to give us.
  live.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const blobUrl = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await live.audioContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const source = live.audioContext.createMediaStreamSource(live.micStream);
  live.workletNode = new AudioWorkletNode(live.audioContext, 'live-mic-processor');
  live.workletNode.port.onmessage = (event) => handleRawMicFrames(event.data);
  source.connect(live.workletNode);
  // Deliberately not connected onward to audioContext.destination -- this
  // pipeline only ever reads the mic, it never needs to play it back.
}

function stopMic() {
  live.workletNode?.port && (live.workletNode.port.onmessage = null);
  live.workletNode?.disconnect();
  live.workletNode = null;
  live.audioContext?.close().catch(() => {});
  live.audioContext = null;
  live.micStream?.getTracks().forEach((track) => track.stop());
  live.micStream = null;
  live.resampleTail = new Float32Array(0);
  setMicLevel(0);
}

async function startLiveFollow() {
  const ref = $('liveRefInput').value.trim();
  if (!ref) {
    showToast('Enter a daf reference first.', 'error');
    return;
  }
  live.ref = ref;
  live.manualStop = false;
  live.reconnectAttempt = 0;
  live.previousText = '';
  const button = $('liveStartButton');
  button.disabled = true;
  setStatus('', 'Connecting…', 'Requesting microphone access');
  try {
    await startMic();
  } catch (error) {
    console.error('Could not open the microphone for Live Follow:', error);
    const deniedLikely = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    setStatus('error', 'Error', deniedLikely ? 'Microphone access was denied.' : error.message);
    showToast(deniedLikely ? 'Microphone access was denied.' : error.message, 'error');
    button.disabled = false;
    return;
  }
  button.disabled = false;
  button.textContent = 'Stop Live Follow';
  button.classList.add('stop');
  setStatus('searching', 'Connecting…', 'Opening the transcription connection');
  await connectWebSocket();
}

function stopLiveFollow() {
  live.manualStop = true;
  clearReconnectTimer();
  live.ws?.close();
  live.ws = null;
  stopMic();
  const button = $('liveStartButton');
  button.textContent = 'Start Live Follow';
  button.classList.remove('stop');
  setStatus('', 'Idle', 'Choose a daf and tap Start.');
  setDebug('Partial', '—');
  setDebug('Connection', '—');
}

$('liveStartButton')?.addEventListener('click', () => {
  if (live.ws || live.micStream) stopLiveFollow();
  else startLiveFollow();
});

window.addEventListener('beforeunload', () => {
  if (live.ws || live.micStream) stopLiveFollow();
});
