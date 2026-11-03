# Creator Inbox — Go-Live Guide

This is your real app. I wrote all the code. To put it on the internet you'll do a few clicks that only *you* can do (they're tied to your accounts). Do them in order. Paste me any screen or error and I'll walk you through it.

**Tonight's finish line:** your portal live on the web + your Gmail connected, pulling real emails in with AI drafts you approve and send.

---

## A. Put the code on GitHub (5 min)

1. Go to **github.com** → sign up / log in.
2. Click **+** (top right) → **New repository**. Name it `creator-inbox`. Click **Create repository**.
3. On the next page click **"uploading an existing file"**.
4. Drag in **all the files from this folder** (everything I gave you). Click **Commit changes**.

✅ Your code is now on GitHub.

---

## B. Deploy it on Render (5 min)

1. Go to **render.com** → **Get Started** → sign in **with GitHub**.
2. Click **New +** → **Web Service** → connect your `creator-inbox` repo.
3. Render auto-detects the settings from the blueprint. Leave everything default. Click **Create Web Service**.
4. Wait ~2 min for it to build. When it's done, copy your live URL at the top — it looks like `https://creator-inbox-xxxx.onrender.com`.

✅ Your site is LIVE. Open that URL — you'll see your portal on the internet.

---

## C. Get your Google keys so Gmail can connect (10 min — the fiddly one; I'll help)

1. Go to **console.cloud.google.com** → agree to terms.
2. Top bar → **Select a project** → **New Project** → name it `creator-inbox` → **Create**.
3. Search bar → type **"Gmail API"** → open it → **Enable**.
4. Left menu → **APIs & Services** → **OAuth consent screen** → choose **External** → fill only the required boxes (app name `Creator Inbox`, your email) → Save through the steps → on **Test users**, click **Add users** and add **your own Gmail address** → Save.
5. Left menu → **Credentials** → **Create Credentials** → **OAuth client ID** → type **Web application**.
   - Under **Authorized redirect URIs** click **Add URI** and paste your Render URL **+ `/auth/google/callback`**
     (example: `https://creator-inbox-xxxx.onrender.com/auth/google/callback`)
   - Click **Create**. A box pops up with a **Client ID** and **Client Secret** — keep it open.

6. Back in **Render** → your service → **Environment** tab → add these (click **Add Environment Variable** for each):
   - `BASE_URL` = your Render URL (no slash at the end)
   - `GOOGLE_CLIENT_ID` = the Client ID from Google
   - `GOOGLE_CLIENT_SECRET` = the Client Secret from Google
   - *(optional)* `ANTHROPIC_API_KEY` = a key from **console.anthropic.com** → makes drafts sound like you. Skip it and drafts still work, just simpler.
   - Click **Save Changes**. Render redeploys automatically (~1 min).

✅ Keys are in.

---

## D. Connect your Gmail — the payoff (1 min)

