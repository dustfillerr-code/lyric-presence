// User-facing flows: onboarding, search, chatting, roleplay tools, ratings.

import {
  answer, db, edit, esc, getSession, getUser, inline, pick, reply, rpc, send, tg, updateUser,
  type Session, type User,
} from "./tg.ts";
import {
  ADMIN_ID, AGE, BTN, DOTS, GENDER, GENERIC_TWISTS, LINE, REPORT_REASONS, ROLEPLAY_MENU, SCENARIOS, SEEK,
  T, TOPICS, matchCard, profileCard, randomAlias, roleplayMatchCard, scenarioById, scenarioPreview,
  settingsCard,
} from "./texts.ts";

// ── Keyboards ────────────────────────────────────────────────────────────

export function menuKb(u: User) {
  const rows: string[][] = [[BTN.random], [BTN.roleplay], [BTN.profile, BTN.settings, BTN.rules]];
  if (u.chat_id === ADMIN_ID) rows.push([BTN.admin]);
  return reply(rows, "Выберите режим…");
}

const searchKb = reply([[BTN.cancel]], "Идёт поиск…");

function chatKb(roleplay: boolean) {
  return roleplay
    ? reply([[BTN.next, BTN.stop], [BTN.dice, BTN.twist, BTN.scene], [BTN.report]], "Пишите от лица героя…")
    : reply([[BTN.next, BTN.stop], [BTN.dice, BTN.topic, BTN.report]], "Напишите сообщение…");
}

const acceptKb = inline([[{ text: "✅ Принимаю правила", data: "acc" }]]);

function ageKb(ob: boolean) {
  const s = ob ? ":ob" : "";
  return inline([
    [{ text: "🧒 до 18", data: `age:teen${s}` }, { text: "18–24", data: `age:18${s}` }],
    [{ text: "25–34", data: `age:25${s}` }, { text: "35+", data: `age:35${s}` }],
    ...(ob ? [] : [[{ text: "◀️ Назад", data: "set" }]]),
  ]);
}

function genderKb(ob: boolean) {
  const s = ob ? ":ob" : "";
  return inline([
    [{ text: GENDER.m, data: `sex:m${s}` }, { text: GENDER.f, data: `sex:f${s}` }],
    [{ text: "🕶 Не указывать", data: `sex:x${s}` }],
    ...(ob ? [] : [[{ text: "◀️ Назад", data: "set" }]]),
  ]);
}

const seekKb = inline([
  [{ text: SEEK.any, data: "seek:any" }],
  [{ text: SEEK.m, data: "seek:m" }, { text: SEEK.f, data: "seek:f" }],
  [{ text: "◀️ Назад", data: "set" }],
]);

const settingsKb = inline([
  [{ text: "👤 Пол", data: "set:sex" }, { text: "🎂 Возраст", data: "set:age" }],
  [{ text: "🔎 Кого ищу", data: "set:seek" }],
  [{ text: "🎭 Новый псевдоним", data: "alias:set" }],
]);

const profileKb = inline([
  [{ text: "🎭 Сменить псевдоним", data: "alias:prof" }],
  [{ text: "⚙️ Настройки", data: "set" }],
]);

function roleplayListKb() {
  const rows = [];
  for (let i = 0; i < SCENARIOS.length; i += 2) {
    rows.push(
      SCENARIOS.slice(i, i + 2).map((s) => ({ text: `${s.emoji} ${s.title}`, data: `rp:${s.id}` })),
    );
  }
  rows.push([{ text: "🎲 Случайный сюжет", data: "rp:any" }]);
  return inline(rows);
}

const diceKb = inline([
  [{ text: "🎲 d6", data: "dice:6" }, { text: "🎯 d20", data: "dice:20" }, { text: "💯 d100", data: "dice:100" }],
  [{ text: "🪙 Монетка", data: "coin" }, { text: "🔮 Да / Нет", data: "yesno" }],
]);

function rateKb(sid: number) {
  return inline([
    [{ text: "👍 Понравилось", data: `rate:${sid}:1` }, { text: "👎 Не очень", data: `rate:${sid}:-1` }],
    [{ text: "🚩 Пожаловаться", data: `rep:${sid}` }],
  ]);
}

function reportKb(sid: number) {
  return inline([
    ...Object.entries(REPORT_REASONS).map(([code, label]) => [{ text: label, data: `rr:${sid}:${code}` }]),
    [{ text: "◀️ Отмена", data: `repx:${sid}` }],
  ]);
}

