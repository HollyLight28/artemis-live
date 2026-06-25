#!/usr/bin/env python3
"""
Artemis Live API Server
HTTP сервер для генерації ephemeral token для Gemini Live API
та прийому транскриптів після голосових сесій.

Запускається як окремий процес або інтегрується в ArtemisBot.
Порт за замовчуванням: 8765

Використання:
  python server.py                     # запуск сервера
  python server.py --port 8080         # на іншому порту
"""

import os
import sys
import json
import logging
import asyncio
from datetime import datetime, timedelta, timezone

import aiohttp
from aiohttp import web

# Налаштування логування
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
)
logger = logging.getLogger('artemis-live-api')

# ============================================================
# КОНФІГУРАЦІЯ
# ============================================================

# API ключі з оточення
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY') or os.environ.get('GEMINI_FREE_KEY')
ARTEMIS_DB_PATH = os.environ.get('MEMORY_DB_PATH', 'memory.db')
ARTEMIS_TOKEN = os.environ.get('ARTEMIS_API_TOKEN', '')  # для мінімальної auth

# URL для Gemini Live API
# v1alpha — єдиний який підтримує ephemeral tokens
GEMINI_API_BASE = os.environ.get(
    'GEMINI_API_BASE',
    'https://generativelanguage.googleapis.com/v1alpha'
)

# CORS — дозволяємо запити з GitHub Pages або інших доменів
CORS_ORIGINS = os.environ.get(
    'CORS_ORIGINS',
    '*'  # В продакшені змінити на конкретний домен
)

# ============================================================
# MIDDLEWARE
# ============================================================

@web.middleware
async def cors_middleware(request, handler):
    """CORS middleware — дозволяє запити з WebApp"""
    if request.method == 'OPTIONS':
        response = web.Response()
    else:
        response = await handler(request)

    origin = request.headers.get('Origin', '*')
    response.headers['Access-Control-Allow-Origin'] = CORS_ORIGINS if CORS_ORIGINS == '*' else origin
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
    response.headers['Access-Control-Max-Age'] = '86400'
    return response

# ============================================================
# ЕНДПОІНТИ
# ============================================================

