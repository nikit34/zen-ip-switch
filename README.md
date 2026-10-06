# zen-ip-switch

Переключатель публичного IP для OpenCode Desktop на бесплатном тире Zen. Один bash-файл, Cloudflare WARP в proxy-режиме, SQLite-метрики, автоматическая ротация при 429.

## Зачем

OpenCode Zen free-tier (`space-bunny-free`, `mimo-*-free`, `muse-spark-*`, `nemotron-*`, `big-pickle`, `longcat-*-free` и так далее) считает квоту по IP: примерно 500-1000 запросов в сутки на общую корзину, сброс в 00:00 UTC. При исчерпании квоты шлюз отдаёт `429 FreeUsageLimitError`.

User-Agent, `x-opencode-client` и прочие заголовки на лимит не влияют: проверка в `packages/console/app/src/routes/zen/util/ipRateLimiter.ts` закомментирована (`headersExist = true`). Проекты, подменяющие UA с того же IP, упираются в тот же счётчик.

Этот скрипт поднимает Cloudflare WARP как **SOCKS5-прокси** на `127.0.0.1:40000` и перезапускает OpenCode.app с `ALL_PROXY=socks5h://127.0.0.1:40000`. Сайдкар `opencode-cli` ходит в Zen через WARP exit, его IP для шлюза - Cloudflare-овский. Остальной трафик системы (браузер, корпоративный VPN, Cisco AnyConnect, DNS на `*.lrxn.net`) не задет.

## Почему proxy, а не tunnel

Раньше скрипт включал WARP в обычном tunnel-режиме (MASQUE или WireGuard через `utun`). На системе с активным Cisco AnyConnect и корпоративными DNS это ломало маршрутизацию: часть трафика уходила в WARP, часть нет, `*.lrxn.net` переставал резолвиться, ping падал - фактически интернет пропадал.

В proxy-режиме WARP не трогает ни `default route`, ни DNS resolver. Весь трафик системы продолжает идти как раньше. SOCKS5 работает **только** для процессов, которым явно передан `ALL_PROXY`.

Бонус: при `rotate` keep-alive-пул сайдкара смотрит на `127.0.0.1:40000`, он не рвётся при смене WARP exit наружу - значит OpenCode не надо перезапускать на каждой ротации, никаких ECONNRESET/ConnectionRefused.

## Установка

Нужны macOS, Homebrew, `sqlite3` (есть в системе).

```bash
git clone https://github.com/nikit34/zen-ip-switch.git ~/zen-ip-switch
mkdir -p ~/bin
ln -s ~/zen-ip-switch/zen-ip-switch ~/bin/zen-ip-switch
```

Если `~/bin` нет в PATH, допиши `export PATH="$HOME/bin:$PATH"` в `~/.zshrc`.

## Команды

```
zen-ip-switch status           публичный IP, статус WARP SOCKS, OpenCode, пробный Zen
zen-ip-switch on               WARP proxy-mode + SOCKS + перезапуск OpenCode.app с ALL_PROXY
zen-ip-switch off              выключить WARP + перезапустить OpenCode.app без прокси
zen-ip-switch rotate [reason]  переподключить WARP (новый exit), OpenCode не трогается
zen-ip-switch daemon           фоновый polling: при 429 на WARP exit автоматически ротирует
zen-ip-switch stop             остановить фоновый polling
zen-ip-switch stats            последние ротации и probe из SQLite
```

## Как работает каждая команда

### on
1. Если нет `warp-cli` - ставит через `brew install --cask cloudflare-warp`.
2. Переводит WARP в `mode proxy`, задаёт порт `127.0.0.1:${ZEN_WARP_PROXY_PORT}` (по умолчанию 40000).
3. `warp-cli connect` + ждёт `Connected`.
4. Проверяет Zen через SOCKS. Если 429 - предлагает `rotate`.
5. Если OpenCode открыт без прокси env - вежливо закрывает через `osascript tell app quit` (сессия сохраняется), ждёт до 15 сек, запускает заново через `env ALL_PROXY=socks5h://127.0.0.1:40000 open` эквивалентом. Если открыт уже с прокси - ничего не трогает. Если закрыт - просто стартует с прокси.

### rotate
1. Проверяет что WARP уже подключен (иначе `on`).
2. До `ZEN_MAX_ROTATE_TRIES` (5) циклов `disconnect`/`connect`, на каждом новом exit делает probe к Zen. Первый 200 закрепляется, 429 - крутим дальше.
3. **OpenCode не перезапускает**: его keep-alive пул смотрит на `127.0.0.1:40000`, этот сокет живой; меняется только то, что торчит из WARP наружу.

