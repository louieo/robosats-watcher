import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const DEFAULT_CONFIG_PATH = new URL("./config.json", import.meta.url);
const STATUS_LABELS = {
  0: "Waiting for maker bond",
  1: "Public",
  2: "Paused",
  3: "Waiting for taker bond",
  4: "Cancelled",
  5: "Expired",
  6: "Waiting for trade collateral and buyer invoice",
  7: "Waiting only for seller trade collateral",
  8: "Waiting only for buyer invoice",
  9: "Sending fiat - In chatroom",
  10: "Fiat sent - In chatroom",
  11: "In dispute",
  12: "Collaboratively cancelled",
  13: "Sending satoshis to buyer",
  14: "Successful trade",
  15: "Failed lightning network routing",
  16: "Wait for dispute resolution",
  17: "Maker lost dispute",
  18: "Taker lost dispute"
};

const BASE91_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~\"";

function base91Encode(buffer) {
  let queue = 0;
  let bits = 0;
  let output = "";

  for (const byte of buffer) {
    queue |= byte << bits;
    bits += 8;

    if (bits > 13) {
      let value = queue & 8191;
      if (value > 88) {
        queue >>= 13;
        bits -= 13;
      } else {
        value = queue & 16383;
        queue >>= 14;
        bits -= 14;
      }

      output += BASE91_ALPHABET[value % 91] + BASE91_ALPHABET[Math.floor(value / 91)];
    }
  }

  if (bits) {
    output += BASE91_ALPHABET[queue % 91];
    if (bits > 7 || queue > 90) {
      output += BASE91_ALPHABET[Math.floor(queue / 91)];
    }
  }

  return output;
}

function tokenSha256Base91(robotToken) {
  const digest = crypto.createHash("sha256").update(robotToken, "utf8").digest();
  return base91Encode(digest);
}

async function readConfig() {
  const configPath = process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);

  return {
    baseUrl: process.env.ROBOSATS_BASE_URL || config.baseUrl,
    network: process.env.ROBOSATS_NETWORK || config.network || "mainnet",
    coordinators: (process.env.ROBOSATS_COORDINATORS || config.coordinators || [])
      .toString()
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    robotToken: process.env.ROBOSATS_ROBOT_TOKEN || config.robotToken || "",
    tokenSha256Base91:
      process.env.ROBOSATS_TOKEN_SHA256_BASE91 || config.tokenSha256Base91 || "",
    rejectUnauthorized:
      process.env.REJECT_UNAUTHORIZED === undefined
        ? config.rejectUnauthorized !== false
        : process.env.REJECT_UNAUTHORIZED !== "false",
    timeoutMs: Number(process.env.TIMEOUT_MS || config.timeoutMs || 20000),
    listenHost: process.env.LISTEN_HOST || config.listenHost || "0.0.0.0",
    listenPort: Number(process.env.PORT || config.listenPort || 8787)
  };
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function buildApiUrl(config, coordinator, endpoint) {
  const base = normalizeBaseUrl(config.baseUrl);
  const network = encodeURIComponent(config.network);
  const alias = encodeURIComponent(coordinator);
  return `${base}/${network}/${alias}/api/${endpoint.replace(/^\/+/, "")}`;
}

function buildOrderPageUrl(config, coordinator, orderId) {
  const base = normalizeBaseUrl(config.baseUrl);
  const alias = encodeURIComponent(coordinator);
  return `${base}/order/${alias}/${encodeURIComponent(orderId)}`;
}

function extractToken(config) {
  if (config.tokenSha256Base91) {
    const match = config.tokenSha256Base91.match(/Token\s+([^|\s]+)/);
    return match ? match[1] : config.tokenSha256Base91.trim();
  }

  if (!config.robotToken || config.robotToken.includes("paste your RoboSats")) {
    throw new Error("Set robotToken or tokenSha256Base91 in config.json");
  }

  return tokenSha256Base91(config.robotToken);
}

