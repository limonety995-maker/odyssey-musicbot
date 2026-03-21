# Owlbear Sync Music MVP

Рабочий MVP для Owlbear Rodeo, где:

- ГМ управляет музыкой только из Owlbear;
- helper запускается локально на ПК ГМа;
- все игроки получают одно и то же состояние воспроизведения;
- можно играть несколько слоёв одновременно;
- поддерживаются YouTube и YouTube Music ссылки, которые удаётся свести к обычному YouTube `videoId` или `playlistId`.

## Что здесь реально работает

### Точно работает

- синхронный старт, пауза и стоп через `OBR.room` metadata и `OBR.broadcast`;
- несколько активных слоёв одновременно;
- громкость каждого слоя;
- мастер-громкость;
- сохранение наборов дорожек как сцен в helper;
- YouTube watch links;
- YouTube playlist links;
- YouTube Music watch links и playlist links, если helper видит прямой `v=` или `list=` идентификатор.

### Работает с ограничениями

- YouTube Music ссылки вида `music.youtube.com/...` без явного `v=` или `list=` helper пытается разобрать через загрузку страницы. Это best effort, а не гарантия.
- автозапуск зависит от политики браузера. Если autoplay заблокирован, конкретному игроку нужно один раз открыть extension и нажать кнопку повторной попытки.
- если YouTube запрещает embed конкретного ролика, проигрывание не начнётся.

### Честно невозможно или ненадёжно

- нет официального отдельного embed API именно для страниц YouTube Music. Поэтому helper не “играет YouTube Music напрямую”, а старается привести ссылку к обычному YouTube embed-источнику;
- helper можно держать локально, но `manifest.json` и клиентские файлы extension должны быть доступны всем участникам по HTTPS;
- локальный helper ГМа не может сам стримить аудио игрокам напрямую без публичного адреса. Поэтому helper только хранит библиотеку и нормализует ссылки, а само воспроизведение идёт в браузерах игроков через YouTube IFrame API.

## Структура проекта

```text
owlbear-sync-music/
  helper/
    server.js
    start-helper.cmd
  src/extension/
    manifest.json
    index.html
    background.html
    styles.css
    icon.svg
    main.js
    background.js
    shared.js
  dist/extension/          # появится после сборки
  build.mjs
  package.json
  README.md
```

## Быстрый запуск

### 1. Установить зависимости

Нужен Node.js 24 или новее.

```powershell
npm.cmd install
```

### 2. Собрать extension

```powershell
npm.cmd run build
```

Готовые файлы появятся в:

```text
dist/extension
```

### 3. Запустить helper у ГМа

Проще всего дважды кликнуть:

```text
helper/start-helper.cmd
```

Либо из терминала:

```powershell
node helper/server.js
```

По умолчанию helper слушает:

```text
http://127.0.0.1:19345
```

И хранит библиотеку сцен здесь:

```text
helper/data/library.json
```

### 4. Разместить extension по HTTPS

Это обязательный шаг для Owlbear Rodeo, потому что все игроки должны загрузить одни и те же файлы extension.

Подходит любой статический HTTPS-хостинг:

- GitHub Pages
- Netlify
- Cloudflare Pages
- любой свой статический HTTPS-сайт

Нужно опубликовать содержимое папки `dist/extension` так, чтобы по URL были доступны:

- `manifest.json`
- `index.html`
- `background.html`
- `assets/main.js`
- `assets/background.js`
- `styles.css`
- `icon.svg`

### Вариант через GitHub Pages

В проект уже добавлен workflow для Pages:

- [.github/workflows/deploy-pages.yml](/C:/Users/Limon/OneDrive/Рабочий%20стол/dnd/owlbear-sync-music/.github/workflows/deploy-pages.yml)

После пуша в ветку `main` GitHub сам:

1. установит зависимости;
2. соберёт extension;
3. опубликует содержимое `dist/extension` на GitHub Pages.

Для этого репозитория итоговый manifest URL будет:

```text
https://limonety995-maker.github.io/odyssey-musicbot/manifest.json
```

### 5. Подключить extension в Owlbear Rodeo

1. Откройте Owlbear Rodeo.
2. Перейдите в `Extensions`.
3. Нажмите `Install from manifest URL`.
4. Вставьте HTTPS-ссылку на ваш `manifest.json`.
5. Включите extension в комнате.

## Как ГМу пользоваться

1. Перед игрой запустите helper.
2. Откройте комнату в Owlbear Rodeo.
3. Откройте extension `Sync Music MVP`.
4. Убедитесь, что в блоке `GM helper` статус `Helper online`.
5. Вставьте ссылку YouTube или YouTube Music.
6. Нажмите `Add to active mix`.
7. При желании добавьте ещё одну или несколько ссылок для атмосферных слоёв.
8. Нажмите `Play`.
9. Если набор удачный, сохраните его как сцену кнопкой `Save`.

## Что увидят игроки

- игроки увидят текущее состояние воспроизведения;
- управлять транспортом они не смогут;
- если браузер заблокировал autoplay, у них появится локальное предупреждение и кнопка `Retry audio here`.

## Техническая логика

1. ГМ через popover extension меняет общее состояние комнаты.
2. Это состояние пишется в `OBR.room.setMetadata(...)`.
3. Быстрые обновления дополнительно летят через `OBR.broadcast.sendMessage(...)`.
4. У каждого клиента в `background.html` живёт отдельный скрытый YouTube IFrame player на каждый активный слой.
5. У каждого слоя есть общее время старта `playingSince`, поэтому браузеры начинают одно и то же воспроизведение почти одновременно.
6. У ГМа фоновая страница периодически сверяет текущее положение активных слоёв и при необходимости подправляет общий room state.

## Проверка MVP

- откройте комнату минимум в двух браузерах или двух профилях браузера;
- проверьте сценарий `дождь + музыка`;
- проверьте `pause` и `resume`;
- проверьте сохранение и запуск сцены;
- проверьте хотя бы одну обычную ссылку YouTube и одну ссылку из YouTube Music.

## Источники ограничений

- Owlbear metadata: <https://docs.owlbear.rodeo/extensions/reference/metadata/>
- Owlbear room API: <https://docs.owlbear.rodeo/extensions/apis/room/>
- Owlbear broadcast API: <https://docs.owlbear.rodeo/extensions/apis/broadcast/>
- Owlbear player API: <https://docs.owlbear.rodeo/extensions/apis/player/>
- Owlbear manifest reference: <https://docs.owlbear.rodeo/extensions/reference/manifest/>
- YouTube IFrame API: <https://developers.google.com/youtube/iframe_api_reference>
- YouTube player parameters: <https://developers.google.com/youtube/player_parameters>
- Secure localhost context: <https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts>

## GitHub репозиторий

Для отдельного репозитория под этот проект удобно использовать именно папку:

```text
owlbear-sync-music
```

Тогда структура будет чистой, а GitHub Pages сможет публиковать только это расширение, без остальных файлов из `dnd`.
