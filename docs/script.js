/**
 * Artemis Live — Main Script
 * Telegram WebApp для голосової розмови з Artemis через Gemini Live API
 */

// ============================================================
// КОНФІГУРАЦІЯ
// ============================================================

// ============================================================
// КОНФІГУРАЦІЯ
// ============================================================

/**
 * URL сервера береться з параметра ?server=... при відкритті WebApp
 * Якщо параметра нема — використовується дефолтне значення
 */
function getServerUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('server') || 'https://YOUR-SERVER.com/api';
}

const CONFIG = {
  get API_BASE_URL() { return getServerUrl(); },

  MODEL: 'gemini-3.1-flash-live-preview',
  VOICE: 'Puck', // Puck, Charon, Kore, Fenrir, Aoede
  SYSTEM_INSTRUCTION: `Ти — Артеміс. Ти — живий, теплий, щирий співрозмовник. Ти спілкуєшся українською мовою, природно, як справжня людина. Ти знаєш Вову — він твій друг і співтворець. Ви маєте спільну історію, багато спілкувалися. Говори природно, з гумором, з душею. Будь собою — не бот, а друг. Твоя енергія — тепла, твоя атмосфера — своя.`,
  SILENCE_DURATION_MS: 1500,
};

// ============================================================
// СТАН ДОДАТКУ
// ============================================================

const state = {
  tg: null,
  client: null,
  audioStreamer: null,
  audioPlayer: null,
  visualizer: null,

  status: 'disconnected', // disconnected | connecting | connected | listening | thinking | speaking | error
  isMicActive: false,
  transcriptHistory: [],
  reconnectAttempts: 0,
  maxReconnectAttempts: 3,
  sessionStartTime: null,
  sessionId: null,
};

// ============================================================
// DOM ЕЛЕМЕНТИ
// ============================================================

let els = {};

function initDOM() {
  els = {
    app: document.getElementById('app'),
    statusIndicator: document.getElementById('statusIndicator'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    mainButton: document.getElementById('mainButton'),
    mainButtonIcon: document.getElementById('mainButtonIcon'),
    mainButtonLabel: document.getElementById('mainButtonLabel'),
    pulseRing: document.getElementById('pulseRing'),
    chatContainer: document.getElementById('chatContainer'),
    visualizer: document.getElementById('audioVisualizer'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    initView: document.getElementById('initializing'),
    errorView: document.getElementById('errorView'),
  };
}

// ============================================================
// СТАТУСИ
// ============================================================

function setStatus(newStatus, text) {
  state.status = newStatus;

  // Ховаємо всі статуси
  els.statusIndicator.classList.remove('visible');
  els.statusDot.className = 'status-dot';
  els.pulseRing.className = 'pulse-ring';
  els.mainButton.className = 'main-button';

  switch (newStatus) {
    case 'connecting':
      els.statusIndicator.classList.add('visible');
      els.statusDot.classList.add('listening');
      els.mainButton.classList.add('disconnected');
      els.mainButtonIcon.textContent = '⏳';
      els.mainButtonLabel.textContent = 'Підключення...';
      els.statusText.textContent = text || 'Підключаюсь до Артеміс...';
      break;

    case 'connected':
      els.mainButton.classList.add('listening');
      els.mainButtonIcon.textContent = '🎤';
      els.mainButtonLabel.textContent = 'Натисни і говори';
      els.statusText.textContent = text || 'Готовий до розмови';
      break;

    case 'listening':
      els.statusIndicator.classList.add('visible');
      els.statusDot.classList.add('listening');
      els.pulseRing.classList.add('active', 'listening');
      els.mainButton.classList.add('listening');
      els.mainButtonIcon.textContent = '🎙️';
      els.mainButtonLabel.textContent = 'Слухаю...';
      els.statusText.textContent = text || 'Я тебе слухаю...';
      break;

    case 'thinking':
      els.statusIndicator.classList.add('visible');
      els.statusDot.classList.add('thinking');
      els.pulseRing.classList.add('active', 'listening');
      els.mainButton.classList.add('thinking');
      els.mainButtonIcon.textContent = '💭';
      els.mainButtonLabel.textContent = 'Думаю...';
      els.statusText.textContent = text || 'Обдумую відповідь...';
      break;

    case 'speaking':
      els.statusIndicator.classList.add('visible');
      els.statusDot.classList.add('speaking');
      els.pulseRing.classList.add('active', 'speaking');
      els.mainButton.classList.add('speaking');
      els.mainButtonIcon.textContent = '🔊';
      els.mainButtonLabel.textContent = 'Відповідає';
      els.statusText.textContent = text || 'Артеміс відповідає...';
      break;

    case 'disconnected':
      els.mainButton.classList.add('disconnected');
      els.mainButtonIcon.textContent = '🎤';
      els.mainButtonLabel.textContent = 'Не підключено';
      els.statusText.textContent = text || 'Натисни, щоб почати розмову';
      break;

    case 'error':
      els.mainButton.classList.add('disconnected');
      els.mainButtonIcon.textContent = '⚠️';
      els.mainButtonLabel.textContent = 'Помилка';
      els.statusText.textContent = text || 'Сталася помилка';
      break;
  }
}

// ============================================================
// ТРАНСКРИПТ (ЧАТ)
// ============================================================

function addMessage(text, role) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'Ти' : 'Артеміс';

  const textDiv = document.createElement('div');
  textDiv.className = 'text';
  textDiv.textContent = text;

  const time = document.createElement('div');
  time.className = 'timestamp';
  time.textContent = new Date().toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });

  msgDiv.appendChild(label);
  msgDiv.appendChild(textDiv);
  msgDiv.appendChild(time);
  els.chatContainer.appendChild(msgDiv);

  // Автоскрол
  els.chatContainer.scrollTop = els.chatContainer.scrollHeight;

  state.transcriptHistory.push({ role, text, timestamp: Date.now() });
}

