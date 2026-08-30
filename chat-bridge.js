/**
 * Socket.IO -> Discord chat bridge (guest-visible global chat version)
 * 
 * Strategy:
 *   1. Launch headless Chrome (no visible window needed - no login step).
 *   2. Navigate to the game, find and click the "global chat" button.
 *   3. Use Chrome DevTools Protocol to read the raw WebSocket frames the
 *      page's own Socket.IO connection sends/receives, and parse out
 *      gotGlobalRoomMessage events from those.
 *   4. Forward each parsed message to a Discord webhook.
 *
 * Setup:
 *   have node.js installed.
 *   Execute:   npm install puppeteer node-fetch
 *   Replace the const DISCORD_WEBHOOK_URL with your webhook url.
 *
 * Run:
 *   Make sure your commandprompt or bash is in the right file directory that has this file.
 *   Execute:  node chat-bridge.js
 */

const puppeteer = require("puppeteer");
// Using Node's built-in fetch (Node 18+) - no node-fetch package needed.

// ---- CONFIG ----------------------------------------------------------

const GAME_URL = "https://s0urce.io";
const DISCORD_WEBHOOK_URL =
  "PUT WEBHOOK URL HERE";

// CSS selector for the button/element that opens global chat.
// Find this by right-clicking the chat button in your browser -> Inspect,
// then right-click the highlighted HTML -> Copy -> Copy selector.
const GLOBAL_CHAT_BUTTON_SELECTOR = 'img[alt="Global Chat Desktop Icon"]';

// How often to re-check the connection is alive and reopen chat if needed
// (in case of reconnects), in milliseconds.
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ---- MAIN --------------------------------------------------------------

(async () => {
  const browser = await puppeteer.launch({
    headless: true, // no GUI needed now that no login is required
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const client = await page.target().createCDPSession();

  await client.send("Network.enable");

  const socketIds = new Set();

  client.on("Network.webSocketCreated", ({ requestId, url }) => {
    if (url.includes("socket.io")) {
      socketIds.add(requestId);
      console.log(`[bridge] tracking socket.io connection: ${url}`);
    }
  });

  client.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    if (!socketIds.has(requestId)) return;
    handleFrame(response.payloadData);
  });

  await page.goto(GAME_URL, { waitUntil: "networkidle2" });

  // Give the Svelte app a moment to finish rendering after network idle.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Enter the game as a guest: fill in a name and click Play.
  try {
    await page.waitForSelector('input[placeholder="Enter name"]', { timeout: 15000 });
    await page.type('input[placeholder="Enter name"]', "ChatBridgeBot");

    // Find the Play button by its visible text, since it has no unique id/class shown.
    const playButton = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.textContent.trim() === "Play");
    });
    if (playButton) {
      await playButton.asElement().click();
      console.log("[bridge] entered game as guest");
    } else {
      console.error("[bridge] could not find Play button");
    }

    // Give the game world a moment to load after clicking Play.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (err) {
    console.error("[bridge] could not get past the guest name/Play screen:", err.message);
  }

  // DEBUG: capture what the page actually looks like / contains right now.
  await page.screenshot({ path: "debug.png", fullPage: true });
  const html = await page.content();
  require("fs").writeFileSync("debug.html", html);
  console.log("[bridge] wrote debug.png and debug.html for inspection");

  // Open the global chat panel so the game starts streaming events.
  try {
    await page.waitForSelector(GLOBAL_CHAT_BUTTON_SELECTOR, { timeout: 30000 });
    await page.click(GLOBAL_CHAT_BUTTON_SELECTOR);
    console.log("[bridge] clicked global chat button");
  } catch (err) {
    console.error(
      "[bridge] could not find/click the chat button - check GLOBAL_CHAT_BUTTON_SELECTOR:",
      err.message
    );
  }

  console.log("[bridge] listening for chat events...");

  // Periodically make sure the tab hasn't gone stale/idle.
  setInterval(async () => {
    try {
      await page.evaluate(() => document.title); // cheap liveness check
    } catch (err) {
      console.error("[bridge] page seems dead, exiting for restart:", err.message);
      process.exit(1); // let pm2/NSSM restart it
    }
  }, HEALTH_CHECK_INTERVAL_MS);
})();

// ---- FRAME PARSING -------------------------------------------------------

function handleFrame(raw) {
  // Socket.IO text frames look like: 42["event",{...}]
  // "4" = Engine.IO "message" packet, "2" = Socket.IO "event" packet.
  if (typeof raw !== "string" || !raw.startsWith("42")) return;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(2));
  } catch {
    return; // not JSON, ignore
  }

  // Expected shape: ["event", { event: "gotGlobalRoomMessage", arguments: [...] }]
  const [, body] = parsed;
  if (!body || body.event !== "gotGlobalRoomMessage") return;

  const msg = body.arguments?.[0];
  if (!msg) return;

  const sender = msg.sender?.username ?? "Unknown";
  const content = msg.content ?? "";
  const date = msg.date ?? new Date().toISOString();

  console.log(`[chat] ${sender}: ${content}`);
  forwardToDiscord(sender, content, date).catch((err) =>
    console.error("[discord] forward failed:", err)
  );
}

// ---- DISCORD FORWARDING -------------------------------------------------

async function forwardToDiscord(sender, content, date) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: sender, content }),
  });

  if (!res.ok) {
    console.error(`[discord] webhook failed: ${res.status} ${await res.text()}`);
  }
}