// ── Helpers ──────────────────────────────────────────────────────────────

export async function ensureUser(from: any): Promise<User> {
  const { data, error } = await db.from("tg_users").upsert({
    chat_id: from.id,
    username: from.username ?? null,
    first_name: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    last_seen: new Date().toISOString(),
  }, { onConflict: "chat_id" }).select("*").single();
  if (error) throw error;
  const u = data as User;
  if (!u.alias) {
    u.alias = randomAlias();
    await updateUser(u.chat_id, { alias: u.alias });
  }
  return u;
}

function queueLabel(queue: string) {
  if (queue === "random") return "🎲 Случайный собеседник";
  const s = scenarioById(queue.slice(3));
  return s ? `🎭 ${s.title}` : "🎭 Ролевая игра";
}

/** Send a message to both participants of the user's current chat. */
async function toBoth(u: User, text: string, markup?: unknown) {
  await send(u.chat_id, text, markup);
  if (u.partner_id) await send(u.partner_id, text, markup);
}

async function currentRole(u: User, s: Session | null) {
  if (!s) return null;
  return s.user_a === u.chat_id ? s.role_a : s.role_b;
}

// ── Search & matching ────────────────────────────────────────────────────

async function startSearch(u: User, queue: string) {
  if (u.status === "chatting") return send(u.chat_id, T.alreadyChatting);
  if (u.status === "waiting") {
    await rpc("tg_end_chat", { p_chat_id: u.chat_id });
  }
  const res = await rpc<{ session_id: number; partner: number } | null>(
    "tg_find_partner",
    { p_chat_id: u.chat_id, p_queue: queue },
  );
  if (!res) {
    await send(u.chat_id, T.searching(queueLabel(queue)), searchKb);
    return;
  }

  const [me, partner] = await Promise.all([getUser(u.chat_id), getUser(res.partner)]);
  if (!me || !partner) return;

  const scenario = queue.startsWith("rp:") ? scenarioById(queue.slice(3)) : undefined;
  if (!scenario) {
    await send(me.chat_id, matchCard(partner), chatKb(false));
    await send(partner.chat_id, matchCard(me), chatKb(false));
    return;
  }

  // Session: user_a = partner (was waiting), user_b = me. Assign roles randomly.
  const flip = Math.random() < 0.5;
  const roleA = scenario.roles[flip ? 0 : 1];
  const roleB = scenario.roles[flip ? 1 : 0];
  await db.from("tg_sessions").update({ role_a: roleA.name, role_b: roleB.name }).eq("id", res.session_id);

  // The holder of roles[0] opens the scene.
  await send(me.chat_id, roleplayMatchCard(scenario, roleB, roleA, partner, !flip), chatKb(true));
  await send(partner.chat_id, roleplayMatchCard(scenario, roleA, roleB, me, flip), chatKb(true));
}

async function endChat(u: User, opts: { silentSelf?: boolean; partnerText?: string } = {}) {
  const res = await rpc<{ partner: number | null; session_id: number | null }>(
    "tg_end_chat",
    { p_chat_id: u.chat_id },
  );
  if (res.partner) {
    const p = await getUser(res.partner);
    if (p) {
      await send(p.chat_id, opts.partnerText ?? T.partnerLeft, menuKb(p));
      if (res.session_id) await send(p.chat_id, T.ratePrompt, rateKb(res.session_id));
    }
  }
  if (!opts.silentSelf) {
    if (res.session_id) {
      await send(u.chat_id, T.youLeft, menuKb(u));
      await send(u.chat_id, T.ratePrompt, rateKb(res.session_id));
    } else {
      await send(u.chat_id, T.searchCancelled, menuKb(u));
    }
  }
  return res;
}

// ── Relay ────────────────────────────────────────────────────────────────

const MEDIA = ["video", "voice", "video_note", "sticker", "animation", "document", "audio"] as const;

function describe(msg: any): { kind: string; body: string | null; file: string | null } {
  if (msg.text) return { kind: "text", body: msg.text, file: null };
  const caption = msg.caption ?? null;
  if (msg.photo) return { kind: "photo", body: caption, file: msg.photo.at(-1).file_id };
  for (const k of MEDIA) {
    if (msg[k]) {
      return { kind: k, body: caption ?? (k === "sticker" ? msg.sticker.emoji ?? null : null), file: msg[k].file_id };
    }
  }
  if (msg.location) return { kind: "location", body: `${msg.location.latitude}, ${msg.location.longitude}`, file: null };
  if (msg.poll) return { kind: "poll", body: msg.poll.question, file: null };
  if (msg.dice) return { kind: "dice", body: `${msg.dice.emoji} ${msg.dice.value}`, file: null };
  return { kind: "other", body: null, file: null };
}

