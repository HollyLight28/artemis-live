# 🔗 Live2RAG: Integration of Artemis Live API with Memory (RAG + Graph)

> **Мета:** Дати Gemini Live API доступ до історії спілкування Вови з Артеміс (RAG-пам'ять + граф знань), щоб Live-розмови були контекстними.

---

## 1. Поточна архітектура (без контексту)

```
Користувач (Telegram)
    │
    ├── Live WebApp (HTML/JS) ←── Gemini Live API (WebSocket)
    │       │                         │
    │       │                         └── SYSTEM_INSTRUCTION тільки
    │       │                             (без історії)
    │       │
    └── Основний бот (Python) ←── Gemini API (текст)
                │
                ├── RAG (memory/)
                └── Graph (зв'язки, сутності)
```

**Проблема:** Live API не знає нічого про попередні розмови, настрій, контекст.

---

## 2. Цільова архітектура

```
Користувач (Telegram)
    │
    ├── Live WebApp
    │       │
    │       ├── ① GET /api/context → отримує контекст (RAG + граф)
    │       │       │               (при старті сесії + periodically)
    │       │       │
    │       │       └── Сервер:
    │       │               ├── RAG: semantic search memory/*.md
    │       │               ├── Graph: зв'язки, сутності
    │       │               └── Recent: останні N повідомлень
    │       │
    │       └── ② Системний промпт з контекстом
    │               + ③ Tool "search_memory" для динамічного пошуку
    │                      │
    │                      └──> Gemini Live API
    │
    └── Основний бот (Python) ←── Gemini API (текст)
```

---

## 3. Компоненти інтеграції

### 3.1. REST Endpoint: `POST /api/context`

Новий ендпоінт на сервері (`server.py`), який повертає контекст для Live API.

**Request:**
```json
{
  "user_id": 12345,
  "session_type": "live_voice"
}
```

**Response:**
```json
{
  "context_text": "Останні теми розмови: ...",
  "recent_messages": ["...", "..."],
  "entities": ["...", "..."],
  "mood": "user_feeling",
  "timestamp": "2026-06-27T20:00:00Z"
}
```

**Implementation (Python, server.py):**
```python
async def handle_get_context(request):
    """
    POST /api/context
    Повертає контекст для Live API з RAG + графа.
    """
    body = await request.json()
    user_id = body.get('user_id', 0)
    
    loop = asyncio.get_event_loop()
    
    # 1. RAG: semantic search останніх значущих спогадів
    rag_context = await loop.run_in_executor(None, lambda: search_memory(
        query="останні розмови та настрій користувача",
        top_k=5
    ))
    
    # 2. Граф: поточні активні сутності
    graph_context = await loop.run_in_executor(None, lambda: get_active_entities(
        user_id=user_id
    ))
    
    # 3. Останні повідомлення з БД (якщо є)
    recent = await get_recent_messages(user_id, limit=10)
    
    # 4. Формуємо текст для system_instruction
    context_text = format_live_context(rag_context, graph_context, recent)
    
    return web.json_response({
        "context": context_text,
        "mood": rag_context.get('mood', 'neutral'),
        "entities": graph_context.get('entities', []),
        "recent_count": len(recent),
    })


def format_live_context(rag, graph, recent):
    """Форматує контекст у природний текст для системного промпту."""
    parts = []
    
    if rag.get('summary'):
        parts.append(f"Контекст: {rag['summary']}")
    
    if recent:
        parts.append("Останні повідомлення:\n" + 
                     "\n".join(f"- {m['role']}: {m['text'][:200]}" for m in recent))
    
    if graph.get('entities'):
        parts.append("Активні теми: " + ", ".join(graph['entities']))
    
    if rag.get('mood'):
        parts.append(f"Настрій користувача: {rag['mood']}")
    
    return "\n\n".join(parts)
```

### 3.2. Оновлення `connectToGemini()` в `script.js`

```javascript
async function connectToGemini() {
    setStatus('connecting');
    try {
        const token = await fetchEphemeralToken();
        const context = await fetchContext();  // ← НОВИЙ ВИКЛИК
        
        state.client = new GeminiLiveAPI(token, CONFIG.MODEL);
        
        // Додаємо контекст до системних інструкцій
        const fullInstructions = CONFIG.SYSTEM_INSTRUCTION + 
            "\n\n--- КОНТЕКСТ РОЗМОВИ ---\n" + context;
        
        state.client.setSystemInstructions(fullInstructions);
        // ...
    }
}

async function fetchContext() {
    try {
        const resp = await fetch(`${CONFIG.API_BASE_URL}/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: state.tg?.initDataUnsafe?.user?.id || 0,
                session_type: 'live_voice'
            })
        });
        if (!resp.ok) return '';
        const data = await resp.json();
        return data.context || '';
    } catch(e) {
        console.warn('⚠️ Context fetch failed:', e);
        return '';
    }
}
```

### 3.3. Функція-інструмент "search_memory" (Tool Calling)

**Найпотужніший спосіб** — дати Live моделі можливість самостійно викликати пошук по пам'яті.

Визначаємо function declaration для Gemini Live API:

```javascript
// В script.js, після створення GeminiLiveAPI:
class SearchMemoryTool extends FunctionCallDefinition {
    constructor() {
        super(
            "search_memory",
            "Пошук в пам'яті Артеміс по заданому запиту. Використовуй коли потрібно згадати щось з минулих розмов.",
            {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Запит для пошуку в пам'яті"
                    }
                },
                required: ["query"]
            },
            ["query"]
        );
    }
    
    async functionToCall(parameters) {
        const result = await this.searchMemory(parameters.query);
        return result;
    }
    
    async searchMemory(query) {
        try {
            const resp = await fetch(`${CONFIG.API_BASE_URL}/memory_search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    user_id: state.tg?.initDataUnsafe?.user?.id || 0,
                    top_k: 3
                })
            });
            if (!resp.ok) return "Не знайдено";
            const data = await resp.json();
            return data.results?.join('\n') || "Нічого не знайдено";
        } catch(e) {
            return "Помилка пошуку в пам'яті";
        }
    }
}

// Підключаємо до клієнта:
const memoryTool = new SearchMemoryTool();
state.client.setEnableFunctionCalls(true);
state.client.addFunction(memoryTool);
```

### 3.4. Бекенд endpoint `/api/memory_search`

```python
async def handle_memory_search(request):
    """
    POST /api/memory_search
    Пошук в RAG-пам'яті по текстовому запиту.
    """
    body = await request.json()
    query = body.get('query', '')
    user_id = body.get('user_id', 0)
    top_k = body.get('top_k', 3)
    
    if not query:
        return web.json_response({"error": "query required"}, status=400)
    
    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, lambda: search_memory(
        query=query,
        top_k=top_k
    ))
    
    return web.json_response({
        "results": results.get('texts', []),
        "scores": results.get('scores', [])
    })
```

---

## 4. Інтеграція з існуючою RAG системою

Якщо в основному боті (`Artemis_bot`) вже є RAG на основі memory/* файлів:

### Python-кроки:

```python
# В memory/ модулі бота
from core.memory import MemoryManager

memory = MemoryManager()

# Для форматування для Live:
def get_live_context(user_id: int) -> str:
    # Semantic search останнього дня
    recent = memory.semantic_search(
        query="що відбувалося останнім часом",
        top_k=5
    )
    
    # Entity extraction (якщо є граф)
    entities = get_user_entities(user_id)
    
    # Форматування
    return format_live_context(recent, entities)
```

**Регістрація маршрутів у server.py:**
```python
# Додати в create_app():
app.router.add_post('/api/context', handle_get_context)
app.router.add_post('/api/memory_search', handle_memory_search)
```

---

## 5. Алгоритм оновлення контексту

Недостатньо просто завантажити контекст на старті — його треба періодично оновлювати:

1. **При старті сесії** → завантажити повний контекст
2. **Кожні 5 хвилин** → оновлювати через systemInstruction (не можна змінити під час сесії)
3. **Через tool call** → модель викликає функцію "search_memory" коли їй треба
4. **При завершенні сесії** → зберегти транскрипт (вже є)

> **Note:** System instructions неможливо оновити після встановлення з'єднання. Тому періодичне оновлення контексту треба робити через tool calling.

---

## 6. Роадмап впровадження

| Фаза | Що робити | Час |
|------|-----------|-----|
| 🟢 Phase 1 | Додати endpoint `/api/context` на сервері | ~1 день |
| 🟢 Phase 1 | Вбудувати контекст в `systemInstruction` при старті Live | ~0.5 дня |
| 🟡 Phase 2 | Tool calling: функція "search_memory" | ~1 день |
| 🟡 Phase 2 | Backend `/api/memory_search` | ~0.5 дня |
| 🔴 Phase 3 | Періодичне оновлення контексту через reconnect | ~2 дні |
| 🔴 Phase 3 | Збереження Live-транскриптів у загальну пам'ять | ~1 день |

---

## 7. Обмеження та застереження

1. **Live API не може змінити systemInstruction після старту** — контекст фіксується на всю сесію
2. **Tool calling працює, але з latency** — виклик `/api/memory_search` додає ~500-3000ms
3. **Gemini 3.1 Flash Live** — підтримує function calling, але з обмеженням у 10 функцій
4. **Безпека** — ephemeral token діє 30 хвилин, `/api/context` має перевіряти user_id
5. **Об'єм контексту** — systemInstruction обмежений, контекст має бути стислим (≤2000 символів)

---

## 8. Перевірка працездатності

Після впровадження перевірити:

- [ ] Live API відповідає з урахуванням історії
- [ ] Tool "search_memory" працює і повертає релевантні результати
- [ ] Контекст оновлюється при перепідключенні
- [ ] Немає дублювання контексту (якщо токен протух і створився новий)
- [ ] Транскрипти Live-розмов зберігаються в загальну пам'ять
