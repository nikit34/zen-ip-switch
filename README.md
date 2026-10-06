# zen-ip-switch

Переключатель публичного IP для OpenCode Desktop на бесплатном тире Zen. Один bash-файл, системный WARP, SQLite-метрики, автоматическая ротация при 429.

## Зачем

OpenCode Zen free-tier (`space-bunny-free`, `mimo-*-free`, `muse-spark-*`, `nemotron-*`, `big-pickle`, `longcat-*-free` и так далее) считает квоту по IP: примерно 500-1000 запросов в сутки на общую корзину, сброс в 00:00 UTC. У моделей со своим rate limit отдельная корзина с суффиксом из первых двух букв id (`mi` для mimo, `mu` для muse-spark). При исчерпании квоты шлюз отдаёт `429 FreeUsageLimitError`.

User-Agent, `x-opencode-client` и прочие заголовки на лимит не влияют: проверка в `packages/console/app/src/routes/zen/util/ipRateLimiter.ts` закомментирована (`headersExist = true`). Проекты, подменяющие UA с того же IP, упираются в тот же счётчик.

Этот скрипт переводит системный трафик на Cloudflare WARP, за счёт чего публичный IP становится Cloudflare-овским, и шлюз видит нового клиента со свежей корзиной.

## Чем отличается от [alztrk/opencode-ip-rotator](https://github.com/alztrk/opencode-ip-rotator)

Тот проект - полноценный Docker-микросервис с FastAPI-прокси, дашбордом, пулом внешних прокси и ephemeral-контейнерами для свежего `machine-id`. Если прожигаешь много токенов и готов держать Docker-рантайм, бери его.

Этот скрипт - лёгкий инструмент для одного клиента на одном маке:

- один bash-файл, читается за минуту;
- не меняет client config: OpenCode Desktop ходит в `opencode.ai` напрямую, WARP перехватывает на уровне `utun`;
- не нужен Docker, Python, FastAPI;
- без веб-дашборда, статистика в sqlite3-таблицах;
- auto-rotate при 429, flow guard, auto-discovery моделей, verify по смене IP.

## Установка

Нужны macOS, Homebrew, запущенное приложение OpenCode (сайдкар `opencode-cli serve --service`), `sqlite3` (есть в системе).

```bash
git clone https://github.com/nikit34/zen-ip-switch.git ~/zen-ip-switch
mkdir -p ~/bin
ln -s ~/zen-ip-switch/zen-ip-switch ~/bin/zen-ip-switch
```

Если `~/bin` нет в PATH, допиши `export PATH="$HOME/bin:$PATH"` в `~/.zshrc`.

## Команды

```
zen-ip-switch status           публичный IP, статус WARP, активные соединения, пробный Zen
zen-ip-switch on               включить WARP, проверить Zen, перезапустить opencode-cli
zen-ip-switch rotate [reason]  переподключить WARP с проверкой нового IP и свободного exit
zen-ip-switch off              выключить WARP, вернуть прямое соединение
zen-ip-switch daemon           фоновый polling: при 429 автоматически ротирует
zen-ip-switch stop             остановить фоновый polling
zen-ip-switch stats            последние ротации и probe из SQLite
```

## Механизмы

### Auto-discovery моделей

`status`, `on` и `rotate` берут список бесплатных моделей из `GET /zen/v1/models` и выбирают первую доступную (приоритет: `space-bunny-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `longcat-2.5-preview-free`). Если список недоступен, падает на `space-bunny-free`. `jev-*` исключается - они на `/v1/systemone`, не на `/chat/completions`.

### Verify по смене IP

WARP на macOS подолгу висит в `Connecting: Performing connectivity checks`, пока маршрутизация уже работает. Поэтому успехом считается не строка статуса, а то, что `api.ipify.org` вернул IP, отличный от предыдущего. Ждём до `ZEN_IP_WAIT_SECS` секунд (по умолчанию 20).

### Rotate с проверкой свободного exit

`rotate` делает до `ZEN_MAX_ROTATE_TRIES` (по умолчанию 5) циклов disconnect/connect. На каждом новом exit делается probe к Zen. Если `200` - сохраняем, если `429` - крутим дальше. Если за 5 попыток не нашёл свободный - рапортует и выходит с кодом ошибки.

### Flow guard

Перед ротацией смотрим `lsof -iTCP:443`: если есть открытые соединения процесса `opencode-cli`, ждём до `ZEN_FLOW_WAIT_SECS` (60 сек) пока они закроются. Это защищает активный SSE-стрим от обрыва. По таймауту ротируем всё равно, с предупреждением.

### Daemon

`daemon` запускает фоновый loop через `nohup`, каждые `ZEN_POLL_SECS` (120 сек) делает probe. При `429` автоматически вызывает `rotate auto`. Pid в `~/.local/share/zen-ip-switch/daemon.pid`, лог в `daemon.log`. `stop` его убивает.

### SQLite метрики

Все probe и ротации пишутся в `~/.local/share/zen-ip-switch/metrics.db`:

```sql
rotations(ts, before_ip, after_ip, zen_before, zen_after, model, reason)
probes(ts, ip, model, code)
```

`stats` показывает последние 10 ротаций, распределение кодов за сутки и последние 10 probe.

## Переменные окружения

```
ZEN_STATE_DIR          каталог для sqlite и pid-файла (по умолчанию ~/.local/share/zen-ip-switch)
ZEN_POLL_SECS          интервал polling для daemon (120)
ZEN_FLOW_WAIT_SECS     сколько ждать свободных соединений перед ротацией (60)
ZEN_IP_WAIT_SECS       сколько ждать смены IP после connect (20)
ZEN_MAX_ROTATE_TRIES   сколько попыток найти свободный exit (5)
```

## Диагностика

- `warp-cli status` висит в `Unable: DNS Lookup Failed` - DoH до `1.1.1.1` режется роутером. В приложении 1.1.1.1 переключи режим на `1.1.1.1 with WARP` или `WARP` без DoH. Публичный IP всё равно остаётся Cloudflare-овским.
- Zen 200 через WARP, но клиент получает 429 - сайдкар держит keep-alive. `on` и `rotate` его перезапускают сами, иначе: `pkill -f "opencode-cli serve --service"`.
- `rotate` все 5 попыток выдаёт 429 - этот регион WARP уже активно используется другими клиентами Zen. Подожди час или смени провайдера.
- `fledge-alpha-free` отдаёт 403 `countryNotAllowed` - модель закрыта в твоей стране на уровне Cloudflare `cf-ipcountry`. На WARP exit в разрешённой стране пройдёт.

## Ограничения

- Не трогает системный HTTP/HTTPS proxy. WARP работает на уровне маршрутизации через `utun`, все процессы ходят прозрачно - значит, Zen обходят и другие приложения, пока WARP включён. Через `off` или дашборд приложения 1.1.1.1 возвращаешься назад.
- Квота на новом IP не бесконечна. Cloudflare exits делятся между многими клиентами, они тоже бьются об 429.
- Для стабильной долгой работы нужна подписка Zen или свой ключ провайдера (Anthropic, DeepSeek, OpenAI) в `~/.config/opencode/opencode.json`.
