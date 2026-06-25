# ✦ Artemis Live

**Голосова розмова з Артеміс через Gemini 3.1 Flash Live API**

Telegram WebApp для real-time голосового спілкування з AI-асистентом Артеміс. Використовує Gemini Live API з ephemeral token-авторизацією для безпечного клієнт-серверного з'єднання.

![Artemis Live](https://img.shields.io/badge/status-active-brightgreen)
![Gemini](https://img.shields.io/badge/Gemini-3.1%20Flash%20Live-blue)

## 🚀 Архітектура

```
┌──────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Telegram Bot    │     │  Live API Server │     │  Gemini 3.1 Flash   │
│  (ArtemisBot)    │────▶│  (aiohttp, :8765)│────▶│  Live API (WebSocket)│
│  + WebApp кнопка │     │  POST /api/token │     │  wss://...           │
└──────────────────┘     └──────────────────┘     └─────────────────────┘
        │                         ▲                          │
        │  відкриває WebApp       │  ephemeral token          │  WebSocket з
        ▼                         │                          │  токеном
┌──────────────────┐             │                          │
│  Telegram WebApp  │─────────────┘                          │
│  (GitHub Pages)   │─────────────────────────────────────────┘
│  index.html       │  пряме WebSocket з'єднання
│  script.js        │  (аудіо стрімінг)
│  geminilive.js    │
└──────────────────┘
```

## 🧩 Компоненти

### Frontend (цей репозиторій)
- `frontend/index.html` — Telegram WebApp
- `frontend/script.js` — логіка додатку
- `frontend/geminilive.js` — клієнт Gemini Live API (vanilla JS, WebSocket)
- `frontend/mediaUtils.js` — захоплення/програвання аудіо
- `frontend/styles.css` — темна тема Telegram

### Backend (додається в ArtemisBot)
- `backend/server.py` — HTTP сервер (aiohttp) з endpoints:
  - `POST /api/token` — генерація ephemeral token
  - `POST /api/transcript` — збереження транскрипту
  - `GET /api/health` — перевірка стану

## 🛠️ Встановлення

### Backend (на сервері з ArtemisBot)

1. Встановити залежності:
```bash
pip install aiohttp python-dotenv
```

2. Налаштувати змінні оточення:
```bash
export GEMINI_API_KEY="твій_gemini_api_ключ"
export LIVE_API_PORT=8765
```

3. Запустити:
```bash
python backend/server.py
```

### Frontend (Telegram WebApp)

1. Залити frontend на GitHub Pages або Vercel
2. В конфігурації WebApp прописати URL сервера в `CONFIG.API_BASE_URL` в `script.js`
3. Додати кнопку в Telegram бота:
```python
from telegram import WebAppInfo
InlineKeyboardButton("🎤 Live Voice", web_app=WebAppInfo(url="https://твій-сайт.com"))
```

## 🔑 API Endpoints

### `POST /api/token`
Отримати ephemeral token для Live API.

**Body:**
```json
{
  "user_id": 123456789  // опціонально
}
```

**Response:**
```json
{
  "token": "authTokens/abc123...",
  "expires_at": "2026-06-25T23:37:00+00:00",
  "model": "gemini-3.1-flash-live-preview"
}
```

### `POST /api/transcript`
Зберегти транскрипт сесії.

**Body:**
```json
{
  "session_id": "session_1719259200000",
  "user_id": 123456789,
  "transcript": [
    {"role": "user", "text": "Привіт!", "timestamp": 1719259200000},
    {"role": "assistant", "text": "Привіт, Вова!", "timestamp": 1719259201000}
  ],
  "duration_ms": 60000
}
```

## 📋 Особливості

- **Ephemeral tokens** — API ключ не світиться на фронтенді
- **Voice Activity Detection** — автоматичне визначення кінця фрази
- **Barge-in** — можливість переривати відповідь Артеміс
- **Автоперепідключення** — при втраті з'єднання
- **Транскрипт** — текстова розшифровка всієї розмови
- **Аудіо візуалізація** — живі хвилі звуку
- **Темна тема** — Telegram WebApp з адаптивним дизайном

## 🎯 Обмеження

- **Live API**: сесія ~10 хв без компресії (але є session management)
- **Аудіо**: тільки голос, без відео (поки що)
- **Мікрофон**: потребує дозволу в браузері (Telegram WebView)
- **Безкоштовний ліміт**: ~30 хв/день для однієї-двох осіб

## 📄 Ліцензія

MIT — вільно використовуй, модифікуй, поширюй.

---

<p align="center">Зроблено з ❤️ для Артеміс</p>