1. Open your live site → go to the **Connections** tab → click **Connect** on **Email**.
2. Google asks you to sign in and **Allow**. (You'll see a "Google hasn't verified this app" screen because it's brand new and private — click **Advanced → Go to Creator Inbox (unsafe)**. It's *your* app; it's safe.)
3. You land back in the portal. Hit **Refresh** in the top right.

🎉 **Your real emails appear in the inbox, each with a draft. Edit if you want, hit Approve & Send, and it sends from your Gmail.**

---

## E. Connect Instagram (your own account — ~15 min, I'll help)

Good news: because this only touches **your own** account, there's **no weeks-long Meta review** — it's the same kind of sign-in as Gmail.

**Before you start:** your Instagram must be a **Professional** or **Creator** account (free to switch in the IG app: Settings → Account type).

1. Go to **developers.facebook.com** → **My Apps** → open your **Creator Inbox** app (we made it together).
2. In the left menu find the **Instagram** product → **API setup with Instagram login**. You'll see an **Instagram app ID** and **Instagram app secret** — keep them handy.
3. Still there, find **Business login settings** → **Redirect URIs** → add your Render URL **+ `/auth/instagram/callback`**
   (example: `https://creator-inbox-xxxx.onrender.com/auth/instagram/callback`) → Save.
4. In **Render → Environment**, add:
   - `INSTAGRAM_APP_ID` = the Instagram app ID
   - `INSTAGRAM_APP_SECRET` = the Instagram app secret
   - Save (Render redeploys ~1 min).
5. Open your live site → **Connections** → **Connect** on **Instagram** → sign in and **Allow**.
6. **One-time token save (makes it permanent):** open **Render → your service → Logs**, find the lines that start `SAVE_THIS_INSTAGRAM_...`, and copy each value into a matching Environment variable: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `INSTAGRAM_USER`. Save. *(I don't handle these tokens — you copy them straight from your logs.)*

🎉 Instagram comments + DMs now flow in. (DMs can only be answered within 24 hours of the fan's message — that's Meta's rule, not ours.)

---

## F. Connect Facebook (your Page — ~10 min)

**Before you start:** you need a **Facebook Page** (not a personal profile). The Page is where comments and Messenger live.

1. In your **Creator Inbox** app → add the **Facebook Login** product if it isn't there → **Settings** → add the redirect URI: your Render URL **+ `/auth/facebook/callback`** → Save.
2. Your **App ID** and **App Secret** are under **App settings → Basic**.
3. In **Render → Environment**, add `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` → Save.
4. Live site → **Connections** → **Connect** on **Facebook** → sign in, pick your Page, **Allow**.
5. **Token save:** from **Render → Logs**, copy the `SAVE_THIS_FACEBOOK_...` values into `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_NAME`. Save. (The Page token doesn't expire, so this one's truly set-and-forget.)

🎉 Page comments + Messenger now flow in.

---

## G. Connect Threads (your own account — ~10 min)

Threads is a **separate** Meta setup from Instagram (its own keys), but just as quick, and also **no review** for your own account.

1. In your **Creator Inbox** app → add the **Threads** use case (**Use cases → Access the Threads API**).
2. In its settings, add the redirect URI: your Render URL **+ `/auth/threads/callback`** → Save. Copy the **Threads app ID** and **Threads app secret**.
3. In **Render → Environment**, add `THREADS_APP_ID` and `THREADS_APP_SECRET` → Save.
4. Live site → **Connections** → **Connect** on **Threads** → **Allow**.
5. **Token save:** from **Render → Logs**, copy the `SAVE_THIS_THREADS_...` values into `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`, `THREADS_USER`. Save.

🎉 Replies on your Threads posts now flow in, and you can reply from the portal.

---

## H. Connect Discord (your server — ~10 min, no Meta at all)

1. Go to **discord.com/developers/applications** → **New Application** → name it `Creator Inbox` → **Create**.
2. Left menu → **Bot** → **Reset Token** → copy the token (you'll paste it in a sec). **Important:** on the same page, scroll to **Privileged Gateway Intents** and turn **ON** **Message Content Intent** → Save. *(Without this the bot can't read message text.)*
3. Left menu → **General Information** → copy the **Application ID**.
4. In **Render → Environment**, add `DISCORD_BOT_TOKEN` = the token, `DISCORD_APP_ID` = the Application ID, and `DISCORD_BOT_NAME` = your bot's name → Save.
5. Add the bot to your server: on your live site → **Connections** → **Connect** on **Discord** (this opens Discord's "add to server" screen) → pick your server → **Authorize**.

🎉 Messages in your server's channels now flow in, and replies post as your bot. *(This reads your server's channels; DMs sent directly to the bot aren't picked up in this first version — we can add that later.)*

---

## Good to know
- **Restarts:** Gmail/YouTube reconnect themselves from saved tokens; Instagram, Facebook, Threads, and Discord do too once you've saved their tokens in step 6/5/5/4 above. The free Render tier sleeps when idle and wakes on the next visit.
- **Instagram & Threads tokens** last ~60 days but the app **auto-renews** them on each restart, so as long as you open the portal now and then they stay live. Facebook Page tokens and the Discord bot token don't expire.
- **Is this safe for my accounts?** Yes — every platform here uses its **official API**. Official APIs don't suppress your reach or risk your account standing; that only happens with unofficial bots/scrapers, which this is not.
- **One optional extra for Instagram/Facebook DMs:** replying *later than 24 hours* after a fan messages needs Meta's "human agent" feature, which *does* require business verification. We've skipped it for now; say the word if you want it.
- **Next up:** the shared database, so the tone sheet, sent-tracking, and stats persist and feed your dashboard.
- **Stuck on any screen?** Screenshot it, paste it to me, and I'll tell you the exact next click.
