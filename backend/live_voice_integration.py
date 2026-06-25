"""
Artemis Live — Інтеграція з ArtemisBot
======================================
Додає кнопку "🎤 Live Voice" в клавіатуру бота.

Встановлення:
1. Імпортувати в main.py:
   from features.live_voice import handle_live_voice

2. Зареєструвати CommandHandler:
   application.add_handler(CommandHandler("live", handle_live_voice))

3. Або додати кнопку в клавіатуру:
   from keyboards import LIVE_VOICE_BUTTON
"""

import logging
from telegram import Update, WebAppInfo, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

logger = logging.getLogger(__name__)

# ============================================================
# КОНФІГУРАЦІЯ
# ============================================================

# URL, де задеплоєно Telegram WebApp
# GitHub Pages
LIVE_WEBAPP_URL = "https://hollylight28.github.io/artemis-live"

# URL для API сервера (передається як параметр ?server=...)
# 🚨 ЗМІНИТИ на реальний IP/домен сервера з ArtemisBot!
API_SERVER_URL = "http://YOUR_SERVER_IP:8765"

# ============================================================
# КНОПКИ
# ============================================================

def get_live_voice_button():
    """Повертає InlineKeyboardButton для Live Voice"""
    webapp_url = f"{LIVE_WEBAPP_URL}?server={API_SERVER_URL}"
    return InlineKeyboardButton(
        "🎤 Live Voice",
        web_app=WebAppInfo(url=webapp_url)
    )

def get_live_voice_keyboard():
    """Повертає клавіатуру з кнопкою Live Voice"""
    return InlineKeyboardMarkup([[get_live_voice_button()]])

# ============================================================
# ХЕНДЛЕР
# ============================================================

async def handle_live_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /live — показати кнопку для запуску Live Voice WebApp
    """
    text = (
        "🎤 <b>Голосова розмова з Артеміс</b>\n\n"
        "Натисни кнопку нижче, щоб відкрити голосовий чат.\n"
        "Артеміс буде слухати і відповідати тобі голосом у реальному часі!\n\n"
        "Працює через <b>Gemini 3.1 Flash Live</b> 🔥"
    )

    await update.message.reply_text(
        text,
        reply_markup=get_live_voice_keyboard(),
        parse_mode='HTML'
    )


# ============================================================
# ПРИКЛАД ОНОВЛЕННЯ keyboards.py
# ============================================================

# Щоб додати кнопку в основну клавіатуру (keyboards.py):
#
# from features.live_voice import get_live_voice_button
#
# def get_main_keyboard():
#     return ReplyKeyboardMarkup(
#         [
#             ["🧠 Mission Control", "🧹 Нова розмова"],
#             ["🔔 Нагадування", "🎨 Створити Арт"],
#             ["🎤 Live Voice"],  # <-- додати цей рядок
#         ],
#         resize_keyboard=True,
#     )
