const LIVE_CONFIRM_MS = 650;
const LIVE_INTERVAL_MS = 2800;

export function createVoiceGuide({ synthesis, Utterance, onError, onPlayback = () => {}, useCloud = () => false, synthesize }) {
  const available = () => useCloud() ? Boolean(synthesize) : Boolean(synthesis && Utterance);
  let enabled = false;
  let rate = 1;
  let volume = 1;
  let active = null;
  let candidate = '';
  let candidateSince = 0;
  let lastCue = '';
  let lastCueAt = -Infinity;

  function cancel() {
    candidate = '';
    if (!active) return;
    const previous = active;
    active = null;
    if (previous.controller) {
      previous.controller.abort(); previous.audio?.pause();
      if (previous.url) URL.revokeObjectURL(previous.url);
    } else synthesis.cancel();
    onPlayback(false);
  }

  function reset() {
    cancel();
    lastCue = '';
    lastCueAt = -Infinity;
  }

  function speak(text) {
    if (!enabled || !text) return false;
    cancel();
    if (useCloud()) {
      const message = active = { controller: new AbortController() };
      onPlayback(true);
      const finish = () => {
        if (active !== message) return false;
        active = null;
        if (message.url) URL.revokeObjectURL(message.url);
        onPlayback(false); return true;
      };
      Promise.resolve().then(() => synthesize(text, rate, message.controller.signal)).then(blob => {
        if (active !== message) return;
        message.url = URL.createObjectURL(blob);
        const audio = message.audio = new Audio(message.url);
        audio.volume = volume;
        audio.onended = finish;
        audio.onerror = () => { if (finish()) onError(new Error('云端音频播放失败，请重试。')); };
        return audio.play();
      }).catch(error => { if (finish() && error.name !== 'AbortError') onError(error); });
      return true;
    }
    const message = new Utterance(text);
    active = message;
    message.lang = 'zh-CN';
    message.rate = rate;
    message.volume = volume;
    function finish() {
      if (active !== message) return false;
      active = null;
      onPlayback(false);
      return true;
    }
    message.onend = finish;
    message.onerror = () => {
      if (finish()) onError();
    };
    onPlayback(true);
    try {
      synthesis.speak(message);
      return true;
    } catch {
      finish();
      onError();
      return false;
    }
  }

  return {
    get available() { return available(); },
    get enabled() { return enabled; },
    setEnabled(value) { enabled = available() && value; reset(); },
    configure(options) {
      if (Number.isFinite(options.rate)) rate = Math.min(2, Math.max(.5, options.rate));
      if (Number.isFinite(options.volume)) volume = Math.min(1, Math.max(0, options.volume));
    },
    cancel,
    reset,
    speak,
    observe(text, now = performance.now()) {
      if (!enabled) return;
      if (text !== candidate) {
        candidate = text;
        candidateSince = now;
        return;
      }
      if (!text || active || text === lastCue || now - candidateSince < LIVE_CONFIRM_MS || now - lastCueAt < LIVE_INTERVAL_MS) return;
      if (speak(text)) {
        lastCue = text;
        lastCueAt = now;
      }
    },
  };
}

const LISTEN_AGAIN_MS = 350;
const CLEAR_ACTION = '(?:清除|清空|清掉|清理|删除|删掉|重置)';
const INPUT_TARGET = '(?:当前|这个|刚才的)?(?:输入框|文本框|框|输入|文字|文本|内容)(?:(?:里|内)(?:的)?(?:文字|文本|内容)?|的(?:文字|文本|内容))?';
const CLEAR_INPUT = new RegExp(
  '^(?:' + CLEAR_ACTION + '(?:一下)?(?:' + INPUT_TARGET + ')?|(?:把|将)' + INPUT_TARGET + CLEAR_ACTION + ')$',
);

function isClearInputCommand(transcript) {
  const phrase = transcript.replace(/[\s，。！？、；：,.!?;:]/g, '')
    .replace(/^(?:请你?|麻烦你?)?(?:帮我)?/, '')
    .replace(/(?:一下)?[吧啊呀]?$/, '');
  return CLEAR_INPUT.test(phrase) || /^(?:重来(?:一次|一遍)?|重新来(?:一次|一遍)?|再来(?:一次|一遍))$/.test(phrase);
}

export function dispatchSpeechText(text, onText, onCommand) {
  if (isClearInputCommand(text)) { onText(''); return; }
  onText(text);
  onCommand(text);
}

export function createSpeechInput({ Recognition, onState, onText, onCommand }) {
  let handsFree = false;
  let playing = false;
  let session = null;
  let timer;

  function report(message = '') {
    onState({ handsFree, listening: Boolean(session?.listening && !session.cancelled), message });
  }

  function retry() {
    clearTimeout(timer);
    if (handsFree && !playing && !session) timer = setTimeout(start, LISTEN_AGAIN_MS);
  }

  function abortSession() {
    if (!session || session.cancelled) return;
    const active = session;
    active.cancelled = true;
    try { active.engine.abort(); }
    catch { active.engine.onend(); }
  }

  function stop(message = '') {
    clearTimeout(timer);
    handsFree = false;
    abortSession();
    report(message);
  }

  function start() {
    if (!Recognition || session || playing) return;
    const engine = new Recognition();
    const active = session = { engine, listening: false, cancelled: false };
    let lastFinal = -1;
    engine.lang = 'zh-CN';
    engine.continuous = true;
    engine.interimResults = false;
    const valid = () => session === active && !active.cancelled;
    engine.onstart = () => {
      if (!valid()) return;
      active.listening = true;
      report();
    };
    engine.onend = () => {
      if (session !== active) return;
      session = null;
      report();
      retry();
    };
    engine.onresult = ({ results, resultIndex }) => {
      for (let i = resultIndex; valid() && i < results.length; i++) {
        const result = results[i];
        if (i <= lastFinal) continue;
        if (!result.isFinal) continue;
        lastFinal = i;
        const text = result[0].transcript.slice(0, 500);
        dispatchSpeechText(text, onText, onCommand);
      }
    };
    engine.onerror = ({ error }) => {
      if (!valid()) return;
      if (handsFree && error === 'no-speech') return;
      active.cancelled = true;
      session = null;
      const messages = {
        network: '浏览器语音服务连接失败，可以重试或使用文字。',
        'not-allowed': '请在浏览器中允许麦克风权限后重试。',
        'service-not-allowed': '浏览器未允许语音识别，请检查麦克风和语音服务设置。',
        'audio-capture': '浏览器没有找到可用麦克风。',
        'no-speech': '没有听到语音，请再试一次。',
      };
      stop(messages[error] ?? '语音识别已中断，可以重试或使用文字。');
    };
    report();
    try { engine.start(); }
    catch {
      session = null;
      stop('无法开启语音识别，请检查麦克风权限。');
    }
  }

  return {
    get available() { return Boolean(Recognition); },
    get handsFree() { return handsFree; },
    stop,
    toggleHandsFree() {
      if (handsFree) { stop(); return; }
      handsFree = true;
      if (session) abortSession();
      else start();
      report();
    },
    playback(value) {
      playing = value;
      if (playing) {
        clearTimeout(timer);
        abortSession();
      } else retry();
      if (handsFree) report(playing ? '正在播报，结束后继续听。' : '正在恢复麦克风…');
    },
  };
}
