<p align="center">
  <img src="icon.svg" alt="Robosats Watcher Logo" width="21%">
</p>

# RoboSats Order Watcher

Tiny private helper for watching a RoboSats order through your self-hosted RoboSats client proxy.

Allows a simple monitoring tool such as Uptime Kuma to be used to generate custom notifications.

## How It Works

The watcher:

1. derives RoboSats' Base91 `tokenSHA256` from your robot token, or uses a pasted `tokenSha256Base91`,
2. checks each configured coordinator's `/api/robot/` endpoint through your self-hosted RoboSats proxy,
3. discovers `active_order_id`,
4. checks `/api/order/?order_id=...`,
5. returns `ORDER_OK` while there is no active order or your active order is still public,
6. returns `ORDER_TAKEN` once the active order is no longer status `1`.

## Configure

Copy the example config:

```sh
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "baseUrl": "https://mystart9.local:57710",
  "network": "mainnet",
  "coordinators": ["temple", "lake", "moon", "bazaar", "freedomsats", "alice"],
  "robotToken": "paste your RoboSats robot token here",
  "tokenSha256Base91": "",
  "rejectUnauthorized": false,
  "timeoutMs": 20000,
  "listenHost": "0.0.0.0",
  "listenPort": 8787
}
```

Use either:

- `robotToken`: your normal RoboSats robot token, preferred because the watcher derives the Base91 API token itself.
- `tokenSha256Base91`: the 39 or 40 character API token from DevTools, if you do not want to store the robot token here.

Do not commit `config.json`.

## Run

With Node 18+:

```sh
npm start
```

With Docker:

```sh
docker compose -f docker-compose.example.yml up -d --build
```

Test:

```sh
curl http://127.0.0.1:8787/status
curl http://127.0.0.1:8787/json
```

## Uptime Kuma Monitor

Use the simplest monitor:

```text
Monitor Type: HTTP(s) - Keyword
URL: http://robosats-watcher:8787/status
Keyword: ORDER_OK
Invert Keyword: off
Accepted Status Codes: 200
Interval: 20s or 30s
Retries: 0 or 1
```

Kuma stays up while `/status` contains `ORDER_OK`.

When an active order is taken, `/status` changes to:

```text
ORDER_TAKEN
Order 86212 on temple is 3: Waiting for taker bond
Checked at: 2026-05-11T12:34:56.000Z

Active order details:
Coordinator: temple
Order ID: 86212
Status: 3 - Waiting for taker bond
Role: maker
Type: SELL
Order page: https://mystart9.local:57710/order/temple/86212
Amount: 100 currency 1
Sats now: 123456
Price now: 100000
Premium now: 1
Seconds to expire: 887
```

The `ORDER_OK` keyword disappears, so Kuma marks the monitor down and sends your notification.

For fuller machine-readable output, use:

```sh
curl http://127.0.0.1:8787/json
```

For raw coordinator API responses, useful when debugging expired or missing orders:

```sh
curl http://127.0.0.1:8787/raw
```

The watcher checks `active_order_id` first and falls back to `last_order_id`, so recent expired or cancelled orders can still be shown.

## Start9 Notes

Your self-hosted RoboSats app proxies public coordinators through paths like:

```text
/mainnet/temple/api/...
/mainnet/lake/api/...
/mainnet/moon/api/...
/mainnet/bazaar/api/...
/mainnet/freedomsats/api/...
/mainnet/alice/api/...
```

That is why `baseUrl` should point at your Start9 RoboSats frontend URL, not a public coordinator URL.
