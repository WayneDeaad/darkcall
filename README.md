# DarkCall — PRO (Xirsys) — FIX 3 + Polished UI

### Что исправлено
- **RTCPeerConnection(iceServers) — всегда массив.** Добавил нормализацию и защиту:
  - Любой ответ Xirsys превращаем в массив `{ urls, username?, credential? }`.
  - Если что-то не так — дефолт `[{ urls: ['stun:stun.l.google.com:19302'] }]`.
- **Xirsys — Basic Auth в заголовке.** Никаких `user:pass@url`.
- **Сигналинг:** гварды по состояниям, без `wrong state: stable`.
- **Re-entrancy:** блокировка повторных create/join, отписка от всех `onSnapshot`.
- **Watchdog и авто‑фоллбек на TURN** остаются: связь не «умирает».

### Улучшения дизайна
- Чистый тёмный минимализм, аккуратные акценты (`--accent`, `--accent2`).
- Улучшенные фокусы инпутов, плавные тени, аккуратные кнопки.
- Тосты для статуса + панель ошибок.

### Как развернуть
1. Залей содержимое архива на Netlify (поверх).  
2. (Опционально) Включи Netlify Function и переменные окружения:
   - `XIRSYS_USER`, `XIRSYS_SECRET`, `XIRSYS_CHANNEL`  
   Тогда ключи не будут в исходнике, а ICE будут приходить через `/.netlify/functions/xirsys-ice`.

### Где править
- `xirsys-config.js` — твои креды Xirsys (для простоты сейчас они тут).  
- `ice-provider.js` — логика получения/нормализации ICE.
- `app.js` — WebRTC/Firestore/аудио/UX.

Если снова что-то ругнётся в консоли — скинь точный текст, поправлю точечно.