async def handle_get_token(request):
    """
    POST /api/token
    Генерує ephemeral token для Gemini Live API.

    Використовує REST API напряму через v1alpha/authTokens.
    Не потребує google-genai SDK.
    """
    logger.info("🔑 Запит на отримання ephemeral token")

    if not GEMINI_API_KEY:
        logger.error("❌ GEMINI_API_KEY не налаштовано")
        return web.json_response(
            {"error": "API ключ не налаштовано"},
            status=500
        )

    try:
        # Опціонально: читаємо user_id з тіла запиту
        body = {}
        try:
            body = await request.json()
        except (json.JSONDecodeError, Exception):
            pass

        user_id = body.get('user_id', 'unknown')

        now = datetime.now(timezone.utc)

        # Формуємо запит до Gemini API для ephemeral token
        # Документація:
        # POST https://generativelanguage.googleapis.com/v1alpha/authTokens?key={API_KEY}
        # Body: {"uses": 1, "expireTime": "...", "newSessionExpireTime": "..."}
        token_url = f"{GEMINI_API_BASE}/authTokens?key={GEMINI_API_KEY}"

        payload = {
            "uses": 1,  # токен на 1 сесію
            "expireTime": (now + timedelta(minutes=30)).isoformat(),
            "newSessionExpireTime": (now + timedelta(minutes=5)).isoformat(),
        }

        headers = {
            "Content-Type": "application/json",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                token_url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(
                        f"❌ Gemini API помилка {resp.status}: {error_text}"
                    )
                    return web.json_response(
                        {"error": f"Gemini API помилка: {resp.status}"},
                        status=resp.status
                    )

                data = await resp.json()
                token = data.get('name')

                if not token:
                    logger.error(f"❌ Токен не знайдено у відповіді: {data}")
                    return web.json_response(
                        {"error": "Помилка формату відповіді API"},
                        status=500
                    )

                logger.info(f"✅ Ephemeral token отримано для user_id={user_id}")
                return web.json_response({
                    "token": token,
                    "expires_at": (now + timedelta(minutes=30)).isoformat(),
                    "model": "gemini-3.1-flash-live-preview",
                })

    except asyncio.TimeoutError:
        logger.error("❌ Таймаут при запиті до Gemini API")
        return web.json_response(
            {"error": "Таймаут при отриманні токена"},
            status=504
        )
    except aiohttp.ClientError as e:
        logger.error(f"❌ Помилка мережі: {e}")
        return web.json_response(
            {"error": f"Мережева помилка: {str(e)}"},
            status=502
        )
    except Exception as e:
        logger.error(f"❌ Невідома помилка: {e}", exc_info=True)
        return web.json_response(
            {"error": f"Внутрішня помилка сервера: {str(e)}"},
            status=500
        )


async def handle_save_transcript(request):
    """
    POST /api/transcript
    Зберігає транскрипт голосової сесії.

    Може зберігати в SQLite базу ArtemisBot, якщо доступна.
    """
    logger.info("💾 Запит на збереження транскрипту")

    try:
        body = await request.json()
        session_id = body.get('session_id', 'unknown')
        user_id = body.get('user_id', 0)
        transcript = body.get('transcript', [])
        duration_ms = body.get('duration_ms', 0)

        logger.info(
            f"📝 Транскрипт сесії {session_id}: "
            f"{len(transcript)} повідомлень, "
            f"{duration_ms / 1000:.1f}с"
        )

        # Якщо є доступ до бази ArtemisBot — зберігаємо
        # Поки що просто логуємо
        for msg in transcript:
            logger.debug(f"  [{msg.get('role')}] {msg.get('text', '')[:100]}")

        return web.json_response({
            "status": "ok",
            "saved": len(transcript),
        })

    except json.JSONDecodeError:
        return web.json_response(
            {"error": "Невірний формат JSON"},
            status=400
        )
    except Exception as e:
        logger.error(f"❌ Помилка збереження транскрипту: {e}")
        return web.json_response(
            {"error": str(e)},
            status=500
        )


async def handle_health(request):
    """
    GET /api/health
    Перевірка стану сервера
    """
    return web.json_response({
        "status": "ok",
        "version": "1.0.0",
        "gemini_key_configured": bool(GEMINI_API_KEY),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def handle_index(request):
    """
    GET /
    Перенаправлення на статику WebApp або інформаційна сторінка
    """
    html = """<!DOCTYPE html>
<html lang="uk">
<head><meta charset="UTF-8"><title>Artemis Live API</title>
<style>
body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #0a0a0f; color: #e8e8ed; }
h1 { color: #4285f4; }
code { background: #1c1c1e; padding: 2px 6px; border-radius: 4px; }
.endpoint { border-left: 3px solid #4285f4; padding-left: 16px; margin: 16px 0; }
.method { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
.method.post { background: #34a853; color: white; }
.method.get { background: #4285f4; color: white; }
</style>
</head>
<body>
<h1>✦ Artemis Live API</h1>
<p>Сервер для голосової розмови з Артеміс через Gemini Live API</p>

<div class="endpoint">
<span class="method post">POST</span> <code>/api/token</code>
<p>Отримати ephemeral token для підключення до Gemini Live API</p>
</div>

<div class="endpoint">
<span class="method post">POST</span> <code>/api/transcript</code>
<p>Зберегти транскрипт голосової сесії</p>
</div>

<div class="endpoint">
<span class="method get">GET</span> <code>/api/health</code>
<p>Перевірка стану сервера</p>
</div>

<hr>
<p style="color: #8e8e93; font-size: 14px;">
  Gemini 3.1 Flash Live ✦ Artemis
</p>
</body>
</html>"""
    return web.Response(text=html, content_type='text/html')


# ============================================================
# ЗАПУСК
# ============================================================

def create_app():
    """Створює aiohttp додаток з маршрутами"""
    app = web.Application(middlewares=[cors_middleware])

    # API endpoints
    app.router.add_post('/api/token', handle_get_token)
    app.router.add_post('/api/transcript', handle_save_transcript)
    app.router.add_get('/api/health', handle_health)

    # Головна сторінка
    app.router.add_get('/', handle_index)

    return app


def main():
    """Точка входу для запуску сервера"""
    import argparse

    parser = argparse.ArgumentParser(description='Artemis Live API Server')
    parser.add_argument('--port', type=int, default=int(os.environ.get('LIVE_API_PORT', 8765)),
                       help='Порт сервера (за замовчуванням: 8765)')
    parser.add_argument('--host', type=str, default=os.environ.get('LIVE_API_HOST', '0.0.0.0'),
                       help='Хост (за замовчуванням: 0.0.0.0)')
    parser.add_argument('--debug', action='store_true', help='Режим налагодження')

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    app = create_app()

    if not GEMINI_API_KEY:
        logger.warning("⚠️ GEMINI_API_KEY не знайдено! Endpoint /api/token не працюватиме.")
        logger.warning("   Встановіть змінну оточення GEMINI_API_KEY або GEMINI_FREE_KEY")

    logger.info(f"🚀 Artemis Live API Server запускається на http://{args.host}:{args.port}")
    web.run_app(app, host=args.host, port=args.port)


if __name__ == '__main__':
    main()
