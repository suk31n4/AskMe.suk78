# AskMe

A social question-and-answer app prototype inspired by the AskMe product concept.

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm start
   ```
3. Open http://localhost:3000

## Stack

- Node.js
- Express
- Static front-end prototype

## Permanent hosting on Render

The `render.yaml` Blueprint configures a free Node web service, a generated session secret, and the production health check. Free hosting has no persistent disk, so accounts, posts, answers, likes, and messages stored in local files can be lost after a restart or redeploy. Keep this as a single service instance because the JSON-file store is not designed for multiple instances.

1. Push this project to a GitHub repository. Do not commit `.env`, credentials, or private user data.
2. In Render, create a new **Blueprint** and connect that GitHub repository. Render reads `render.yaml` and provisions the service.
3. Add SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) or Twilio settings (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) in the Render service environment before relying on password recovery.
4. Use the stable `*.onrender.com` URL shown in the Render dashboard. A custom domain must be purchased separately and connected in Render.

Publishing still requires a Render account and a GitHub repository. File-backed sessions are on the ephemeral service filesystem, so users may need to log in again after a restart or redeploy.

## Messaging

The Inbox shows unread message counts and in-app alerts while AskMe is open. Users can enable optional browser notifications under **Profile → Settings and Privacy → Message alerts**; browser permission is required. The chat composer includes an emoji picker. This is polling-based and does not send notifications while the site is closed.

## Password recovery

New accounts need a recovery email address or phone number. Existing users can add one in **Profile → Edit Profile Details**. Recovery codes expire after 10 minutes and allow up to five attempts.

For local development without a delivery provider, the one-time code is printed in the server terminal. For email delivery, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. For SMS delivery, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.

For production password recovery, configure a real delivery provider. Local development uses the project's `data` directory.
