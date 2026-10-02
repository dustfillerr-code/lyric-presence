// Anonymous random-chat Telegram bot, running as a Supabase Edge Function.
//
// Required secret: TELEGRAM_BOT_TOKEN (from @BotFather).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// One-time setup: open  <function-url>?setup=1  in a browser. That registers
// this function as the bot's webhook and sets the command menu.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const WELCOME = `👋 Welcome to Anonymous Chat!

Chat with a random stranger. Neither of you sees the other's name, username or profile.

/find – find a random partner
/next – leave this chat and find a new partner
/stop – end the chat
/report – report your partner and leave

Be respectful. Users reported by several people get banned.
Never share personal info (phone, address, passwords).`;

// Telegram webhook secret, derived from the bot token so only one secret is needed.
async function webhookSecret(): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("anon-chat:" + BOT_TOKEN),
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as { ok: boolean; description?: string; error_code?: number };
}

const send = (chat_id: number, text: string) => tg("sendMessage", { chat_id, text });

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

async function getUser(chatId: number) {
  const { data, error } = await db.from("tg_users")
    .select("status, partner_id, banned").eq("chat_id", chatId).maybeSingle();
  if (error) throw error;
  return data as { status: string; partner_id: number | null; banned: boolean } | null;
}

async function endChat(chatId: number, partnerMsg: string) {
  const partner = await rpc<number | null>("tg_end_chat", { p_chat_id: chatId });
  if (partner) await send(partner, partnerMsg);
  return partner;
}

async function findPartner(chatId: number) {
  const partner = await rpc<number | null>("tg_find_partner", { p_chat_id: chatId });
  if (partner) {
    const msg = "✅ Partner found! Say hi.\n/next – new partner · /stop – end chat";
    await send(chatId, msg);
    await send(partner, msg);
  } else {
    await send(chatId, "🔎 Looking for a partner… you'll get a message when someone joins.\n/stop – cancel");
  }
}

async function handleMessage(msg: any) {
  if (msg.chat?.type !== "private") return;
  const chatId: number = msg.chat.id;
  const text: string = msg.text ?? "";
  const command = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;

  const user = await getUser(chatId);
  if (user?.banned) {
    await send(chatId, "🚫 You have been banned for receiving too many reports.");
    return;
  }

  switch (command) {
    case "/start":
    case "/help":
      await send(chatId, WELCOME);
      return;

    case "/find":
    case "/search":
      if (user?.status === "chatting") {
        await send(chatId, "You're already in a chat. Use /next for a new partner.");
      } else if (user?.status === "waiting") {
        await send(chatId, "🔎 Still looking for a partner…");
      } else {
        await findPartner(chatId);
      }
      return;

    case "/next":
      await endChat(chatId, "👋 Your partner left the chat.\n/find – find a new partner");
      await findPartner(chatId);
      return;

    case "/stop": {
      if (!user || user.status === "idle") {
        await send(chatId, "You're not in a chat. /find – find a partner");
        return;
      }
      await endChat(chatId, "👋 Your partner left the chat.\n/find – find a new partner");
      await send(chatId, "Chat ended.\n/find – find a new partner");
      return;
    }

    case "/report": {
      if (user?.status !== "chatting" || !user.partner_id) {
        await send(chatId, "You can only report your current partner.");
        return;
      }
      const reported = user.partner_id;
      await rpc("tg_report", { p_reporter: chatId, p_reported: reported });
      await endChat(chatId, "⚠️ Your partner reported you and left.\n/find – find a new partner");
      await send(chatId, "Thanks, your partner was reported and the chat ended.\n/find – find a new partner");
      return;
    }
  }

  // Not a known command: relay to the partner.
  if (user?.status !== "chatting" || !user.partner_id) {
    await send(
      chatId,
      user?.status === "waiting"
        ? "🔎 Still looking for a partner…"
        : "You're not in a chat. /find – find a partner",
    );
    return;
  }

  // copyMessage sends any content type without a "forwarded from" header.
  const res = await tg("copyMessage", {
    chat_id: user.partner_id,
    from_chat_id: chatId,
    message_id: msg.message_id,
  });
  if (!res.ok && res.error_code === 403) {
    // Partner blocked the bot.
    await rpc("tg_end_chat", { p_chat_id: chatId });
    await send(chatId, "👋 Your partner left the chat.\n/find – find a new partner");
  } else if (!res.ok) {
    await send(chatId, "⚠️ Couldn't deliver that message.");
  }
}

async function setup() {
  const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/anon-chat`;
  const hook = await tg("setWebhook", {
    url: hookUrl,
    secret_token: await webhookSecret(),
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  const cmds = await tg("setMyCommands", {
    commands: [
      { command: "find", description: "Find a random partner" },
      { command: "next", description: "Skip to a new partner" },
      { command: "stop", description: "End the current chat" },
      { command: "report", description: "Report partner and leave" },
      { command: "help", description: "How it works" },
    ],
  });
  return Response.json({ webhook: hookUrl, setWebhook: hook, setMyCommands: cmds });
}

Deno.serve(async (req) => {
  if (!BOT_TOKEN) {
    return new Response("TELEGRAM_BOT_TOKEN secret is not set", { status: 500 });
  }

  if (req.method === "GET") {
    if (new URL(req.url).searchParams.has("setup")) return await setup();
    return new Response("Anonymous chat bot is running.");
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret()) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const update = await req.json();
    if (update.message) await handleMessage(update.message);
  } catch (err) {
    console.error(err);
  }
  // Always 200 so Telegram doesn't retry the same update forever.
  return new Response("ok");
});
