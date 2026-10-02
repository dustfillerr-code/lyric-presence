// Telegram Bot API + Supabase helpers shared by the user and admin flows.

import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cfg = { token: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "" };

export async function loadToken(): Promise<string> {
  if (!cfg.token) {
    const { data } = await db.from("tg_config").select("value").eq("key", "bot_token").maybeSingle();
    cfg.token = data?.value ?? "";
  }
  return cfg.token;
}

export type TgResult = { ok: boolean; result?: any; description?: string; error_code?: number };

export async function tg(method: string, body: Record<string, unknown>): Promise<TgResult> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as TgResult;
  if (!json.ok && !json.description?.includes("message is not modified")) {
    console.error(method, json.error_code, json.description);
  }
  return json;
}

// ── Keyboards ────────────────────────────────────────────────────────────

export type Button = { text: string; data?: string; url?: string };

export function inline(rows: Button[][]) {
  return {
    inline_keyboard: rows.map((r) =>
      r.map((b) => b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })
    ),
  };
}

export function reply(rows: string[][], placeholder?: string) {
  return {
    keyboard: rows.map((r) => r.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: placeholder,
  };
}

// ── Messaging ────────────────────────────────────────────────────────────

export function send(chat_id: number, text: string, markup?: unknown, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
    ...extra,
  });
}

export function edit(chat_id: number, message_id: number, text: string, markup?: unknown) {
  return tg("editMessageText", {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

export function answer(callback_query_id: string, text?: string, show_alert = false) {
  return tg("answerCallbackQuery", { callback_query_id, text, show_alert });
}

export function typing(chat_id: number) {
  return tg("sendChatAction", { chat_id, action: "typing" });
}

// ── Database ─────────────────────────────────────────────────────────────

export type User = {
  chat_id: number;
  status: "idle" | "waiting" | "chatting";
  partner_id: number | null;
  session_id: number | null;
  banned: boolean;
  alias: string | null;
  username: string | null;
  first_name: string | null;
  gender: "m" | "f" | "x";
  age_group: "teen" | "18" | "25" | "35" | null;
  seek_gender: "any" | "m" | "f";
  karma: number;
  chats_count: number;
  msgs_count: number;
  accepted_rules: boolean;
  pending: string | null;
  queue: string | null;
  last_queue: string | null;
  created_at: string;
  last_seen: string;
};

export type Session = {
  id: number;
  user_a: number;
  user_b: number;
  scenario: string | null;
  role_a: string | null;
  role_b: string | null;
  started_at: string;
  ended_at: string | null;
  ended_by: number | null;
  msg_count: number;
};

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function getUser(chatId: number): Promise<User | null> {
  const { data, error } = await db.from("tg_users").select("*").eq("chat_id", chatId).maybeSingle();
  if (error) throw error;
  return data as User | null;
}

export async function updateUser(chatId: number, patch: Partial<User>) {
  const { error } = await db.from("tg_users").update(patch).eq("chat_id", chatId);
  if (error) throw error;
}

export async function getSession(id: number): Promise<Session | null> {
  const { data, error } = await db.from("tg_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Session | null;
}

// ── Formatting ───────────────────────────────────────────────────────────

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function fmtTime(iso: string, withDate = false) {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "2-digit", month: "2-digit" } : {}),
  });
}

export function fmtDuration(fromIso: string, toIso?: string | null) {
  const ms = (toIso ? new Date(toIso) : new Date()).getTime() - new Date(fromIso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
