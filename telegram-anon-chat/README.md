# Anonymous Chat – Telegram bot

Pairs random Telegram users for anonymous 1-to-1 chats. Runs entirely on
Supabase: one Edge Function (webhook) plus a few Postgres tables. No server.

Messages are relayed with Telegram's `copyMessage`, so the partner never sees
your name, username or a "forwarded from" label. Text, photos, stickers, voice,
video and files all work.

## Commands

| Command   | What it does                               |
|-----------|--------------------------------------------|
| `/start`  | Welcome message and rules                  |
| `/find`   | Join the queue / get paired with someone   |
| `/next`   | Leave current chat and find a new partner  |
| `/stop`   | End the chat or leave the queue            |
| `/report` | Report partner and leave (3 reports = ban) |

## Layout

```
supabase/
  migrations/…_anon_chat.sql     tables + pairing functions (RLS locked)
  functions/anon-chat/index.ts   Telegram webhook handler
```

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Supabase dashboard → **Edge Functions → Secrets** → add
   `TELEGRAM_BOT_TOKEN` = your token.
3. Open `https://<project-ref>.supabase.co/functions/v1/anon-chat?setup=1`
   once in a browser. It registers the webhook and the command menu. You
   should see `"ok": true` twice.
4. Message your bot `/find` from two Telegram accounts.

Deploying from the CLI instead:

```sh
supabase link --project-ref <project-ref>
supabase db push
supabase secrets set TELEGRAM_BOT_TOKEN=123:abc
supabase functions deploy anon-chat --no-verify-jwt
```

`--no-verify-jwt` is needed because Telegram can't send a Supabase JWT; the
function instead checks Telegram's `X-Telegram-Bot-Api-Secret-Token` header
(derived from the bot token).
