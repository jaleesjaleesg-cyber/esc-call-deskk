# ESC Call Desk v7 — Pipeline filters and performance

## Pipeline and review workflow

- Renames the qualified target view to **Needs ACS**.
- Adds independent **Research Required** and **Disqualified Review** views.
- Keeps research disqualification separate from a human call outcome such as Off Our List.
- Adds filters that work within every list: direct contact, website, ACS/research qualification, full dossier availability, calling activity, and pin status.
- Filters can be combined, reset together, and exported.
- The export dialog lets the user choose CSV columns and optionally produces a ZIP containing the CSV plus one Markdown research dossier per researched company.
- Selecting rows changes export scope from the filtered result to the selected companies.

## Bulk controls

- Adds selection across pipeline pages.
- Adds Jalees-only bulk list movement.
- Treats Needs ACS as a research-derived view, not a destination that can falsely requalify a company.
- Enforces the role on `/api/pipeline/bulk`, not only in the browser.
- Creates a recovery snapshot before the bulk move and records each affected company in call history.

## Performance

- Caches pipeline state and call history in browser memory instead of reparsing browser storage for every company and every render.
- Builds contact-history counts once per table render.
- Debounces pipeline search and note autosave.
- Polls a lightweight revision before downloading the full shared state.
- Avoids loading the full company database when a normal snapshot does not include company research.
- Avoids reparsing the snapshot catalogue after routine state saves.
- Sends only changed company entries and newly added history events for ordinary saves; full-state uploads are reserved for recovery, snapshots, and offline reconciliation.

## Deployment boundary

This remains a code-only release. Live company research, pipeline state, call history, notes, settings, deletion tombstones, snapshots, passwords, and `.env` files are excluded. Production must continue to use the existing Hostinger MySQL persistence and Jalees-controlled research import workflow.
