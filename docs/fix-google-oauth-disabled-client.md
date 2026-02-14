# Fix: Google OAuth "401: disabled_client"

> **Audience:** Non-technical user  
> **Time to complete:** 5–10 minutes  
> **Date:** February 8, 2026

---

## A) What "disabled_client" Means

Google is rejecting our app before you even get to the permission screen.
The three most likely causes, in priority order:

| # | Cause | Likelihood |
|---|---|---|
| 1 | **OAuth consent screen was never configured** (or was deleted). Google disables all OAuth clients in a project that has no consent screen. | ⭐ Most likely |
| 2 | **The OAuth client was manually disabled or deleted** in the Credentials page. | Possible |
| 3 | **The Google Cloud project itself is disabled or suspended** (billing issue or policy violation). | Unlikely |

We'll fix all three below, in order.

---

## B) Project Sanity Check (Do This First)

### B1 — Confirm you're signed into the right Google account

1. Open [**Google Cloud Console**](https://console.cloud.google.com/)
2. Look at the **circle/avatar in the top-right corner** of the page
3. Click it — it should show **aireceptionistt@gmail.com**
4. If it shows a different email, click **"Switch account"** and sign in with `aireceptionistt@gmail.com`

### B2 — Confirm you're in the right project

1. Look at the **top-left** of the page, next to "Google Cloud" — there's a **project dropdown**
2. Click it — you'll see a list of your projects
3. Select the project that contains the OAuth client ID matching your `GOOGLE_CLIENT_ID` in `.env`
4. **How to verify:** After selecting, go to [**APIs & Services → Credentials**](https://console.cloud.google.com/apis/credentials). Under "OAuth 2.0 Client IDs" you should see a client. Click it and confirm the Client ID matches your `.env` value

> 🚨 **If you don't see any project or any OAuth client**, you may need to create everything from scratch. Jump to **Section D**.

---

## C) Enable Required Services

### C1 — Enable Google Calendar API

1. Click this link: [**Google Calendar API in Library**](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
2. Make sure you're in the correct project (check top-left dropdown)
3. You'll see one of two things:
   - **"ENABLE" button** → Click it. Wait for it to finish. ✅
   - **"MANAGE" button** → Already enabled. Nothing to do. ✅

### C2 — Configure OAuth Consent Screen

This is the **most likely fix** for your error.

1. Go to: [**APIs & Services → OAuth consent screen**](https://console.cloud.google.com/apis/credentials/consent)
2. You'll see one of these situations:

#### Situation A: "Configure Consent Screen" button (never set up)

1. Click **"Configure Consent Screen"**
2. **User Type:** Select **External** → Click **Create**
3. Fill in the form:
   - **App name:** `AI Receptionist`
   - **User support email:** Select `aireceptionistt@gmail.com` from the dropdown
   - **App logo:** Skip (leave empty)
   - **App domain / links:** Skip all of these
   - **Developer contact email:** Type `aireceptionistt@gmail.com`
4. Click **"SAVE AND CONTINUE"**

5. **Scopes page:**
   - Click **"ADD OR REMOVE SCOPES"**
   - In the search box, type: `calendar`
   - Find the row that says **Google Calendar API** with scope `.../auth/calendar`
   - **Check the box** next to it
   - Click **"UPDATE"** at the bottom
   - Click **"SAVE AND CONTINUE"**

6. **Test users page:**
   - Click **"+ ADD USERS"**
   - Type: `aireceptionistt@gmail.com`
   - Click **"ADD"**
   - Click **"SAVE AND CONTINUE"**

7. **Summary page:** Click **"BACK TO DASHBOARD"**

8. **Verify:** The dashboard should show:
   - Publishing status: **Testing** ✅
   - User type: **External** ✅

#### Situation B: Dashboard exists but shows "Suspended" or "Needs verification"

- If **Suspended**: You need to create a new Google Cloud project and start over (Section D)
- If **Needs verification**: Click **"RESET TO TESTING"** to put it back into test mode

#### Situation C: Dashboard exists and shows "Testing" ✅

- Make sure `aireceptionistt@gmail.com` is in the **Test users** list
- If not, click **"Test users"** → **"+ ADD USERS"** → add it → Save

---

## D) Check / Reset OAuth Client ID

### D1 — Check if the existing client works

1. Go to: [**APIs & Services → Credentials**](https://console.cloud.google.com/apis/credentials)
2. Under **"OAuth 2.0 Client IDs"**, look for your client
3. If the client exists:
   - Click on it
   - Verify **"Authorized redirect URIs"** contains exactly:
     ```
     http://localhost:3000/api/oauth/google/callback
     ```
   - If missing, click **"+ ADD URI"**, paste the URI above, click **"SAVE"**
   - Note: **Authorized JavaScript origins** — leave empty (not needed for our server-side flow)

4. If the client **doesn't exist** or looks broken → create a new one (D2)

### D2 — Create a NEW OAuth Client (only if D1 failed)

1. On the [**Credentials page**](https://console.cloud.google.com/apis/credentials), click:
   **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
2. **Application type:** Select **Web application**
3. **Name:** `AI Receptionist Local`
4. **Authorized JavaScript origins:** Leave empty
5. **Authorized redirect URIs:** Click **"+ ADD URI"** and paste exactly:
   ```
   http://localhost:3000/api/oauth/google/callback
   ```
6. Click **"CREATE"**
7. A popup shows your new **Client ID** and **Client Secret**
8. **Copy both values** — you'll need them in the next step

> ⚠️ Do NOT share these values in chat. You'll paste them directly into a file on your computer.

---

## E) Update Local App Configuration

### Which file to edit

Open this file on your computer:
```
src/backend/.env.pilot
```

### Which values to set (names only)

Find these three lines in the `# --- Google Calendar ---` section:
```
GOOGLE_CLIENT_ID=***
GOOGLE_CLIENT_SECRET=***
GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback
```

- If you created a **new** client in Step D2, replace the `***` values with your new Client ID and Secret
- The `GOOGLE_REDIRECT_URI` should already be correct — don't change it

### Tell your developer (me) to restart

After saving the file, just say: **"credentials updated, restart please"**

I will:
1. Copy the new values to the running environment
2. Restart the system
3. Give you a fresh Google Calendar connect link

---

## F) End-User Test (After OAuth Is Fixed)

### F1 — Connect Google Calendar

I'll give you a clickable link. When you click it:

1. **Google sign-in** → sign in with `aireceptionistt@gmail.com`
2. **"This app isn't verified" warning** → Click **"Continue"** (normal for testing)
3. **Permission request** → Click **"Continue"**
4. **Success page** shows:
   ```
   {"success":true,"message":"Google Calendar connected.","calendar_mode":"google"}
   ```
   That means it worked! ✅

### F2 — Open the AI Receptionist

Open this in your browser:
```
http://localhost:5173?demo=1
```
You should see a chat window with a friendly greeting.

### F3 — Proof Test

1. **Create a busy event** in [Google Calendar](https://calendar.google.com):
   - Date: **Monday, February 9, 2026**
   - Time: **2:00 PM – 3:00 PM**
   - Title: Anything (e.g. "Team Meeting")
   - Make sure it shows as **"Busy"** (this is the default)

2. **Ask the receptionist** (type in the chat):
   > "I'd like to book an appointment on Monday February 9th in the afternoon."

3. **Check the response:**

| ✅ PASS | ❌ FAIL |
|---|---|
| 2:00 PM and 2:30 PM are **NOT** offered | 2:00 PM or 2:30 PM appear as available |
| Other afternoon times (1:00, 1:30, 3:00, 3:30, 4:00) **ARE** offered | No times are offered at all / error message |

---

## G) Troubleshooting Table

If you see a different error when clicking the Google connect link:

| Error | Meaning | Fix |
|---|---|---|
| **401: disabled_client** | OAuth consent screen missing or project disabled | Complete Section C above |
| **403: access_denied** | Your email isn't listed as a test user | Section C2 → Test users → add your email |
| **400: redirect_uri_mismatch** | Redirect URI doesn't match Google Console | Section D1 → add exactly `http://localhost:3000/api/oauth/google/callback` |
| **400: invalid_scope** | Google Calendar API not enabled | Section C1 → enable the API |
| **"This app is blocked"** | Consent screen is suspended | Create a new Google Cloud project and redo all steps |
| **"Failed to connect Google Calendar"** (on our success page) | Code exchange failed — usually wrong Client Secret | Section D2 → create new client, update `.env.pilot` |
| **Page shows nothing / timeout** | Backend not running | Tell me — I'll restart the system |

---

## Quick Summary Checklist

Complete these in order. Check each box:

- [ ] Signed into Google Cloud as `aireceptionistt@gmail.com`
- [ ] Correct project selected (has the OAuth client matching your `GOOGLE_CLIENT_ID`)
- [ ] Google Calendar API enabled (shows "MANAGE" not "ENABLE")
- [ ] OAuth consent screen configured (shows "Testing" status)
- [ ] Test user `aireceptionistt@gmail.com` added
- [ ] OAuth client redirect URI is exactly `http://localhost:3000/api/oauth/google/callback`
- [ ] Clicked connect link → saw `{"success":true}`
- [ ] Created busy event Mon Feb 9, 2:00–3:00 PM
- [ ] Asked receptionist → 2:00 PM was NOT offered

**When all boxes are checked: Calendar integration is VERIFIED ✅**
