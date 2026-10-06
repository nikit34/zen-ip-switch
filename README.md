# zen-ip-switch

Переключатель публичного IP для OpenCode Desktop на бесплатном тире Zen. Один bash-файл, Cloudflare WARP (SOCKS5) + privoxy (HTTP->SOCKS мост), SQLite-метрики, автоматическая ротация при 429/403.

## Зачем

OpenCode Zen free-tier (`space-bunny-free`, `mimo-*-free`, `muse-spark-*`, `nemotron-*`, `big-pickle`, `longcat-*-free` и так далее) считает квоту по IP: примерно 500-1000 запросов в сутки на общую корзину, сброс в 00:00 UTC. При исчерпании квоты шлюз отдаёт `429 FreeUsageLimitError`. User-Agent, `x-opencode-client` и прочее на лимит не влияют: проверка в `packages/console/app/src/routes/zen/util/ipRateLimiter.ts` закомментирована.

Этот скрипт поднимает Cloudflare WARP как SOCKS5-прокси, Bun fetch в сайдкаре `opencode-cli` ходит в Zen через HTTP-мост `privoxy` -> SOCKS5 -> WARP exit. С точки зрения шлюза Zen клиент - Cloudflare, свежая корзина. Остальной трафик системы (браузер, корпоративный VPN, Cisco AnyConnect, DNS на `*.lrxn.net`) не задет.

## Почему именно так

- **WARP tunnel-mode (MASQUE/WireGuard)** - ломает маршрутизацию на системе с активным Cisco AnyConnect и корпоративными DNS. Часть трафика проваливается, DNS `*.lrxn.net` падает, ping умирает - фактически интернет пропадает.
- **WARP proxy-mode (SOCKS5)** - не трогает `default route` и DNS. Но Bun fetch в сайдкаре не умеет `socks5h://` в `ALL_PROXY/HTTPS_PROXY` (возвращает `UnsupportedProxyProtocol`), работает только с `http://` и `https://`.
- **privoxy посередине** - слушает HTTP CONNECT на `127.0.0.1:8787`, форвардит через `forward-socks5t` на WARP SOCKS. Bun получает нормальный HTTP-прокси.

Бонус: `rotate` меняет только WARP exit наружу, keep-alive-пул сайдкара к `127.0.0.1:8787` живой - OpenCode не перезапускается, нет ECONNRESET/ConnectionRefused посреди ответа.

## Установка

Нужны macOS, Homebrew, `sqlite3` (есть в системе).

```bash
git clone https://github.com/nikit34/zen-ip-switch.git ~/zen-ip-switch
mkdir -p ~/bin
ln -s ~/zen-ip-switch/zen-ip-switch ~/bin/zen-ip-switch
```

Первое `on` поставит `cloudflare-warp` cask и `privoxy` через brew. Если `~/bin` не в PATH - `export PATH="$HOME/bin:$PATH"` в `~/.zshrc`.

## Команды

```
zen-ip-switch status           прямой IP, WARP, privoxy, env сайдкара, последние CONNECT, пробный Zen
zen-ip-switch on               WARP proxy-mode + SOCKS + privoxy + перезапуск OpenCode.app с ALL_PROXY
zen-ip-switch off              выключить WARP + остановить privoxy + перезапустить OpenCode.app без env
zen-ip-switch rotate [reason]  переподключить WARP (новый exit), OpenCode не трогается
zen-ip-switch daemon           фоновый polling: при 429/403 автоматически ротирует, следит за privoxy
zen-ip-switch stop             остановить фоновый polling
zen-ip-switch stats            последние ротации и probe из SQLite
```

## Устройство