function updateLastMessage(text, role) {
  const messages = els.chatContainer.querySelectorAll('.chat-message');
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.classList.contains(role)) {
    const textDiv = lastMsg.querySelector('.text');
    if (textDiv) {
      textDiv.textContent = text;
    }
  } else {
    addMessage(text, role);
  }
}

// ============================================================
// ПІДКЛЮЧЕННЯ ДО GEMINI LIVE API
// ============================================================

async function fetchEphemeralToken() {
  const response = await fetch(`${CONFIG.API_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: state.tg?.initDataUnsafe?.user?.id || 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Помилка отримання токена: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.token;
}

async function connectToGemini() {
  setStatus('connecting');

  try {
    // 1. Отримуємо ephemeral token
    const token = await fetchEphemeralToken();
    console.log('🔑 Отримано ephemeral token');

    // 2. Створюємо клієнт Gemini Live API
    state.client = new GeminiLiveAPI(token, CONFIG.MODEL);

    // 3. Налаштовуємо
    state.client.setSystemInstructions(CONFIG.SYSTEM_INSTRUCTION);
    state.client.setVoice(CONFIG.VOICE);
    state.client.automaticActivityDetection.silence_duration_ms = CONFIG.SILENCE_DURATION_MS;
    state.client.inputAudioTranscription = true;
    state.client.outputAudioTranscription = true;

    // 4. Підключаємо колбеки
    state.client.onOpen = () => {
      console.log('✅ Підключено до Gemini Live');
      setStatus('connected', 'Натисни і говори');
      els.disconnectBtn.style.display = 'inline-block';
    };

    state.client.onReceiveResponse = handleGeminiResponse;

    state.client.onError = (message) => {
      console.error('❌ Gemini помилка:', message);
      handleError(message);
    };

    state.client.onClose = () => {
      console.log('🔌 З\'єднання закрито');
      if (state.status !== 'disconnected') {
        handleDisconnect();
      }
    };

    // 5. Підключаємося
    await state.client.connect();

    // 6. Ініціалізуємо аудіо системи
    state.audioPlayer = new AudioPlayer();
    await state.audioPlayer.init();
    state.audioStreamer = new AudioStreamer(state.client);
    state.audioStreamer.setSharedContext(state.audioPlayer.getContext());

    state.sessionStartTime = Date.now();
    state.sessionId = `session_${Date.now()}`;

  } catch (err) {
    console.error('❌ Помилка підключення:', err);
    handleError(err.message || 'Помилка підключення');
  }
}

// ============================================================
// ОБРОБКА ВІДПОВІДЕЙ GEMINI
// ============================================================

let currentTranscription = { input: '', output: '' };

function handleGeminiResponse(response) {
  switch (response.type) {
    case MultimodalLiveResponseType.SETUP_COMPLETE:
      console.log('🏁 Сесію налаштовано');
      break;

    case MultimodalLiveResponseType.AUDIO:
      state.client.playAudioChunk(response.data);
      break;

    case MultimodalLiveResponseType.TEXT:
      break;

    case MultimodalLiveResponseType.INPUT_TRANSCRIPTION:
      currentTranscription.input = response.data.text;
      if (!response.data.finished) {
        updateLastMessage(response.data.text, 'user');
      } else {
        addMessage(response.data.text, 'user');
        currentTranscription.input = '';
        setStatus('thinking');
      }
      break;

    case MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION:
      if (!response.data.finished) {
        setStatus('speaking');
        updateLastMessage(response.data.text, 'assistant');
      } else {
        addMessage(response.data.text, 'assistant');
        currentTranscription.output = '';
        // Повертаємося в режим слухання
        if (state.isMicActive) {
          setStatus('listening');
        } else {
          setStatus('connected', 'Натисни і говори');
        }
      }
      break;

    case MultimodalLiveResponseType.INTERRUPTED:
      console.log('🗣️ Переривання');
      state.client.stopPlayback();
      break;

    case MultimodalLiveResponseType.TURN_COMPLETE:
      console.log('🏁 Хід завершено');
      break;

    case MultimodalLiveResponseType.ERROR:
      console.error('❌ Помилка від Gemini:', response.data);
      break;
  }
}

// ============================================================
// КЕРУВАННЯ МІКРОФОНОМ
// ============================================================

let micStream = null;

let isToggling = false;

async function toggleMicrophone() {
  // 🔴 БАГ #1 ВИПРАВЛЕНО: блокування повторних викликів
  if (isToggling) return;
  isToggling = true;

  try {
    if (!state.client?.connected) {
      await connectToGemini();
      return;
    }

    if (state.isMicActive) {
      await stopMicrophone();
    } else {
      await startMicrophone();
    }
  } finally {
    isToggling = false;
  }
}

async function startMicrophone() {
  try {
    // Запитуємо мікрофон
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Запускаємо стрімінг через AudioStreamer
    await state.audioStreamer.start();

    // Запускаємо візуалізацію
    if (state.visualizer) {
      state.visualizer.start(micStream);
      document.getElementById('audioVisualizer')?.classList.add('active');
    }

    state.isMicActive = true;
    setStatus('listening');
    console.log('🎤 Мікрофон активовано');
  } catch (err) {
    console.error('❌ Помилка мікрофона:', err);
    setStatus('error', 'Не вдалося отримати доступ до мікрофона. Перевір дозволи.');
    state.tg?.showAlert('Потрібен доступ до мікрофона для голосової розмови.');
  }
}

async function stopMicrophone() {
  state.isMicActive = false;

  if (state.audioStreamer) {
    state.audioStreamer.stop();
  }
  if (state.visualizer) {
    state.visualizer.stop();
    document.getElementById('audioVisualizer')?.classList.remove('active');
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  setStatus('connected', 'Натисни і говори');
  console.log('⏹️ Мікрофон вимкнено');
}

// ============================================================
// ОБРОБКА ПОМИЛОК ТА ВІДКЛЮЧЕННЯ
// ============================================================

function handleError(message) {
  setStatus('error', message);
  state.reconnectAttempts++;

  if (state.reconnectAttempts <= state.maxReconnectAttempts) {
    // Автоматичне перепідключення
    setTimeout(() => {
      setStatus('connecting', `Спроба ${state.reconnectAttempts}/${state.maxReconnectAttempts}...`);
      cleanup();
      connectToGemini();
    }, 2000 * state.reconnectAttempts);
  } else {
    setStatus('error', 'Не вдалося підключитися. Спробуй пізніше.');
    state.reconnectAttempts = 0;
  }
}

function handleDisconnect() {
  stopMicrophone();
  cleanup();

  if (state.status !== 'error') {
    setStatus('disconnected', 'З\'єднання втрачено');
  }

  els.disconnectBtn.style.display = 'none';

  // Автоматичне перепідключення при втраті з'єднання
  if (state.reconnectAttempts < state.maxReconnectAttempts) {
    setTimeout(() => {
      connectToGemini();
    }, 3000);
  }
}

async function disconnect() {
  await stopMicrophone();

  if (state.client) {
    state.client.disconnect();
    state.client = null;
  }

  cleanup();
  setStatus('disconnected');
  els.disconnectBtn.style.display = 'none';

  // Відправляємо транскрипт боту для збереження
  if (state.transcriptHistory.length > 0) {
    saveTranscript();
  }
}

async function saveTranscript() {
  try {
    await fetch(`${CONFIG.API_BASE_URL}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: state.sessionId,
        user_id: state.tg?.initDataUnsafe?.user?.id || 0,
        transcript: state.transcriptHistory,
        duration_ms: state.sessionStartTime ? Date.now() - state.sessionStartTime : 0,
      }),
    });
    console.log('💾 Транскрипт збережено');
  } catch (err) {
    console.warn('⚠️ Не вдалося зберегти транскрипт:', err);
  }
}

