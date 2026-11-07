const {
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  APP_URL: appUrl,
} = process.env;

const webhookPath = "/telegram/webhook";

async function registerWebhook() {
  if (!botToken || !webhookSecret || !appUrl) {
    throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL in the build environment.");
  }

  const url = URL.parse(appUrl);
  if (!url || url.protocol !== "https:" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("APP_URL must be the production HTTPS origin.");
  }

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must contain 1–256 letters, digits, underscores or hyphens.");
  }
  url.pathname = webhookPath;

  let response;
  let result;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.href,
        secret_token: webhookSecret,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
        max_connections: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    result = await response.json();
  } catch {
    throw new Error("Could not read the Telegram Bot API response.");
  }

  if (!response.ok || result?.ok !== true) {
    throw new Error(`Telegram rejected setWebhook (HTTP ${response.status}).`);
  }

  console.log("Telegram webhook registered.");
}

try {
  await registerWebhook();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