async function relay(u: User, msg: any) {
  if (msg.contact) {
    await send(u.chat_id, T.contactBlocked);
    return;
  }
  const res = await tg("copyMessage", {
    chat_id: u.partner_id,
    from_chat_id: u.chat_id,
    message_id: msg.message_id,
    protect_content: true,
  });
  if (res.ok) {
    const d = describe(msg);
    await rpc("tg_log_message", {
      p_session: u.session_id, p_sender: u.chat_id, p_kind: d.kind, p_body: d.body, p_file: d.file,
    });
  } else if (res.error_code === 403) {
    // Partner blocked the bot.
    await endChat(u, { silentSelf: true });
    await send(u.chat_id, T.partnerLeft, menuKb(u));
  } else {
    await send(u.chat_id, T.undelivered);
  }
}

/** Bot-generated event visible to both and stored in the transcript. */
async function sharedEvent(u: User, text: string, kind = "event") {
  await toBoth(u, text);
  if (u.session_id) {
    await rpc("tg_log_message", {
      p_session: u.session_id, p_sender: u.chat_id, p_kind: kind, p_body: text.replace(/<[^>]+>/g, ""), p_file: null,
    });
  }
}

// ── Message handler ──────────────────────────────────────────────────────

export async function onUserMessage(u: User, msg: any) {
  const id = u.chat_id;
  const text: string = msg.text ?? "";
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;

  if (cmd === "/start" || (!u.accepted_rules && u.status === "idle")) {
    if (u.accepted_rules && u.age_group) {
      await send(id, T.menu, menuKb(u));
      return;
    }
    await send(id, T.welcome, { remove_keyboard: true });
    await send(id, T.rules, acceptKb);
    return;
  }
  if (!u.age_group) {
    await send(id, T.askAge, ageKb(true));
    return;
  }

  // ── Chatting ──
  if (u.status === "chatting") {
    const session = u.session_id ? await getSession(u.session_id) : null;
    const scenario = scenarioById(session?.scenario);

    if (text === BTN.next || cmd === "/next") {
      const queue = u.last_queue ?? "random";
      await endChat(u, { silentSelf: true });
      if (u.session_id) await send(id, T.ratePrompt, rateKb(u.session_id));
      return startSearch({ ...u, status: "idle" }, queue);
    }
    if (text === BTN.stop || cmd === "/stop") return void await endChat(u);
    if (text === BTN.dice || cmd === "/dice") return void await send(id, "🎲 <b>Что бросаем?</b>", diceKb);
    if (text === BTN.report || cmd === "/report") {
      if (u.session_id) await send(id, T.reportPrompt, reportKb(u.session_id));
      return;
    }
    if (text === BTN.topic || cmd === "/topic") {
      return void await sharedEvent(u, `💡 <b>Тема для разговора</b>\n${DOTS}\n<i>${pick(TOPICS)}</i>`);
    }
    if (text === BTN.twist || cmd === "/twist") {
      const twists = [...(scenario?.twists ?? []), ...GENERIC_TWISTS];
      return void await sharedEvent(u, `🌀 <b>Поворот сюжета!</b>\n${DOTS}\n${pick(twists)}`);
    }
    if (text === BTN.scene || cmd === "/scene") {
      if (!scenario || !session) return void await send(id, "📖 Это обычный диалог, сцены нет.");
      const mine = await currentRole(u, session);
      const role = scenario.roles.find((r) => r.name === mine);
      await send(
        id,
        `${scenarioPreview(scenario)}\n${LINE}\n🎭 <b>Ваша роль:</b> ${mine ?? "—"}\n<i>${role?.brief ?? ""}</i>`,
      );
      return;
    }
    if (cmd === "/me") {
      const action = text.replace(/^\/me(@\S+)?\s*/i, "").trim();
      if (!action) return void await send(id, T.meUsage);
      const who = (await currentRole(u, session)) ?? u.alias ?? "Незнакомец";
      return void await sharedEvent(u, `✦ <i><b>${esc(who)}</b> ${esc(action)}</i>`, "action");
    }
    return relay(u, msg);
  }

  // ── Waiting ──
  if (u.status === "waiting") {
    if (text === BTN.cancel || cmd === "/stop" || cmd === "/cancel") return void await endChat(u);
    if (text === BTN.random || text === BTN.roleplay || cmd === "/find") {
      return void await send(id, T.stillSearching, searchKb);
    }
    await send(id, T.stillSearching, searchKb);
    return;
  }

  // ── Idle ──
  switch (true) {
    case text === BTN.random || cmd === "/find" || cmd === "/search" || cmd === "/next":
      return startSearch(u, "random");
    case text === BTN.roleplay || cmd === "/roleplay" || cmd === "/rp":
      return void await send(id, ROLEPLAY_MENU, roleplayListKb());
    case text === BTN.profile || cmd === "/profile":
      return void await send(id, profileCard(u), profileKb);
    case text === BTN.settings || cmd === "/settings":
      return void await send(id, settingsCard(u), settingsKb);
    case text === BTN.rules || cmd === "/rules" || cmd === "/help":
      return void await send(id, T.rules);
    case cmd === "/stop":
      return void await send(id, T.notInChat, menuKb(u));
    default:
      await send(id, T.notInChat, menuKb(u));
  }
}

