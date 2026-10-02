// Admin panel: statistics, live and archived dialogs with full transcripts,
// user cards, bans, reports, search and broadcast.

import {
  answer, clip, db, edit, esc, fmtDuration, fmtTime, getSession, getUser, inline, rpc, send, tg,
  updateUser, type Button, type Session, type User,
} from "./tg.ts";
import { ADMIN_ID, AGE, DOTS, GENDER, LINE, karmaBadge, scenarioById } from "./texts.ts";

const PAGE = 8;       // sessions per list page
const MSG_PAGE = 15;  // messages per transcript page

export const isAdmin = (id: number) => id === ADMIN_ID;

// ── Views (each returns [text, keyboard]) ────────────────────────────────

type View = [string, ReturnType<typeof inline>];

const back = (data = "adm:home"): Button[] => [{ text: "◀️ Назад", data }];

function homeView(): View {
  return [
    `🛡 <b>Админ-панель</b>
${LINE}
Полный контроль над клубом.
${DOTS}
<i>Выберите раздел:</i>`,
    inline([
      [{ text: "📊 Статистика", data: "adm:stats" }],
      [{ text: "🟢 Активные диалоги", data: "adm:act:0" }, { text: "🗂 Архив", data: "adm:arc:0" }],
      [{ text: "🚩 Жалобы", data: "adm:rep:0" }, { text: "🚫 Баны", data: "adm:bans:0" }],
      [{ text: "🔍 Найти пользователя", data: "adm:find" }],
      [{ text: "📢 Рассылка", data: "adm:bc" }],
    ]),
  ];
}

async function statsView(): Promise<View> {
  const s = await rpc<Record<string, number>>("tg_admin_stats");
  return [
    `📊 <b>Статистика клуба</b>
${LINE}
👥 Пользователей: <b>${s.users}</b>
🆕 Новых за сутки: <b>${s.new_today}</b>
🔥 Активных за сутки: <b>${s.active_today}</b>
${DOTS}
🟢 Сейчас в диалоге: <b>${s.chatting}</b>
🔍 В поиске: <b>${s.waiting}</b>
💬 Активных диалогов: <b>${s.active_sessions}</b>
${DOTS}
🗂 Диалогов всего: <b>${s.sessions_total}</b> (сегодня ${s.sessions_today})
🎭 Ролевых: <b>${s.rp_sessions}</b>
✉️ Сообщений: <b>${s.messages_total}</b> (сегодня ${s.messages_today})
${DOTS}
🚩 Жалоб: <b>${s.reports_total}</b>
🚫 Забанено: <b>${s.banned}</b>
${LINE}
🕐 <i>${fmtTime(new Date().toISOString(), true)} МСК</i>`,
    inline([[{ text: "🔄 Обновить", data: "adm:stats" }], back()]),
  ];
}

