# Cold Calling Copilot: Reliable Sharing and Recovery

## What is saved where

- Every edit is written immediately to that browser's local storage.
- The browser then syncs the shared workspace to `pipeline_state.json` and `call_history.json` on the host computer.
- Jalees's shared contact-attempt rule is stored in `workspace_settings.json` on the host and is included in snapshots/downloaded backups.
- The host creates a rotating automatic recovery snapshot after changes (every five minutes by default).
- **Save to Host + Download** writes a snapshot under `snapshots/` on the host and downloads the same snapshot to the device that clicked the button.
- **Export Backup** is the emergency option when the host/tunnel is unreachable. It downloads the browser's current local copy without needing the server.

## Why a stable tunnel is important

`cloudflared tunnel --url ...` creates a Quick Tunnel with a different `trycloudflare.com` hostname each time. Browsers isolate local storage by hostname, so a new link cannot read the emergency browser copy stored under an old link.

Use a named Cloudflare Tunnel and one permanent hostname for routine work. The installed `cloudflared` build supports this workflow:

```bash
cloudflared tunnel login
cloudflared tunnel create esc-cold-calling
cloudflared tunnel route dns esc-cold-calling calls.your-domain.example
```

Then launch this app with the same tunnel and public URL each time:

```bash
ESC_TUNNEL_NAME=esc-cold-calling \
ESC_PUBLIC_URL=https://calls.your-domain.example \
./script.sh
```

Alternatively, put a remotely managed tunnel token in a protected file and use:

```bash
TUNNEL_TOKEN_FILE=/absolute/protected/path/tunnel-token.txt \
ESC_PUBLIC_URL=https://calls.your-domain.example \
./script.sh
```

Do not commit or share the tunnel token file.

## If the connection breaks

1. Keep the existing page open. It continues saving edits locally and shows **Saved locally · retrying**.
2. When the same stable hostname reconnects, the page retries automatically and the badge changes to **Saved to Host**.
3. If the host will be unavailable for a while, click **Export Backup** before closing the tab.
4. After service returns, use **Snapshots → Import** to upload that JSON backup and restore it.
5. Check `logs/server_*.log` and `logs/cloudflared_*.log` on the host if the save badge does not return to green.

## Normal end-of-shift check

1. Confirm the badge says **Saved to Host**.
2. Click **Save to Host + Download**.
3. Confirm a new card appears under **Snapshots**.
4. Confirm a `.json` file downloaded on the caller's device.

## Calling and list workflow

1. Use **Pipeline Workspace** for the full-screen, searchable and sortable view. The compact list tabs remain available on the main screen.
2. For an unanswered call, choose **+ Attempt** (or **Contacted · Not Reached** in the main logger), then record the exact phone, outcome and notes. Saving adds one to the counter and creates a permanent company timeline entry.
3. When the shared limit is reached, the company moves automatically to **Unreachable**. Jalees controls the limit under **Handler Suite → Calling Rules**.
4. Use each row's **Logs** button to see every saved attempt, caller, phone, outcome and note for that company.
5. A company may be moved manually between other lists. Moving an unreachable company back to **Today's Targets** keeps its lifetime attempt count and its full history; its next unsuccessful attempt is still logged and the rule is applied again.
6. Jalees can add separate manager guidance from a company's **Jalees Notes** column or the **Add / Edit** button on the company screen. Aroosa sees this in a purple **Jalees's Notes for Aroosa** card and above the contact-attempt form; it does not replace her caller notes.

## Access protection

The Aroosa/Jalees login is verified by the server; passwords are supplied through environment variables and are never included in the HTML. Production uses HTTP-only, Secure, SameSite Strict session cookies. Both roles intentionally share one workspace, so Aroosa's saved changes become visible to Jalees after live sync.

## Recovery locations on the host

- Active pipeline: `pipeline_state.json`
- Call history: `call_history.json`
- Shared calling rule: `workspace_settings.json`
- Point-in-time backups: `snapshots/snapshot_*.json`
- Previous pipeline backup: `pipeline_state.json.bak`
- Runtime logs: `logs/`