// ── Callback handler ─────────────────────────────────────────────────────

export async function onUserCallback(u: User, cq: any) {
  const data: string = cq.data ?? "";
  const chatId = u.chat_id;
  const mid: number = cq.message?.message_id;
  const [action, a1, a2] = data.split(":");

  switch (action) {
    case "acc": {
      await updateUser(chatId, { accepted_rules: true });
      await answer(cq.id, "Добро пожаловать в клуб 🖤");
      await edit(chatId, mid, `${T.rules}\n\n✅ <b>Правила приняты</b>`);
      if (!u.age_group) await send(chatId, T.askAge, ageKb(true));
      else await send(chatId, T.menu, menuKb({ ...u, accepted_rules: true }));
      return;
    }

    case "age": {
      if (!(a1 in AGE)) return void await answer(cq.id);
      await updateUser(chatId, { age_group: a1 as User["age_group"] });
      await answer(cq.id, `Возраст: ${AGE[a1]}`);
      if (a2 === "ob") {
        await edit(chatId, mid, `🎂 Возраст: <b>${AGE[a1]}</b> ✅`);
        await send(chatId, T.askGender, genderKb(true));
      } else {
        await edit(chatId, mid, settingsCard({ ...u, age_group: a1 as User["age_group"] }), settingsKb);
      }
      return;
    }

    case "sex": {
      if (!(a1 in GENDER)) return void await answer(cq.id);
      const nu = { ...u, gender: a1 as User["gender"] };
      await updateUser(chatId, { gender: nu.gender });
      await answer(cq.id, GENDER[a1]);
      if (a2 === "ob") {
        await edit(chatId, mid, `👤 Пол: <b>${GENDER[a1]}</b> ✅`);
        await send(chatId, `${T.ready}\n${DOTS}\n🎭 Ваш псевдоним: <b>${esc(u.alias ?? "")}</b>`, menuKb(nu));
      } else {
        await edit(chatId, mid, settingsCard(nu), settingsKb);
      }
      return;
    }

    case "seek": {
      if (!(a1 in SEEK)) return void await answer(cq.id);
      const nu = { ...u, seek_gender: a1 as User["seek_gender"] };
      await updateUser(chatId, { seek_gender: nu.seek_gender });
      await answer(cq.id, `Ищем: ${SEEK[a1]}`);
      await edit(chatId, mid, settingsCard(nu), settingsKb);
      return;
    }

    case "set": {
      await answer(cq.id);
      if (a1 === "age") return void await edit(chatId, mid, T.askAge, ageKb(false));
      if (a1 === "sex") return void await edit(chatId, mid, T.askGender, genderKb(false));
      if (a1 === "seek") return void await edit(chatId, mid, T.askSeek, seekKb);
      await edit(chatId, mid, settingsCard(u), settingsKb);
      return;
    }

    case "alias": {
      const alias = randomAlias();
      await updateUser(chatId, { alias });
      await answer(cq.id, `Новый псевдоним: ${alias}`);
      const nu = { ...u, alias };
      if (a1 === "prof") await edit(chatId, mid, profileCard(nu), profileKb);
      else await edit(chatId, mid, settingsCard(nu) + `\n\n🎭 Псевдоним: <b>${esc(alias)}</b>`, settingsKb);
      return;
    }

    case "rp": {
      await answer(cq.id);
      const s = a1 === "any" ? pick(SCENARIOS) : scenarioById(a1);
      if (!s) return;
      await edit(
        chatId,
        mid,
        scenarioPreview(s),
        inline([
          [{ text: "▶️ Начать поиск партнёра", data: `rpgo:${s.id}` }],
          [{ text: "◀️ Все сюжеты", data: "rplist" }],
        ]),
      );
      return;
    }

    case "rplist":
      await answer(cq.id);
      return void await edit(chatId, mid, ROLEPLAY_MENU, roleplayListKb());

    case "rpgo": {
      const s = scenarioById(a1);
      if (!s) return void await answer(cq.id);
      if (u.status === "chatting") return void await answer(cq.id, "Сначала завершите текущий диалог", true);
      await answer(cq.id, `${s.emoji} ${s.title}`);
      await edit(chatId, mid, `${scenarioPreview(s)}\n${LINE}\n🔍 <i>Поиск партнёра запущен…</i>`);
      return startSearch(u, `rp:${s.id}`);
    }

    case "dice":
    case "coin":
    case "yesno": {
      await answer(cq.id);
      let text: string;
      if (action === "dice") {
        const n = [6, 20, 100].includes(Number(a1)) ? Number(a1) : 6;
        const roll = 1 + Math.floor(Math.random() * n);
        const crit = n === 20 && roll === 20 ? " 💥 <b>КРИТ!</b>" : n === 20 && roll === 1 ? " 💀 <b>Провал!</b>" : "";
        text = `🎲 <b>${esc(u.alias ?? "")}</b> бросает d${n}: <b>${roll}</b>${crit}`;
      } else if (action === "coin") {
        text = `🪙 <b>${esc(u.alias ?? "")}</b> подбрасывает монетку: <b>${Math.random() < 0.5 ? "Орёл" : "Решка"}</b>`;
      } else {
        text = `🔮 Судьба отвечает: <b>${pick(["Да", "Нет", "Скорее да", "Скорее нет", "Спроси позже"])}</b>`;
      }
      if (u.status === "chatting") await sharedEvent(u, text, "dice");
      else await send(chatId, text);
      return;
    }

    case "rate": {
      const ok = await rpc<boolean>("tg_rate", { p_session: Number(a1), p_rater: chatId, p_value: Number(a2) > 0 ? 1 : -1 });
      await answer(cq.id, ok ? "Оценка учтена" : "Вы уже оценили этот диалог");
      await edit(chatId, mid, ok ? `${T.rated} ${Number(a2) > 0 ? "👍" : "👎"}` : T.rated);
      return;
    }

    case "rep":
      await answer(cq.id);
      return void await edit(chatId, mid, T.reportPrompt, reportKb(Number(a1)));

    case "repx":
      await answer(cq.id);
      if (u.session_id === Number(a1)) return void await tg("deleteMessage", { chat_id: chatId, message_id: mid });
      return void await edit(chatId, mid, T.ratePrompt, rateKb(Number(a1)));

    case "rr": {
      const sid = Number(a1);
      const reason = REPORT_REASONS[a2] ?? REPORT_REASONS.other;
      const reported = await rpc<number | null>("tg_report", { p_reporter: chatId, p_session: sid, p_reason: reason });
      await answer(cq.id, reported ? "Жалоба отправлена" : "Вы уже жаловались на этого собеседника");
      await edit(chatId, mid, `${T.reported}\n${DOTS}\nПричина: ${reason}`);
      if (reported && u.status === "chatting" && u.session_id === sid) {
        await endChat(u, { silentSelf: true, partnerText: T.partnerReported });
        await send(chatId, T.youLeft, menuKb(u));
      }
      if (reported) {
        await send(
          ADMIN_ID,
          `🚨 <b>Новая жалоба</b>\n${DOTS}\nПричина: ${reason}\nДиалог: <code>#${sid}</code>`,
          inline([[{ text: "💬 Открыть диалог", data: `adm:s:${sid}:last` }, { text: "👤 Нарушитель", data: `adm:u:${reported}` }]]),
        );
      }
      return;
    }
  }
  await answer(cq.id);
}
