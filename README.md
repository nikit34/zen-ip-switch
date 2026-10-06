# zen-ip-switch

Переключатель публичного IP для OpenCode Desktop на бесплатном тире Zen.

## Зачем

OpenCode Zen free-tier (`space-bunny-free`, `mimo-*-free`, `muse-spark-*`, `nemotron-*`, `big-pickle`, `longcat-*-free` и так далее) считает квоту по IP: примерно 500-1000 запросов в сутки на общую корзину, сброс в 00:00 UTC. У моделей со своим rate limit отдельная корзина с суффиксом из первых двух букв id (`mi` для mimo, `mu` для muse-spark, и так далее). При исчерпании квоты шлюз отдаёт `429 FreeUsageLimitError`.

User-Agent, `x-opencode-client` и прочие заголовки на лимит не влияют: проверка в `packages/console/app/src/routes/zen/util/ipRateLimiter.ts` закомментирована (`headersExist = true`). Проекты вроде `zen-proxy`, которые подменяют UA, с того же IP упираются в тот же счётчик.

Этот скрипт переводит системный трафик на Cloudflare WARP, за счёт чего публичный IP меняется на Cloudflare-овский, и шлюз видит нового клиента со свежей корзиной.

## Установка

Нужен macOS, Homebrew и запущенное приложение OpenCode (сайдкар `opencode-cli serve --service` живёт под `~/Library/Application Support/ai.opencode.desktop/cli/<version>/`).

```bash
git clone https://github.com/nikit34/zen-ip-switch.git ~/zen-ip-switch
ln -s ~/zen-ip-switch/zen-ip-switch ~/bin/zen-ip-switch
```

Если `~/bin` нет в PATH, допиши `export PATH="$HOME/bin:$PATH"` в `~/.zshrc`.

## Команды

```
zen-ip-switch status   показать текущий IP, статус WARP и ответ Zen одним пробным запросом
zen-ip-switch on       поставить WARP при необходимости, включить, перезапустить сайдкар
zen-ip-switch rotate   переподключить WARP, чтобы Cloudflare выдал другой exit
zen-ip-switch off      выключить WARP, вернуть прямое соединение
```

## Как это работает

1. Пробует внешний IP через `api.ipify.org`.
2. Если нет `warp-cli`, ставит `brew install --cask cloudflare-warp`.
3. Поднимает WARP (`warp-cli --accept-tos registration new` на первом запуске, затем `connect`). Ждёт до 20 секунд, считая успехом смену публичного IP, а не строку статуса (у WARP на macOS статус висит в `Connecting: Performing connectivity checks`, пока маршрутизация уже работает).
4. Делает один минимальный probe на `/zen/v1/chat/completions` с `max_tokens: 1` и выводит HTTP-код.
5. Если 200 - убивает `opencode-cli serve --service`, Electron поднимет его заново уже через новый IP.

## Диагностика

- `warp-cli status` висит в `Unable: DNS Lookup Failed` - на твоём роутере DoH до `1.1.1.1` иногда режется. Переключи в приложении 1.1.1.1 режим на `WARP` без DoH или `1.1.1.1 with WARP`. Публичный IP всё равно останется Cloudflare-овским.
- Zen 200 через WARP, но клиент всё равно получает 429 - сайдкар держит keep-alive. Убей его: `pkill -f "opencode-cli serve --service"`.
- Rate limit прилетает сразу на WARP IP - этот exit уже выжат другими. Запусти `zen-ip-switch rotate`.
- `fledge-alpha-free` отдаёт 403 `countryNotAllowed` - модель закрыта в твоей стране на уровне Cloudflare `cf-ipcountry`. На WARP exit в разрешённой стране пройдёт.

## Ограничения

- Не трогает системный HTTP/HTTPS proxy. WARP работает на уровне маршрутизации через `utun`, все процессы ходят прозрачно.
- SOCKS-туннель через хосты в твоей локалке бесполезен: они выходят через тот же роутер, публичный IP не меняется.
- Квота на новом IP не бесконечна. При интенсивной работе Cloudflare exits тоже бьются о `429` - сторонние пользователи WARP тоже ходят в Zen.
- Для стабильного продакшена нужна подписка Zen или свой ключ провайдера (Anthropic, DeepSeek, OpenAI) в `~/.config/opencode/opencode.json`.
