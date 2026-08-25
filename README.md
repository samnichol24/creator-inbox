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

## Good to know
- **Restarts:** this MVP keeps your connection in memory, so if Render restarts the app (free tier sleeps when idle), just click **Connect** on Email again. When you're ready I'll add a tiny free database so it stays connected for good.
- **The other platforms** (YouTube, SMS, Discord, then Instagram/Facebook) plug into this same app — we add them one at a time in our next sessions. Instagram/Facebook also need Meta's review, which takes a few weeks on their end.
- **Stuck on any screen?** Screenshot it, paste it to me, and I'll tell you the exact next click.