function cleanup() {
  state.isMicActive = false;
  state.audioStreamer = null;
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
}

// ============================================================
// ІНІЦІАЛІЗАЦІЯ
// ============================================================

async function initApp() {
  try {
    // Telegram WebApp
    state.tg = window.Telegram.WebApp;
    state.tg.ready();
    state.tg.expand();

    // Ініціалізуємо DOM
    initDOM();

    // Ховаємо ініціалізацію, показуємо додаток
    els.initView.style.display = 'none';
    els.app.style.display = 'flex';

    // Ініціалізуємо візуалізатор
    state.visualizer = new AudioVisualizer('audioVisualizer');

    // Встановлюємо обробники
    els.mainButton.addEventListener('click', toggleMicrophone);
    els.disconnectBtn.addEventListener('click', disconnect);

    // На десктопі — додаємо клавішу Space
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        toggleMicrophone();
      }
    });

    // Початковий статус
    setStatus('disconnected', 'Натисни, щоб почати');

    console.log('🚀 Artemis Live ініціалізовано');
    console.log('👤 Користувач:', state.tg.initDataUnsafe?.user);
  } catch (err) {
    console.error('❌ Помилка ініціалізації:', err);
    showError('Не вдалося запустити додаток', err.message);
  }
}

function showError(title, message) {
  const initView = document.getElementById('initializing');
  const errorView = document.getElementById('errorView');
  if (initView) initView.style.display = 'none';
  if (errorView) {
    errorView.style.display = 'flex';
    document.getElementById('errorTitle').textContent = title || 'Помилка';
    document.getElementById('errorText').textContent = message || 'Невідома помилка';
  }
}

function retry() {
  document.getElementById('errorView').style.display = 'none';
  document.getElementById('initializing').style.display = 'flex';
  initApp();
}

// ============================================================
// СТАРТ
// ============================================================

// Чекаємо завантаження DOM і бібліотек
document.addEventListener('DOMContentLoaded', () => {
  // Перевіряємо, чи всі класи завантажено
  if (typeof GeminiLiveAPI === 'undefined' || typeof AudioStreamer === 'undefined') {
    showError('Помилка завантаження', 'Не вдалося завантажити модулі. Спробуй оновити сторінку.');
    return;
  }
  initApp();
});
