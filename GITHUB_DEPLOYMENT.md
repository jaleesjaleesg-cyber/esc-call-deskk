# Safe GitHub deployment workflow

Hostinger deploys the selected GitHub branch automatically after every push. A deployment replaces files in the application directory, so live pipeline data must not live only beside the code.

This project uses the following split:

- GitHub (private repository): app code, tests, compiler, `companies_intelligence.json`, and `metadata.json`.
- Hostinger MySQL: pipeline lists, attempts, notes, call history, workspace settings, deletion tombstones, and snapshots.
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
6. Only after that verification, connect the private GitHub repository to the existing Node website.

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

1. Finish the local research workflow.
2. Run the compiler:

   ```bash
   python3 compile_prospect_database.py
   ```

3. Confirm `companies_intelligence.json` and `metadata.json` changed.
4. Run `npm run verify`.
5. Commit and push only after the checks pass:

   ```bash
   git add companies_intelligence.json metadata.json
   git commit -m "Add researched company batch"
   git push origin main
   ```

The new catalogue is deployed from GitHub. Existing live pipeline status, notes, history, deletions, and snapshots are reloaded from MySQL and are not replaced by the push.

## Never commit

- Login or database passwords
- `.env`
- `pipeline_state.json`
- `call_history.json`
- `workspace_settings.json`
- `deleted_companies.json`
- `snapshots/`
- `node_modules/`
- deployment ZIPs or logs
