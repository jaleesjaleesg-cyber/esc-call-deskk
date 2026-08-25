# Safe GitHub deployment workflow

Hostinger deploys the selected GitHub branch automatically after every push. A deployment replaces files in the application directory, so live pipeline data must not live only beside the code.

This project uses the following split:

- GitHub (private repository): application code, tests and compiler code only.
- Hostinger MySQL: company research, database metadata, pipeline lists, attempts, notes, call history, workspace settings, deletion tombstones, and snapshots.
- Ignored local files: passwords, `.env`, runtime JSON, snapshots, logs, dependencies, and deployment ZIPs.

## One-time migration before connecting GitHub

1. In hPanel, create a MySQL database under **Databases → MySQL Databases**.
2. In the Node app's environment variables, keep the two existing login variables and add:

   ```text
   ESC_REQUIRE_DATABASE=1
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=<Hostinger database username>
   DB_PASSWORD=<Hostinger database password>
   DB_NAME=<Hostinger database name>
   ```

3. Upload the transition ZIP supplied from `deploy/`. It includes the current repaired JSON state once so the first MySQL startup can import it.
4. In **Runtime logs**, confirm this exact success message appears:

   ```text
   [Persistence] MySQL connected; runtime state will survive redeployments.
   ```

5. Sign in and confirm the expected list counts, notes, history, and snapshots.
6. Only after that verification, stop tracking the two legacy catalogue files while keeping the local copies:

   ```bash
   git rm --cached companies_intelligence.json metadata.json
   git add .gitignore
   git commit -m "Move live company data out of GitHub"
   ```

7. Push that commit, then connect the private GitHub repository to the existing Node website.

If any database variable is missing or the database cannot be reached, the production app fails closed instead of silently accepting changes into disposable deployment files.

## Normal code update

From the project directory:

```bash
npm run verify
git add -A
git commit -m "Describe the change"
git push origin main
```

The GitHub verification workflow runs the Python and Node regression suites. Hostinger also detects the push and deploys the selected branch.

## Add a completed batch of researched companies

1. From `final acs system/v9`, run the local research workflow:

   ```bash
   python3 main.py workflow --count 100 --concurrency 100
   ```

   This compiles the completed research in memory and does not rewrite the Call Desk's local company or call-state files.
2. The workflow compiles the cases and prints the generated import path, for example:

   ```bash
   output/v9/imports/research_import_staged_batch_sic80100_100_new_....json
   ```

3. Sign in to `calls.escsupportltd.co.uk` as Jalees.
4. Open **Handler Suite → Import Research** and select that file.
5. Review the New, Updates and Rejected counts, then click **Commit Import**.
6. The server creates a pre-import recovery snapshot, writes accepted research records to the durable company database, and updates metadata. Existing call status, notes, pins, history and deletion tombstones are preserved; the recovery snapshot can restore the previous catalogue if needed.
7. Every signed-in Call Desk refreshes automatically within about five seconds.

Do not commit or push a researched company batch to GitHub.

## Never commit

- Login or database passwords
- `.env`
- `companies_intelligence.json`
- `metadata.json`
- `pipeline_state.json`
- `call_history.json`
- `workspace_settings.json`
- `deleted_companies.json`
- `snapshots/`
- `node_modules/`
- deployment ZIPs or logs
