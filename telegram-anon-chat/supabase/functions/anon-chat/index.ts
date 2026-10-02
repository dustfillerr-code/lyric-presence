// NOIR · Анонимный чат — Telegram bot on a Supabase Edge Function.
//
// Bot token: the TELEGRAM_BOT_TOKEN secret, or else the 'bot_token' row in
// public.tg_config. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY come from Supabase.
//
// One-time setup: open <function-url>?setup=1 in a browser. That registers the
// webhook, the command menu and the bot's profile descriptions.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { answer, loadToken, send, tg } from "./tg.ts";
import { ADMIN_ID, BTN, T } from "./texts.ts";
import { ensureUser, onUserCallback, onUserMessage } from "./user.ts";
import { isAdmin, onAdminCallback, onAdminInput, openAdmin } from "./admin.ts";

// Telegram webhook secret, derived from the bot token so only one secret is needed.
async function webhookSecret(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("anon-chat:" + token));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function setup(token: string) {
  const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/anon-chat`;
  const results = {
    setWebhook: await tg("setWebhook", {
      url: hookUrl,
      secret_token: await webhookSecret(token),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
    setMyCommands: await tg("setMyCommands", {
      commands: [
        { command: "start", description: "🖤 Главное меню" },
        { command: "find", description: "🎲 Случайный собеседник" },
        { command: "rp", description: "🎭 Ролевая игра" },
        { command: "next", description: "⏭ Следующий собеседник" },
        { command: "stop", description: "⛔ Завершить диалог" },
        { command: "me", description: "✦ Действие персонажа" },
        { command: "dice", description: "🎲 Бросить кубики" },
        { command: "profile", description: "👤 Профиль" },
        { command: "settings", description: "⚙️ Настройки" },
        { command: "report", description: "🚩 Пожаловаться" },
        { command: "rules", description: "📜 Правила" },
      ],
    }),
    setMyShortDescription: await tg("setMyShortDescription", {
      short_description: "🖤 Анонимный чат и ролевые игры со случайными людьми. Без имён и без пересылки сообщений.",
    }),
    setMyDescription: await tg("setMyDescription", {
      description:
        "🖤 NOIR — закрытый клуб анонимного общения\n\n" +
        "🕶 Собеседник не видит ваше имя, ник и фото\n" +
        "🎭 10 ролевых сюжетов: космос, нуар, фэнтези, хоррор…\n" +
        "🔒 Сообщения защищены от пересылки\n" +
        "⭐ Карма и оценки собеседников\n" +
        "🛡 Модерация и защита от нарушителей\n\n" +
        "Нажмите «Начать», чтобы войти в клуб.",
    }),
  };
  await tg("setMyCommands", {
    scope: { type: "chat", chat_id: ADMIN_ID },
    commands: [
      { command: "admin", description: "🛡 Админ-панель" },
      { command: "start", description: "🖤 Главное меню" },
      { command: "find", description: "🎲 Случайный собеседник" },
      { command: "rp", description: "🎭 Ролевая игра" },
      { command: "stop", description: "⛔ Завершить диалог" },
    ],
  });
  return Response.json({ webhook: hookUrl, ...results });
}

async function onMessage(msg: any) {
  if (msg.chat?.type !== "private" || !msg.from) return;
  const u = await ensureUser(msg.from);

  if (u.banned) {
    await send(u.chat_id, T.banned, { remove_keyboard: true });
    return;
  }

  if (isAdmin(u.chat_id)) {
    const text: string = msg.text ?? "";
    if (await onAdminInput(u, msg)) return;
    if (text === "/admin" || text === BTN.admin) {
      await openAdmin(u.chat_id);
      return;
    }
  }

  await onUserMessage(u, msg);
}

async function onCallback(cq: any) {
  if (!cq.message || !cq.from) return void await answer(cq.id);
  const data: string = cq.data ?? "";

  if (data.startsWith("adm:")) {
    if (!isAdmin(cq.from.id)) return void await answer(cq.id, "⛔ Нет доступа", true);
    return onAdminCallback(cq);
  }

  const u = await ensureUser(cq.from);
  if (u.banned) return void await answer(cq.id, "🚫 Аккаунт заблокирован", true);
  await onUserCallback(u, cq);
}

Deno.serve(async (req) => {
  const token = await loadToken();
  if (!token) return new Response("Bot token is not configured", { status: 500 });

  if (req.method === "GET") {
    if (new URL(req.url).searchParams.has("setup")) return await setup(token);
    return new Response("🖤 NOIR bot is running.");
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret(token)) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const update = await req.json();
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (err) {
    console.error(err);
  }
  // Always 200 so Telegram doesn't retry the same update forever.
  return new Response("ok");
});