### off
1. `warp-cli disconnect`.
2. Если OpenCode был запущен с прокси env - перезапускает его без прокси (иначе сайдкар будет упираться в несуществующий SOCKS и показывать ConnectionRefused).

### daemon
Фоновый `nohup` loop, каждые `ZEN_POLL_SECS` (120) делает probe. При 429 на WARP exit - автоматически `rotate auto`. При 5xx - пропускает (upstream болеет). Pid в `~/.local/share/zen-ip-switch/daemon.pid`, лог в `daemon.log`. `stop` рекурсивно убивает дерево.

### status
Показывает прямой IP, статус WARP, exit через SOCKS, запущен ли OpenCode и с прокси ли, статус демона, probe к Zen на свежей бесплатной модели.

### stats
Три таблицы из `~/.local/share/zen-ip-switch/metrics.db`: последние 10 ротаций, распределение HTTP-кодов probe за сутки, последние 10 probe.

## Переменные окружения

```
ZEN_STATE_DIR          каталог для sqlite и pid-файла (по умолчанию ~/.local/share/zen-ip-switch)
ZEN_POLL_SECS          интервал polling для daemon (120)
ZEN_IP_WAIT_SECS       сколько ждать подключения WARP (20)
ZEN_MAX_ROTATE_TRIES   сколько попыток найти свободный exit (5)
ZEN_WARP_PROXY_PORT    порт SOCKS5 для WARP (40000)
ZEN_APP_QUIT_WAIT      сколько ждать закрытия OpenCode.app перед принудительным (15)
```

## Диагностика

- `warp-cli status` висит в `Unable: DNS Lookup Failed` - DoH до `1.1.1.1` режется роутером. В приложении 1.1.1.1 переключи режим на `WARP` без DoH, SOCKS всё равно подхватывается.
- `on` даёт `429` на новом exit - этот Cloudflare exit тоже активно используется другими. `rotate`.
- Все 5 попыток `rotate` - 429 - вся WARP-зона перегружена, подожди час или день (сброс квоты у Zen в 00:00 UTC).
- `fledge-alpha-free` отдаёт 403 `countryNotAllowed` - модель закрыта в твоей стране на уровне Cloudflare `cf-ipcountry`. На WARP exit в разрешённой стране пройдёт.
- OpenCode.app не закрылся за 15 сек - значит висит на fetch'е или в модальном окне. Закрой руками (`cmd+Q`), потом `on` снова.
- Сайдкар не видит прокси (`status` показывает `сайдкар с прокси: 0`), хотя приложение перезапущено - проверь `ps eww -p <pid сайдкара>` на `ALL_PROXY=`. Если нет - macOS не пробросил env (редкая проблема launchd), запусти бинарник руками: `env ALL_PROXY=socks5h://127.0.0.1:40000 /Applications/OpenCode.app/Contents/MacOS/OpenCode &`.

## Чем отличается от [alztrk/opencode-ip-rotator](https://github.com/alztrk/opencode-ip-rotator)

Тот проект - Docker-микросервис с FastAPI-прокси перед клиентом, дашбордом, пулом внешних прокси и ephemeral-контейнерами для свежего `machine-id`. Клиент настраивается на `http://127.0.0.1:8000/v1`. Если прожигаешь много токенов и готов держать Docker-рантайм, бери его.

Этот скрипт - лёгкий инструмент для одного клиента на одном маке:

- один bash-файл;
- не меняет OpenCode-конфиг: сайдкар ходит на `opencode.ai`, прокси идёт через системный `ALL_PROXY`;
- не нужен Docker, Python, FastAPI;
- не ломает маршрутизацию и корпоративные VPN - WARP работает только в SOCKS-режиме;
- auto-rotate при 429, SQLite-метрики, auto-discovery моделей.

## Ограничения

- Прокси работает только для `opencode-cli`. Остальные приложения ходят прямо.
- Квота на новом Cloudflare exit не бесконечна. Там тоже бывает 429, помогает только `rotate` или ожидание.
- Если долго не пользуешься, WARP SOCKS отваливается (keep-alive к `127.0.0.1:40000` держится, но WARP может перепослать сессию). Тогда у сайдкара ConnectionRefused на SOCKS. Лечится `off` + `on` или просто `on`.
- Для стабильной долгой работы без ограничений нужна подписка Zen или свой ключ провайдера (Anthropic, DeepSeek, OpenAI) в `~/.config/opencode/opencode.json`.
