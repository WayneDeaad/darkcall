# DarkCall — PRO (Xirsys + авто‑фейловер) — FIX 1

Исправления по твоим ошибкам:

1) **TypeError: destStream.getAudioTracks is not a function**  
   Теперь мы используем правильный объект: `MediaStreamAudioDestinationNode.stream`  
   (т. е. берём трек как `destNode.stream.getAudioTracks()[0]`).

2) **Бесконечно создаётся комната**  
   Добавлены **гварды** и отключение кнопок на время операции (`creating/joining`) + чистка подписок.

3) **500 от /.netlify/functions/xirsys-ice**  
   Чтобы не засорять консоль, теперь **сначала идёт прямой запрос** к Xirsys (как в твоём cURL), и только если он упадёт — пробуем Netlify Function. В итоге даже без функций всё работает.

4) Стабильность  
   - Акуратные `unsubscribe` при завершении звонка.  
   - Watchdog и авто‑фоллбек остались.

Разворачивай поверх текущего деплоя.

