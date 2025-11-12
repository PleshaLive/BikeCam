# CS2 Broadcast Camera Server

Сервер принимает игровые GSI-события из CS2, отслеживает текущего наблюдаемого игрока и раздаёт WebRTC-потоки камер с MJPEG-фоллбэком для любых страниц трансляции.

## Быстрый старт

```bash
npm install
npm start
```

По умолчанию сервис слушает порт `3000`. Все настройки можно вынести в файл `.env` (используется `dotenv`), чтобы локальная разработка и Render-среда читали одинаковые переменные окружения.

## Переменные окружения

- `PORT` — HTTP-порт сервера (по умолчанию `3000`).
- `OWNER_IP` — IP-адрес, который всегда имеет доступ к админке. Значение обязательно укажите в Render, локально по умолчанию используется `127.0.0.1`.
- `ADMIN_USER` и `ADMIN_PASS` — учётная запись для HTTP Basic Auth при обращении к админским маршрутам. Значения по умолчанию: `admin` / `changeme`.
- `ICE_SERVERS` — альтернативный JSON-массив ICE-серверов (обычно не требуется).
- `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` — параметры для coturn на VPS. Можно передать несколько URL через запятую (например, `turn:host:3478?transport=udp,turns:host:5349?transport=tcp`).

## Безопасность админки

Все запросы к `/admin-panel`, `/admin`, `/admin.html` и `/api/admin/*` проверяются по двум условиям:

1. HTTP Basic Auth (`ADMIN_USER` / `ADMIN_PASS`).
2. IP-адрес клиента должен быть в `data/admin-config.json`. В файл автоматически добавляется `OWNER_IP`; остальные адреса можно добавить через API `/api/admin/allowed-ips` (с уже разрешённого IP) или вручную отредактировать файл.

Это позволяет безопасно работать из Render, не раскрывая публично доступ к админским ручкам.

## CORS и фронтенд

Сервер разрешает CORS-трафик только с доверенных доменов:

- `https://bikecam.onrender.com`
- `https://raptors.life`
- `http://localhost:3000`

Если нужен другой домен, добавьте его в список в `server.js`.

## WebRTC Diagnostics UI

Для проверки доступности собственного TURN сервера добавлена страница `/webrtc/diag`, собранная на React + TypeScript. Страница запрашивает учётные данные у бекенда, кеширует их на TTL/2 и умеет деградировать к публичному STUN при недоступности сервиса.

Пример `.env` для локальной разработки:

```dotenv
VITE_TURN_ENDPOINT=/api/turn
```

При деплое на другой домен можно указать полный URL, например:

```dotenv
VITE_TURN_ENDPOINT=https://bikecam.onrender.com/api/turn
```

### Сборка и запуск

- `npm run client:dev` — запустить Vite dev-сервер (порт 5173).
- `npm run client:build` — собрать статические ассеты в `public/webrtc/diag` (используется Express маршрутом `/webrtc/diag`).
- `npm run client:preview` — локально посмотреть production-сборку.

После `client:build` Express автоматически отдаёт собранный бандл по адресу `https://<домен>/webrtc/diag`.

## Маршруты клиента

- `/main-gb-full-27.html` — главный виджет, показывающий камеру текущего наблюдаемого игрока.
- `/ct-side-gb-27.html` и `/t-side-gb-27.html` — сетки камер для соответствующих команд.
- `/register.html` — страница игрока для публикации собственного WebRTC-потока (с MJPEG резервом).
- `/fallback/mjpeg/:nickname` — MJPEG-стрим для OBS/vMix на случай недоступности WebRTC.
- `/api/webrtc/config` — JSON конфиг с полями `iceServers` и `fallback`, который запрашивает фронтенд перед инициализацией PeerConnection.

## GSI-конфиг CS2

Пример файла `gamestate_integration_broadcast.cfg`:

```json
{
  "uri": "https://ВАШ-ДОМЕН/api/gsi",
  "timeout": "5.0"
}
```

Локально используйте `http://127.0.0.1:3000/api/gsi`, а на Render — HTTPS-домен сервиса.

## MJPEG резерв

Если WebRTC-поток недоступен, сервер принимает кадры MJPEG через `/api/fallback/frame`. На клиенте показывается резерв с задержкой 2.5 секунды, чтобы избежать мерцаний при кратковременных обрывах.

## Деплой на Render

1. Создайте Web Service на Render и укажите репозиторий.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Установите переменные окружения (`OWNER_IP`, `ADMIN_USER`, `ADMIN_PASS`, параметры TURN`).
5. После деплоя обновите GSI-конфиг и выдайте игрокам ссылку на `/register.html`.

Все данные (список активных камер, текущий фокус, разрешённые IP) хранятся в памяти и файле `data/admin-config.json`. После рестарта приложения состояние текущих WebRTC-сессий начнёт собираться заново.