### on
1. `ensure_opencode_app`: проверяет что `OpenCode.app` установлен, иначе внятная ошибка.
2. `ensure_warp`: `brew install --cask cloudflare-warp` если нет.
3. `ensure_proxy_mode`: `warp-cli mode proxy`, порт `127.0.0.1:${ZEN_WARP_PROXY_PORT}` (40000).
4. `ensure_privoxy`: `brew install privoxy` если нет.
5. `warp-cli connect` + ждёт `Connected`.
6. `start_privoxy`: пишет конфиг с `forward-socks5t / 127.0.0.1:40000 .` и `debug 1 + 512` для access-лога, запускает демона, сохраняет pid.
7. Пробный probe к Zen через SOCKS - если 429, предлагает `rotate`.
8. Если OpenCode открыт без прокси env - `osascript tell app quit`, kill сайдкара (он PPID=1, launchd его adopt'ает и переживает quit UI), ждёт закрытия до 15 сек, запускает заново через `open -a OpenCode --env ALL_PROXY=http://127.0.0.1:8787 --env HTTPS_PROXY=... --env HTTP_PROXY=...`. Если открыт уже с прокси - ничего не трогает.

### rotate
1. Проверяет что WARP `Connected`.
2. До `ZEN_MAX_ROTATE_TRIES` (5) циклов `disconnect`/`connect`. На каждом новом exit probe к Zen. Первый 200 закрепляется, 429 - крутим.
3. OpenCode не трогает: keep-alive к `127.0.0.1:8787` живой, снаружи privoxy сам пойдёт в новый WARP exit.

### off
1. `warp-cli disconnect`.
2. `stop_privoxy`.
3. Если OpenCode был с прокси env - перезапускает без env (иначе сайдкар упрётся в несуществующий HTTP-прокси и покажет ConnectionRefused).

### daemon
Фоновый `nohup $0 _loop`. Каждые `ZEN_POLL_SECS` (120) делает probe. Что делает:

- Если `warp_connected`, но `privoxy_running` = false - **сам поднимает privoxy** (чтобы падение моста не ломало UI).
- 429 на WARP exit - автоматически `rotate auto`.
- 403 на WARP exit - `rotate auto403` (вдруг следующий exit в другой стране обойдёт `countryNotAllowed`).
- 5xx от upstream - пропускает (ротация не поможет).
- `ZEN_AUTO_OFF_IDLE_MINS` > 0 и OpenCode закрыт столько минут - автоматический `off` и выход.
- `trap EXIT INT TERM` чистит pid-файл при любом завершении.
- Внутри loop `set +e`: падение любого curl/sqlite не убивает демон.

### stop
Рекурсивный `kill_tree` по дереву pid'а - убивает демон вместе с любым запущенным им `rotate`.

### status
Шесть секций: прямой IP, WARP (connect статус + exit через SOCKS и через HTTP отдельно), privoxy (pid), OpenCode.app (env сайдкара построчно), последние 5 уникальных CONNECT через privoxy (из `privoxy.log`), демон, пробный Zen.

### stats
Три SELECT из `metrics.db`: последние 10 ротаций, распределение HTTP-кодов probe за сутки, последние 10 probe.

## Переменные окружения

```
ZEN_STATE_DIR            каталог для sqlite, pid, конфигов и логов (~/.local/share/zen-ip-switch)
ZEN_POLL_SECS            интервал polling для daemon (120)
ZEN_IP_WAIT_SECS         сколько ждать подключения WARP (20)
ZEN_MAX_ROTATE_TRIES     сколько попыток найти свободный exit (5)
ZEN_WARP_PROXY_PORT      порт SOCKS5 для WARP (40000)
ZEN_PRIVOXY_PORT         порт HTTP для privoxy (8787)
ZEN_APP_QUIT_WAIT        сколько ждать закрытия OpenCode.app перед принудительным (15)
ZEN_AUTO_OFF_IDLE_MINS   автоматически off если OpenCode закрыт столько минут подряд (0 = выключено)
ZEN_OPENCODE_APP_BIN     путь к OpenCode (/Applications/OpenCode.app/Contents/MacOS/OpenCode)
```

## Диагностика

- `warp-cli status` висит в `Unable: DNS Lookup Failed` - DoH до `1.1.1.1` режется роутером. В 1.1.1.1.app переключи режим на `WARP` без DoH, SOCKS подхватывается.
- Все 5 попыток `rotate` - 429 - вся WARP-зона перегружена, подожди или ротни через час (сброс квоты Zen в 00:00 UTC).
- `fledge-alpha-free` отдаёт 403 `countryNotAllowed` - модель закрыта в твоей стране. daemon сам попробует другой exit.
- Сайдкар стартует без прокси env - проверь `status`, секция `OpenCode.app`. Если показывает "у сайдкара нет *_PROXY env" - open --env по какой-то причине не донёс. Запусти бинарник руками: `env ALL_PROXY=http://127.0.0.1:8787 /Applications/OpenCode.app/Contents/MacOS/OpenCode &`.
- privoxy мёртв, UI показывает ConnectionRefused к 127.0.0.1:8787 - запусти daemon, он сам поднимет мост. Либо `off` + `on`.

## Чем отличается от [alztrk/opencode-ip-rotator](https://github.com/alztrk/opencode-ip-rotator)

Тот проект - Docker-микросервис с FastAPI-прокси перед клиентом, дашбордом, пулом внешних прокси и ephemeral-контейнерами для свежего `machine-id`. Клиент настраивается на `http://127.0.0.1:8000/v1`. Если прожигаешь много токенов и готов держать Docker-рантайм, бери его.

Этот скрипт - лёгкий инструмент для одного клиента на одном маке:

- один bash-файл;
- не меняет OpenCode-конфиг: сайдкар ходит на `opencode.ai` как раньше, прокси идёт через `ALL_PROXY` env;
- не нужен Docker, Python, FastAPI;
- не ломает маршрутизацию и корпоративные VPN;
- rotate без перезапуска OpenCode (keep-alive к локальному privoxy целый).

## Ограничения

- Прокси работает только для `opencode-cli`. Остальные приложения ходят прямо.
- Квота на новом Cloudflare exit не бесконечна. Там тоже бывает 429, помогает `rotate` или ожидание.
- WARP SOCKS иногда рвётся при переходе Wi-Fi сетей или долгом idle - у сайдкара ConnectionRefused на `127.0.0.1:40000`. daemon переподнимет privoxy, но WARP восстанови вручную: `off` + `on`.
- После ребута мака ничего не стартует само. Запусти `on` после включения. Можно повесить в login items через Shortcuts/launchd plist, если нужно.
- Для стабильной долгой работы без ограничений нужна подписка Zen или свой ключ провайдера.
