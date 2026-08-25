# ESC Call Desk — Hostinger deployment

## Use the Node.js Web App flow

Do not upload this app into `public_html/calls` as a PHP/static website. The UI depends on authenticated API routes for shared pipeline state, call history, settings and snapshots.

In hPanel:

1. Go to **Websites → Add Website**.
2. Choose **Deploy Web App**.
3. Choose **Upload your website files**.
4. Use `calls.escsupportltd.co.uk` as the website address.
5. Upload the ZIP from `cold_calling/deploy/`.
6. Confirm the detected framework is **Express.js**. If hPanel labels it **Other**, set the entry file to `server.js`.
7. Use Node.js 20.x or 22.x and the start command `npm start`.
8. Leave the output directory empty for this server-side Express app.

## Required environment variables

Add these before deploying:

```text
NODE_ENV=production
ESC_AROOSA_PASSWORD=<a strong unique password for Aroosa>
ESC_JALEES_PASSWORDS=<a strong unique password for Jalees>
ESC_REQUIRE_DATABASE=1
DB_HOST=localhost
DB_PORT=3306
DB_USER=<Hostinger database username>
DB_PASSWORD=<Hostinger database password>
DB_NAME=<Hostinger database name>
```

`ESC_JALEES_PASSWORDS` may contain comma-separated passwords if more than one handler password is intentionally required. Do not set `PORT`. The server honours a platform-provided value and otherwise uses Hostinger's required port `3000`.

The server refuses to start when the two password variables are missing. With `ESC_REQUIRE_DATABASE=1`, it also refuses to start unless the Hostinger MySQL connection succeeds. Session cookies are HTTP-only, SameSite Strict and Secure by default.

## Existing subdomain warning

`calls.escsupportltd.co.uk` currently serves Hostinger's default PHP page. Hostinger requires a Node.js app to be added as a separate website. If hPanel says the address is already connected, back up the existing website first, then remove only the existing `calls` website/subdomain entry before adding the Node.js web app. Do not remove `escsupportltd.co.uk` or its main website.

## Verification after deployment

1. Open `https://calls.escsupportltd.co.uk/` in a private browser window.
2. Confirm only the ESC sign-in page appears; company details must not be visible before authentication.
3. Sign in as Aroosa and confirm the current company lists, shared state and snapshots load.
4. Sign out, sign in as Jalees and confirm Handler Suite controls are visible.
5. Confirm `https://calls.escsupportltd.co.uk/pipeline_state.json` returns 404 and `/api/state` returns 401 while signed out.
6. Create a test snapshot and download it before live calling begins.

## Persistence, backups and redeployment

Production company research, metadata, runtime state and snapshots are stored in Hostinger MySQL. The transition ZIP imports the existing JSON files on the first database-backed startup; later GitHub deployments reload all business data from MySQL.

GitHub deploys code only. After V9 research completes, Jalees imports the generated `research_import_*.json` through **Handler Suite → Import Research**. The server validates it, creates a recovery snapshot, updates company research without touching call state, and signals every open app to refresh.

Keep using **Save to Host + Download** for independent recovery backups, especially before the one-time MySQL migration or a major application change. Runtime JSON files, snapshots, passwords and `.env` are excluded from Git. See `GITHUB_DEPLOYMENT.md` for the exact migration and push workflow.