async function fetchJson(url, token, config) {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      parsed,
      {
        method: "GET",
        timeout: config.timeoutMs,
        rejectUnauthorized: config.rejectUnauthorized,
        headers: {
          Accept: "application/json",
          Authorization: `Token ${token}`
        }
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = { nonJsonPreview: text.slice(0, 120) };
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            body,
            rawText: text
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${config.timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function checkCoordinator(config, coordinator, token) {
  const robotUrl = buildApiUrl(config, coordinator, "robot/");
  const robot = await fetchJson(robotUrl, token, config);

  if (!robot.ok || robot.body?.bad_request) {
    return {
      coordinator,
      ok: false,
      state: "ROBOT_UNAVAILABLE",
      httpStatus: robot.status,
      reason: robot.body?.bad_request || robot.body?.nonJsonPreview || "robot lookup failed",
      raw: {
        robotUrl,
        robotStatus: robot.status,
        robotBody: robot.body,
        robotRawText: robot.rawText
      }
    };
  }

  const orderId = robot.body?.active_order_id || robot.body?.last_order_id;
  const orderIdSource = robot.body?.active_order_id ? "active_order_id" : "last_order_id";
  if (!orderId) {
    return {
      coordinator,
      ok: true,
      state: "NO_ACTIVE_ORDER",
      raw: {
        robotUrl,
        robotStatus: robot.status,
        robotBody: robot.body,
        robotRawText: robot.rawText
      }
    };
  }

  const orderUrl = buildApiUrl(config, coordinator, `order/?order_id=${encodeURIComponent(orderId)}`);
  const order = await fetchJson(orderUrl, token, config);

  if (!order.ok || order.body?.bad_request) {
    return {
      coordinator,
      ok: false,
      state: "ORDER_UNAVAILABLE",
      orderId,
      orderIdSource,
      httpStatus: order.status,
      reason: order.body?.bad_request || order.body?.nonJsonPreview || "order lookup failed",
      raw: {
        robotUrl,
        robotStatus: robot.status,
        robotBody: robot.body,
        robotRawText: robot.rawText,
        orderUrl,
        orderStatus: order.status,
        orderBody: order.body,
        orderRawText: order.rawText
      }
    };
  }

  const status = Number(order.body?.status);
  return {
    coordinator,
    ok: true,
    state: status === 1 ? "ORDER_PUBLIC" : "ORDER_TAKEN",
    orderId,
    orderIdSource,
    status,
    statusLabel: STATUS_LABELS[status] || "Unknown",
    isMaker: Boolean(order.body?.is_maker),
    isTaker: Boolean(order.body?.is_taker),
    type: order.body?.type === 0 ? "BUY" : order.body?.type === 1 ? "SELL" : "UNKNOWN",
    currency: order.body?.currency,
    amount: order.body?.amount,
    hasRange: Boolean(order.body?.has_range),
    minAmount: order.body?.min_amount,
    maxAmount: order.body?.max_amount,
    price: order.body?.price,
    priceNow: order.body?.price_now,
    premium: order.body?.premium,
    premiumNow: order.body?.premium_now,
    satoshis: order.body?.satoshis,
    satoshisNow: order.body?.satoshis_now,
    expiresAt: order.body?.expires_at,
    secondsToExpire: order.body?.total_secs_exp,
    makerStatus: order.body?.maker_status,
    takerStatus: order.body?.taker_status,
    orderPageUrl: buildOrderPageUrl(config, coordinator, orderId),
    raw: {
      robotUrl,
      robotStatus: robot.status,
      robotBody: robot.body,
      robotRawText: robot.rawText,
      orderUrl,
      orderStatus: order.status,
      orderBody: order.body,
      orderRawText: order.rawText
    }
  };
}

async function checkAll() {
  const config = await readConfig();
  const token = extractToken(config);

  if (!config.baseUrl) throw new Error("Set baseUrl in config.json");
  if (!config.coordinators.length) throw new Error("Set at least one coordinator in config.json");

  const checks = await Promise.all(
    config.coordinators.map(async (coordinator) => {
      try {
        return await checkCoordinator(config, coordinator, token);
      } catch (error) {
        return {
          coordinator,
          ok: false,
          state: "CHECK_FAILED",
          reason: error.message
        };
      }
    })
  );

  const taken = checks.find((check) => check.state === "ORDER_TAKEN");
  const publicOrder = checks.find((check) => check.state === "ORDER_PUBLIC");
  const anyHealthy = checks.some((check) => check.ok);

  return {
    statusKeyword: !anyHealthy ? "WATCHER_ERROR" : taken ? "ORDER_TAKEN" : "ORDER_OK",
    alert: Boolean(taken),
    summary: taken
      ? `Order ${taken.orderId} on ${taken.coordinator} is ${taken.status}: ${taken.statusLabel}`
      : publicOrder
        ? `Order ${publicOrder.orderId} on ${publicOrder.coordinator} is still public`
        : anyHealthy
          ? "No active RoboSats order found"
          : "No coordinator checks succeeded",
    checks,
    checkedAt: new Date().toISOString()
  };
}

function formatOrderDetails(check) {
  const lines = [
    `Coordinator: ${check.coordinator}`,
    `Order ID: ${check.orderId}`,
    `Order ID source: ${check.orderIdSource}`,
    `Status: ${check.status} - ${check.statusLabel}`,
    `Role: ${check.isMaker ? "maker" : check.isTaker ? "taker" : "participant unknown"}`,
    `Type: ${check.type}`,
    `Order page: ${check.orderPageUrl}`
  ];

  if (check.amount !== undefined && check.amount !== null) {
    lines.push(`Amount: ${check.amount}${check.currency ? ` currency ${check.currency}` : ""}`);
  }
  if (check.hasRange) {
    lines.push(`Range: ${check.minAmount ?? "?"} - ${check.maxAmount ?? "?"}`);
  }
  if (check.satoshisNow || check.satoshis) {
    lines.push(`Sats now: ${check.satoshisNow ?? check.satoshis}`);
  }
  if (check.priceNow || check.price) {
    lines.push(`Price now: ${check.priceNow ?? check.price}`);
  }
  if (check.premiumNow !== undefined || check.premium !== undefined) {
    lines.push(`Premium now: ${check.premiumNow ?? check.premium}`);
  }
  if (check.secondsToExpire !== undefined && check.secondsToExpire !== null) {
    lines.push(`Seconds to expire: ${check.secondsToExpire}`);
  }
  if (check.expiresAt) {
    lines.push(`Expires at: ${check.expiresAt}`);
  }
  if (check.makerStatus) {
    lines.push(`Maker activity: ${check.makerStatus}`);
  }
  if (check.takerStatus) {
    lines.push(`Taker activity: ${check.takerStatus}`);
  }

  return lines;
}

function formatStatusText(result) {
  const lines = [result.statusKeyword, result.summary, `Checked at: ${result.checkedAt}`];
  const activeChecks = result.checks.filter((check) => check.orderId);

  if (activeChecks.length) {
    lines.push("", "Active order details:");
    for (const check of activeChecks) {
      lines.push(`Order status is: ${check.status} - ${check.statusLabel}`);
      lines.push(...formatOrderDetails(check));
    }
  } else {
    lines.push("", "No active order found on configured coordinators.");
  }

  const failedChecks = result.checks.filter((check) => !check.ok);
  if (failedChecks.length) {
    lines.push("", "Coordinator check issues:");
    for (const check of failedChecks) {
      lines.push(`${check.coordinator}: ${check.state}${check.reason ? ` - ${check.reason}` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(text);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/health") {
      sendText(response, 200, "OK\n");
      return;
    }

    if (url.pathname === "/json") {
      sendJson(response, 200, await checkAll());
      return;
    }

    if (url.pathname === "/raw") {
      const result = await checkAll();
      sendJson(response, 200, {
        statusKeyword: result.statusKeyword,
        summary: result.summary,
        checkedAt: result.checkedAt,
        raw: result.checks.map((check) => ({
          coordinator: check.coordinator,
          state: check.state,
          orderId: check.orderId,
          orderIdSource: check.orderIdSource,
          raw: check.raw
        }))
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      const result = await checkAll();
      sendText(response, 200, formatStatusText(result));
      return;
    }

    sendText(response, 404, "Not found\n");
  } catch (error) {
    sendText(response, 200, `WATCHER_ERROR\n${error.message}\n`);
  }
});

const bootConfig = await readConfig().catch(() => ({
  listenHost: process.env.LISTEN_HOST || "0.0.0.0",
  listenPort: Number(process.env.PORT || 8787)
}));

server.listen(bootConfig.listenPort, bootConfig.listenHost, () => {
  console.log(
    `RoboSats watcher listening on http://${bootConfig.listenHost}:${bootConfig.listenPort}`
  );
});