async function usersById(ids: number[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<number, User>();
  const { data } = await db.from("tg_users").select("*").in("chat_id", uniq);
  return new Map((data as User[] ?? []).map((u) => [u.chat_id, u]));
}

const short = (u?: User) => (u ? clip(u.alias ?? String(u.chat_id), 18) : "?");

function sessionLabel(s: Session, users: Map<number, User>) {
  const sc = scenarioById(s.scenario);
  const icon = s.ended_at ? "⚪" : "🟢";
  return `${icon} #${s.id} ${sc ? sc.emoji : "💬"} ${short(users.get(s.user_a))} ↔ ${short(users.get(s.user_b))} · ${s.msg_count}✉️`;
}

async function sessionListView(kind: "act" | "arc", page: number, userId?: number): Promise<View> {
  let q = db.from("tg_sessions").select("*", { count: "exact" });
  if (kind === "act") q = q.is("ended_at", null);
  if (kind === "arc" && !userId) q = q.not("ended_at", "is", null);
  if (userId) q = q.or(`user_a.eq.${userId},user_b.eq.${userId}`);
  const { data, count } = await q.order("id", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  const list = (data ?? []) as Session[];
  const users = await usersById(list.flatMap((s) => [s.user_a, s.user_b]));
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const title = userId
    ? `🗂 <b>Диалоги пользователя</b> <code>${userId}</code>`
    : kind === "act" ? "🟢 <b>Активные диалоги</b>" : "🗂 <b>Архив диалогов</b>";
  const base = userId ? `adm:us:${userId}` : `adm:${kind}`;

  const rows: Button[][] = list.map((s) => [{ text: sessionLabel(s, users), data: `adm:s:${s.id}:last` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: "◀️", data: `${base}:${page - 1}` });
  nav.push({ text: `${page + 1} / ${pages}`, data: `${base}:${page}` });
  if (page + 1 < pages) nav.push({ text: "▶️", data: `${base}:${page + 1}` });
  rows.push(nav);
  rows.push(back(userId ? `adm:u:${userId}` : "adm:home"));

  return [
    `${title}
${LINE}
Всего: <b>${total}</b>
${list.length ? "<i>Нажмите на диалог, чтобы прочитать переписку.</i>" : "<i>Здесь пока пусто.</i>"}`,
    inline(rows),
  ];
}

const KIND_ICON: Record<string, string> = {
  photo: "🖼 [фото]", video: "🎬 [видео]", voice: "🎙 [голосовое]", video_note: "⭕ [кружок]",
  sticker: "🔖 [стикер]", animation: "🎞 [GIF]", document: "📎 [файл]", audio: "🎵 [аудио]",
  location: "📍 [геолокация]", poll: "📊 [опрос]", other: "❔ [сообщение]",
};

function renderLine(m: any, s: Session) {
  const who = m.sender === s.user_a ? "🔵 A" : "🟣 B";
  const time = fmtTime(m.created_at);
  if (m.kind === "event" || m.kind === "dice" || m.kind === "action") {
    return `<code>${time}</code> ${who} ⚙️ <i>${esc(clip(m.body ?? "", 200))}</i>`;
  }
  const prefix = m.kind === "text" ? "" : `${KIND_ICON[m.kind] ?? KIND_ICON.other} `;
  return `<code>${time}</code> <b>${who}:</b> ${prefix}${esc(clip(m.body ?? "", 220))}`;
}

async function sessionView(sid: number, pageArg: string): Promise<View> {
  const s = await getSession(sid);
  if (!s) return [`❌ Диалог #${sid} не найден`, inline([back()])];

  const { count } = await db.from("tg_messages").select("id", { count: "exact", head: true }).eq("session_id", sid);
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / MSG_PAGE));
  const page = pageArg === "last" ? pages - 1 : Math.min(Math.max(0, Number(pageArg) || 0), pages - 1);

  const { data: msgs } = await db.from("tg_messages").select("*")
    .eq("session_id", sid).order("id", { ascending: true })
    .range(page * MSG_PAGE, page * MSG_PAGE + MSG_PAGE - 1);

  const users = await usersById([s.user_a, s.user_b]);
  const a = users.get(s.user_a);
  const b = users.get(s.user_b);
  const sc = scenarioById(s.scenario);
  const who = (u: User | undefined, id: number, role: string | null) =>
    `${esc(u?.alias ?? "?")}${u?.username ? ` (@${esc(u.username)})` : ""} <code>${id}</code>${role ? ` — <i>${esc(role)}</i>` : ""}`;

  let header = `💬 <b>Диалог #${s.id}</b> ${s.ended_at ? "⚪ завершён" : "🟢 идёт сейчас"}
${LINE}
🔵 A: ${who(a, s.user_a, s.role_a)}
🟣 B: ${who(b, s.user_b, s.role_b)}
${sc ? `🎭 ${sc.emoji} ${esc(sc.title)}\n` : ""}🕐 ${fmtTime(s.started_at, true)} · ⏱ ${fmtDuration(s.started_at, s.ended_at)} · ✉️ ${s.msg_count}
${DOTS}
`;
  const lines = (msgs ?? []).map((m) => renderLine(m, s));
  // Stay under Telegram's 4096-char limit without cutting through HTML tags.
  let cut = false;
  while (lines.length > 1 && header.length + lines.join("\n").length > 3900) {
    lines.shift();
    cut = true;
  }
  header += (cut ? "<i>…</i>\n" : "") + (lines.length ? lines.join("\n") : "<i>Сообщений пока нет.</i>");

  const nav: Button[] = [];
  if (page > 0) nav.push({ text: "⏮", data: `adm:s:${sid}:0` }, { text: "◀️", data: `adm:s:${sid}:${page - 1}` });
  nav.push({ text: `${page + 1} / ${pages}`, data: `adm:s:${sid}:${page}` });
  if (page + 1 < pages) nav.push({ text: "▶️", data: `adm:s:${sid}:${page + 1}` }, { text: "⏭", data: `adm:s:${sid}:last` });

  const rows: Button[][] = [nav];
  rows.push([{ text: "📎 Медиа диалога", data: `adm:m:${sid}` }, { text: "🔄 Обновить", data: `adm:s:${sid}:last` }]);
  rows.push([{ text: "👤 A", data: `adm:u:${s.user_a}` }, { text: "👤 B", data: `adm:u:${s.user_b}` }]);
  if (!s.ended_at) rows.push([{ text: "🔴 Завершить диалог", data: `adm:kill:${sid}` }]);
  rows.push(back(s.ended_at ? "adm:arc:0" : "adm:act:0"));
  return [header, inline(rows)];
}

async function userView(uid: number): Promise<View> {
  const u = await getUser(uid);
  if (!u) return [`❌ Пользователь <code>${uid}</code> не найден`, inline([back()])];
  const { count: reports } = await db.from("tg_reports").select("id", { count: "exact", head: true }).eq("reported", uid);
  const { count: filed } = await db.from("tg_reports").select("id", { count: "exact", head: true }).eq("reporter", uid);
  const status = u.banned ? "🚫 забанен" : u.status === "chatting" ? "🟢 в диалоге" : u.status === "waiting" ? "🔍 в поиске" : "💤 не активен";

  const rows: Button[][] = [];
  if (u.session_id) rows.push([{ text: "💬 Текущий диалог", data: `adm:s:${u.session_id}:last` }]);
  rows.push([{ text: "🗂 Все диалоги", data: `adm:us:${uid}:0` }]);
  rows.push([u.banned
    ? { text: "✅ Разбанить", data: `adm:unban:${uid}` }
    : { text: "🚫 Забанить", data: `adm:ban:${uid}` }]);
  rows.push(back());

  return [
    `👤 <b>Пользователь</b>
${LINE}
🎭 ${esc(u.alias ?? "—")}
🆔 <code>${u.chat_id}</code>
📛 ${esc(u.first_name ?? "—")}${u.username ? ` · @${esc(u.username)}` : ""}
${DOTS}
📍 Статус: <b>${status}</b>
${karmaBadge(u.karma)} · ⭐ <b>${u.karma}</b>
👤 ${GENDER[u.gender]} · 🎂 ${u.age_group ? AGE[u.age_group] : "—"}
${DOTS}
💬 Диалогов: <b>${u.chats_count}</b> · ✉️ Сообщений: <b>${u.msgs_count}</b>
🚩 Жалоб на него: <b>${reports ?? 0}</b> · подал: <b>${filed ?? 0}</b>
📅 Регистрация: ${fmtTime(u.created_at, true)}
👁 Был в сети: ${fmtTime(u.last_seen, true)}`,
    inline(rows),
  ];
}

async function reportsView(page: number): Promise<View> {
  const { data, count } = await db.from("tg_reports").select("*", { count: "exact" })
    .order("id", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  const list = data ?? [];
  const users = await usersById(list.flatMap((r: any) => [r.reporter, r.reported]));
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));

  const lines = list.map((r: any) =>
    `▸ <code>${fmtTime(r.created_at, true)}</code> ${esc(short(users.get(r.reporter)))} → <b>${esc(short(users.get(r.reported)))}</b>\n   ${r.reason ?? "—"}${r.session_id ? ` · #${r.session_id}` : ""}`
  );
  const rows: Button[][] = list.map((r: any) => [
    { text: `👤 ${short(users.get(r.reported))}`, data: `adm:u:${r.reported}` },
    ...(r.session_id ? [{ text: `💬 #${r.session_id}`, data: `adm:s:${r.session_id}:last` }] : []),
  ]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: "◀️", data: `adm:rep:${page - 1}` });
  nav.push({ text: `${page + 1} / ${pages}`, data: `adm:rep:${page}` });
  if (page + 1 < pages) nav.push({ text: "▶️", data: `adm:rep:${page + 1}` });
  rows.push(nav, back());

  return [
    `🚩 <b>Жалобы</b> (${count ?? 0})
${LINE}
${lines.length ? lines.join("\n") : "<i>Жалоб нет — клуб в порядке 🖤</i>"}`,
    inline(rows),
  ];
}

