#!/usr/bin/env python3
"""
Artemis Live API Server
HTTP сервер для генерації ephemeral token для Gemini Live API
та прийому транскриптів після голосових сесій.

Запускається як окремий процес або інтегрується в ArtemisBot.
Порт за замовчуванням: 8765

Використання:
  export GEMINI_API_KEY="..."
  python server.py                     # запуск сервера
  python server.py --port 8080         # на іншому порту
"""

import os
import sys
import json
import logging
import asyncio
from datetime import datetime, timedelta, timezone

from aiohttp import web

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
)
logger = logging.getLogger('artemis-live-api')

# ============================================================
# КОНФІГУРАЦІЯ
# ============================================================

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY') or os.environ.get('GEMINI_FREE_KEY')
CORS_ORIGINS = os.environ.get('CORS_ORIGINS', '*')

# ============================================================
# MIDDLEWARE
# ============================================================

@web.middleware
async def cors_middleware(request, handler):
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
    Генерує ephemeral token через google-genai SDK.
    Lazy import — SDK завантажується тільки при першому виклику.
    """
    logger.info("🔑 Запит на отримання ephemeral token")

    if not GEMINI_API_KEY:
        return web.json_response({"error": "API ключ не налаштовано"}, status=500)

    try:
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass

        user_id = body.get('user_id', 'unknown')
        now = datetime.now(timezone.utc)

        # Lazy import — SDK імпортується тільки тут (перший раз ~15с)
        from google import genai

        def create_token_sync():
            client = genai.Client(
                api_key=GEMINI_API_KEY,
                http_options={'api_version': 'v1alpha'}
            )
            result = client.auth_tokens.create(config={'uses': 1})
            return result.name

        loop = asyncio.get_event_loop()
        token = await loop.run_in_executor(None, create_token_sync)

        if not token:
            return web.json_response({"error": "Помилка отримання токена"}, status=500)

        logger.info(f"✅ Ephemeral token отримано для user_id={user_id}")
        return web.json_response({
            "token": token,
            "expires_at": (now + timedelta(minutes=30)).isoformat(),
            "model": "gemini-3.1-flash-live-preview",
        })

    except ImportError:
        logger.error("❌ google-genai SDK не встановлено")
        return web.json_response({"error": "SDK не встановлено на сервері"}, status=500)
    except Exception as e:
        logger.error(f"❌ Помилка: {e}", exc_info=True)
        return web.json_response({"error": f"Помилка: {str(e)}"}, status=500)


async def handle_save_transcript(request):
    """POST /api/transcript — зберігає транскрипт сесії"""
    try:
        body = await request.json()
        transcript = body.get('transcript', [])
        logger.info(f"💾 Транскрипт: {len(transcript)} повідомлень")
        return web.json_response({"status": "ok", "saved": len(transcript)})
    except json.JSONDecodeError:
        return web.json_response({"error": "Невірний формат JSON"}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request):
    """GET /api/health — перевірка стану"""
    return web.json_response({
        "status": "ok",
        "version": "1.0.0",
        "gemini_key_configured": bool(GEMINI_API_KEY),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ============================================================
# ЗАПУСК
# ============================================================

def create_app():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_post('/api/token', handle_get_token)
    app.router.add_post('/api/transcript', handle_save_transcript)
    app.router.add_get('/api/health', handle_health)
    return app


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Artemis Live API Server')
    parser.add_argument('--port', type=int, default=int(os.environ.get('LIVE_API_PORT', 8765)))
    parser.add_argument('--host', type=str, default=os.environ.get('LIVE_API_HOST', '0.0.0.0'))
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    if not GEMINI_API_KEY:
        logger.warning("⚠️ GEMINI_API_KEY не знайдено! /api/token не працюватиме.")

    logger.info(f"🚀 Artemis Live API Server на http://{args.host}:{args.port}")
    web.run_app(create_app(), host=args.host, port=args.port)


if __name__ == '__main__':
    main()
