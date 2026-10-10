# Публичный API ulda-auth

Контракт подготовленного выпуска 1.0.0. Экспорты: Ulda, SocketIoTransport, UldaError.
Формат данных — JSON: null, boolean, конечное число, строка, массив, обычный объект.
Date, bigint, функции, undefined, циклы и опасные ключи отклоняются.

## Ulda

`new Ulda(endpoint, options?)` создаёт один Socket.IO WebSocket. Адрес HTTPS без
логина, пароля, query и fragment. Для тестов разрешается HTTP на loopback с явным
`allowInsecureLocalhost: true`. Числовые ID передавайте строками: иначе возможна
потеря точности BIGINT.

Параметры:
- timeout: 10000 ms по умолчанию, 50–60000.
- reconnect: false либо объект; maxAttempts=5 (1–20), initialDelay=500 ms,
  maxDelay=5000 ms (до 60000), jitter=0.2 (0–1), budget=30000 ms (50–300000).
  initialDelay >=10 и <=maxDelay. Первый неудачный ready автоматически не повторяется.
- transport: подготовленный SocketIoTransport, например для подключения trace.
  Произвольные замены транспорта не входят в проверенную совместимость 1.0.

| Метод/свойство | Результат и действие |
|---|---|
| ready | Promise<void>: соединение и Hello |
| status | connecting / ready / open / disconnected / reconnecting / needsResync / closed |
| register(password) | Promise<string>: создать master X, принять локальную копию после ACK, вернуть ID |
| connect(id,password) | Promise<DataTree>: прочитать и проверить master и content |
| add(name,json,mode='X') | Promise<{ok:true,name,subscriptionReady}>: резерв content, затем атомарное обновление content+master |
| update(name,json) | Promise<{ok:true}>: заменить весь content |
| set(name,path,json) | Promise<{ok:true}>: заменить узел; path — массив строк/индексов |
| remove(name,path) | Promise<{ok:true}>: удалить поле или элемент массива; корень через delete |
| delete(name) | Promise<{ok:true}>: refresh, атомарно удалить content и обновить master |
| superDelete() | Promise<{ok:true}>: refresh, удалить известные content и master; закрыть SDK |
| recoverContent(name) | Promise<{ok:true,previousId,id,sourceAge,reconciled}>: новый ID из проверенной копии, заменить одну ссылку; старый ресурс сохранить |
| refresh() | Promise<DataTree>: проверить текущий снимок и восстановить подписки чтением |
| reconnect() | Promise<DataTree | undefined>: ограниченный цикл connect/Hello/Read, без повтора записей |
| close() | Promise<void>: отменить ожидания, очистить owned origin/ссылки, закрыть транспорт |
| snapshot() | независимая копия всего пользовательского JSON; не каталог с секретами |
| value(name,path?) | независимая копия JSON content/узла |
| ref(name) / data.field(name) | ссылка на content с привязкой к его ID и контексту |

`data.notes.title.get()` читает значение; `update(value)` меняет узел;
`delete()` удаляет узел, а на корне — content. `field(key)` позволяет обращаться
к полям get/update/delete/field/toJSON и динамическим именам. Присваивание полей Proxy
и оператор delete запрещены. Полученную JSON-копию можно менять локально, но это
не отправляет Update. `then` и символы не являются автоматическими ссылками.

Возвращённые TypeScript-типы отражают заявленную приложением схему; сервер не знает её.
Для динамического JSON используйте field() и проверяйте тип значения get().
Новая версия content с прежним именем не оживляет старую ссылку.

## События

`on(event, listener)` возвращает функцию отписки. Ошибка listener изолируется.
- status: строка состояния.
- change: {id,kind:'updated'} либо {ids,kind:'updated'|'deleted'|'recovered'}.
  Это сигнал перечитать snapshot, без секретов каталога.
- error: UldaError с фиксированными message и code; не произвольный ответ сервера.
- trace: неизменяемые time/phase/event/step/ids/count; не сырой пакет.
- reconnect: phase, опциональные attempt/delayMs/code.

## Ошибки и повтор

INVALID_INPUT, INVALID_PACKET, UNSUPPORTED_PROFILE, CRYPTO_FAILED, CLOSED, OFFLINE,
NOT_OPEN, UNKNOWN_OUTCOME, CONFLICT, NOT_FOUND, EXISTS, NEEDS_RESYNC, ROLLBACK, LIMIT,
UNSUPPORTED, SERVER_ERROR, STALE_REFERENCE, BUSY, TIMEOUT.

CONFLICT требует refresh и нового решения приложения. UNKNOWN_OUTCOME не означает
откат: исходный запрос мог сохраниться. Нельзя повторять Create/Update/Delete вслепую.
При недопустимом снимке SDK сохраняет последнюю проверенную копию и блокирует запись.
Некоторые методы проверяют ввод синхронно до возврата Promise; оборачивайте сам вызов
в try/catch вместе с await.

Режим S — ограниченная очередь одной ветки, не CRDT и не автоматическое слияние.
Ограничения размера, доверия серверу, восстановления и памяти — в
[MANIFEST](../MANIFEST.md), [SECURITY](../SECURITY.md), [RECOVERY](RECOVERY.md).

## SocketIoTransport

Низкоуровневый экспорт для настройки timeout, allowInsecureLocalhost и диагностических
подписок; диагностика тестового сервера включается diagnostics=true. Встроенный SDK
не даёт произвольному объекту стать исходящим пакетом. send принимает только внутренний
PacketHandle, созданный SDK, и возвращает ответ после проверки.

События транспорта: changed (публичные witness и ciphertext), disconnect, error, trace.
start({signal?}), disconnect(), close(), connected. Trace содержит только ID, размеры,
фиксированные коды и время. Нельзя сохранять raw Changed или ошибки приложения
в публичный журнал, если приложение добавляет к ним собственные секреты.

## Конкурентная ошибка целостности

В версии 1.0.0 connect/refresh отклоняются с NEEDS_RESYNC, если во время их выполнения
возникла новая ошибка входящего сообщения. Последняя проверенная копия сохраняется;
при первом connect контекст ещё не устанавливается. Повторный явный connect либо
новый refresh выполняют новое чтение. Уже отправленные записи сохраняют свой
результат ACK/UNKNOWN_OUTCOME; новая стадия add/recovery/delete после ошибки не отправляется.
