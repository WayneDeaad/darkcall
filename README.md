# DarkCall — PRO (Xirsys) — FIX 2

Исправлено по твоим логам:

- ❌ `fetch(... with credentials in URL ...)` — браузер запретил.  
  ✅ Теперь прямой запрос к Xirsys идёт через **`Authorization: Basic`** заголовок (как в твоём XHR‑примере).
- ❌ 500 от Netlify Function.  
  ✅ Функция теперь тоже шлёт **Basic** в заголовке и возвращает тело ошибки, если что — легче дебажить.
- ❌ `Failed to set remote answer sdp: Called in wrong state: stable`  
  ✅ Добавлены **гварды по `signalingState`**:  
    - Caller применяет `answer` только когда `have-local-offer`.  
    - Callee слушает новые `offer` только в `stable` (для ICE‑рестартов), и **после** первоначального ответа.
- ✅ Убраны повторы создания/присоединения (guards), чистятся подписки (unsubscribe).

## Как пользоваться
1. Замени файлы на Netlify содержимым архива.
2. (Опционально) в Netlify → Environment добавь:
   - `XIRSYS_USER=DevDemon`
   - `XIRSYS_SECRET=66d34f1a-97a5-11f0-a5dc-0242ac130002`
   - `XIRSYS_CHANNEL=MyFirstApp`
   Тогда клиент возьмёт ICE через функцию и **не будет светить ключи** в браузере.

Если всё равно упираешься в сети — включи «**Только TURN (relay)**». Авто‑фейловер и вотчдог тоже остаются на месте.