async function bansView(page: number): Promise<View> {
  const { data, count } = await db.from("tg_users").select("*", { count: "exact" })
    .eq("banned", true).order("last_seen", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  const list = (data ?? []) as User[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const rows: Button[][] = list.map((u) => [{
    text: `🚫 ${short(u)}${u.username ? ` @${u.username}` : ""}`,
    data: `adm:u:${u.chat_id}`,
  }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: "◀️", data: `adm:bans:${page - 1}` });
  nav.push({ text: `${page + 1} / ${pages}`, data: `adm:bans:${page}` });
  if (page + 1 < pages) nav.push({ text: "▶️", data: `adm:bans:${page + 1}` });
  rows.push(nav, back());
  return [
    `🚫 <b>Заблокированные</b> (${count ?? 0})
${LINE}
${list.length ? "<i>Нажмите, чтобы открыть карточку.</i>" : "<i>Список пуст.</i>"}`,
    inline(rows),
  ];
}

// ── Media re-send ────────────────────────────────────────────────────────

const SENDERS: Record<string, [string, string]> = {
  photo: ["sendPhoto", "photo"], video: ["sendVideo", "video"], voice: ["sendVoice", "voice"],
  video_note: ["sendVideoNote", "video_note"], sticker: ["sendSticker", "sticker"],
  animation: ["sendAnimation", "animation"], document: ["sendDocument", "document"], audio: ["sendAudio", "audio"],
};

async function sendMedia(chatId: number, sid: number) {
  const s = await getSession(sid);
  if (!s) return;
  const { data } = await db.from("tg_messages").select("*")
    .eq("session_id", sid).not("file_id", "is", null).order("id").limit(30);
  const list = data ?? [];
  if (!list.length) return void await send(chatId, `📎 В диалоге #${sid} нет медиа.`);
  await send(chatId, `📎 <b>Медиа диалога #${sid}</b> (${list.length})`);
  for (const m of list) {
    const [method, field] = SENDERS[m.kind] ?? ["sendDocument", "document"];
    const who = m.sender === s.user_a ? "🔵 A" : "🟣 B";
    const caption = `${who} · ${fmtTime(m.created_at, true)}${m.body && m.kind !== "sticker" ? `\n${esc(clip(m.body, 800))}` : ""}`;
    const extra = m.kind === "sticker" || m.kind === "video_note" ? {} : { caption, parse_mode: "HTML" };
    await tg(method, { chat_id: chatId, [field]: m.file_id, ...extra });
    if (!("caption" in extra)) await send(chatId, caption);
  }
}

// ── Router ───────────────────────────────────────────────────────────────

export async function openAdmin(chatId: number) {
  const [text, kb] = homeView();
  await send(chatId, text, kb);
}

export async function onAdminCallback(cq: any) {
  const chatId: number = cq.message.chat.id;
  const mid: number = cq.message.message_id;
  const [, view, a1, a2] = (cq.data as string).split(":");
  const show = async ([text, kb]: View) => void await edit(chatId, mid, text, kb);

  switch (view) {
    case "home":
      await updateUser(chatId, { pending: null });
      await answer(cq.id);
      return show(homeView());
    case "stats":
      await answer(cq.id, "Обновлено");
      return show(await statsView());
    case "act":
    case "arc":
      await answer(cq.id);
      return show(await sessionListView(view, Number(a1) || 0));
    case "us":
      await answer(cq.id);
      return show(await sessionListView("arc", Number(a2) || 0, Number(a1)));
    case "s":
      await answer(cq.id);
      return show(await sessionView(Number(a1), a2 ?? "last"));
    case "m":
      await answer(cq.id, "Отправляю медиа…");
      return sendMedia(chatId, Number(a1));
    case "u":
      await answer(cq.id);
      return show(await userView(Number(a1)));
    case "rep":
      await answer(cq.id);
      return show(await reportsView(Number(a1) || 0));
    case "bans":
      await answer(cq.id);
      return show(await bansView(Number(a1) || 0));

    case "kill": {
      const s = await getSession(Number(a1));
      if (s && !s.ended_at) {
        await rpc("tg_end_chat", { p_chat_id: s.user_a });
        const note = `🛡 <b>Диалог завершён модератором</b>\n${DOTS}\nНайти нового собеседника — в меню.`;
        await send(s.user_a, note);
        await send(s.user_b, note);
      }
      await answer(cq.id, "Диалог завершён");
      return show(await sessionView(Number(a1), "last"));
    }

    case "ban":
    case "unban": {
      const uid = Number(a1);
      const target = await getUser(uid);
      if (!target) return void await answer(cq.id, "Не найден");
      if (view === "ban") {
        if (target.status !== "idle") {
          const res = await rpc<{ partner: number | null }>("tg_end_chat", { p_chat_id: uid });
          if (res.partner) await send(res.partner, `👋 <b>Собеседник покинул диалог</b>\n${DOTS}\nНайти нового — в меню.`);
        }
        await updateUser(uid, { banned: true });
        await send(uid, `🚫 <b>Доступ ограничен</b>\n${LINE}\nВаш аккаунт заблокирован администрацией.`, { remove_keyboard: true });
        await answer(cq.id, "Пользователь забанен");
      } else {
        await updateUser(uid, { banned: false });
        await db.from("tg_reports").delete().eq("reported", uid);
        await send(uid, `✅ <b>Доступ восстановлен</b>\n${DOTS}\nДобро пожаловать обратно. Нажмите /start`);
        await answer(cq.id, "Пользователь разбанен");
      }
      return show(await userView(uid));
    }

    case "find":
      await updateUser(chatId, { pending: "find" });
      await answer(cq.id);
      return show([
        `🔍 <b>Поиск пользователя</b>\n${LINE}\nОтправьте ID, @username или псевдоним.`,
        inline([back()]),
      ]);

    case "bc":
      await updateUser(chatId, { pending: "bc" });
      await answer(cq.id);
      return show([
        `📢 <b>Рассылка</b>\n${LINE}\nОтправьте сообщение (текст, фото, видео — что угодно). Оно будет скопировано всем пользователям.`,
        inline([back()]),
      ]);
  }
  await answer(cq.id);
}

/** Handles admin text input for pending actions. Returns true if consumed. */
export async function onAdminInput(admin: User, msg: any): Promise<boolean> {
  if (!admin.pending) return false;
  const text: string = (msg.text ?? "").trim();
  if (text.startsWith("/")) {
    await updateUser(admin.chat_id, { pending: null });
    return false;
  }

  if (admin.pending === "find") {
    await updateUser(admin.chat_id, { pending: null });
    let q = db.from("tg_users").select("*").limit(10);
    if (/^-?\d+$/.test(text)) q = q.eq("chat_id", Number(text));
    else if (text.startsWith("@")) q = q.ilike("username", text.slice(1));
    else q = q.ilike("alias", `%${text.replace(/[%_]/g, "")}%`);
    const { data } = await q;
    const list = (data ?? []) as User[];
    if (list.length === 1) {
      const [t, kb] = await userView(list[0].chat_id);
      await send(admin.chat_id, t, kb);
    } else {
      await send(
        admin.chat_id,
        list.length ? `🔍 Найдено: <b>${list.length}</b>` : "🔍 Никого не найдено.",
        inline([
          ...list.map((u) => [{ text: `${short(u)}${u.username ? ` @${u.username}` : ""}`, data: `adm:u:${u.chat_id}` }]),
          back(),
        ]),
      );
    }
    return true;
  }

  if (admin.pending === "bc") {
    await updateUser(admin.chat_id, { pending: null });
    const { data } = await db.from("tg_users").select("chat_id").eq("banned", false);
    const ids = ((data ?? []) as { chat_id: number }[]).map((r) => r.chat_id);
    await send(admin.chat_id, `📢 Рассылка запущена: <b>${ids.length}</b> получателей…`);
    let ok = 0;
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const res = await Promise.all(batch.map((id) =>
        tg("copyMessage", { chat_id: id, from_chat_id: admin.chat_id, message_id: msg.message_id })
      ));
      ok += res.filter((r) => r.ok).length;
      if (i + 25 < ids.length) await new Promise((r) => setTimeout(r, 1100));
    }
    await send(admin.chat_id, `✅ <b>Рассылка завершена</b>\n${DOTS}\nДоставлено: <b>${ok}</b> из ${ids.length}`,
      inline([back()]));
    return true;
  }

  await updateUser(admin.chat_id, { pending: null });
  return false;
}
