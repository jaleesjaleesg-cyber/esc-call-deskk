# ESC Call Desk v8 — Cloud V9 Single-Step Pipeline, OTP Verification, and Mobile Search

## 1. Single-Step Automated Cloud Pipeline
- Dialed the previous multi-step workflow (manual script run -> download -> upload -> validate -> confirm -> database commit) down to a **single unified step** in the web interface.
- Modern **Cloud Research Engine** card with presets for company count (10, 20, 50, 100), custom SIC codes (default: `80100` Security), and worker concurrency settings.
- Requesting a run triggers Azure scale-to-zero control plane, generating a secure 8-digit one-time passcode (OTP) emailed directly to `jaleesjaleesg@gmail.com`.
- Inline OTP verification in the UI initiates research, live validation, artifact generation, automatic database commit, and snapshot creation in one single step.

## 2. Minimalist UI & Completion Tracking
- Displays **only the completion percentage** (0%–100%) and a clean progress indicator during the research run.
- Completely abstracts internal engineering details, scraper logs, AI prompts, and diagnostic outputs from end users.
- Automatic transition to a completion screen when the run finishes, with instant access to newly added companies.

## 3. UK Mobile & Phone Search
- Added full support for searching companies by decision-maker mobile phone numbers (`07...`, `+44 7...`, `0044 7...`, spaced, or local formatting).
- Search dropdown shows dedicated `📱 Mobile: 07xxx (Director Name)` badges for instant identification.
- Clicking a mobile search result opens the company and automatically focuses on the matching decision maker.
- Integrated across local memory, `/api/companies/search`, and phone search utilities (`phone_search.js`).

## 4. Azure Cloud Architecture & Scale-to-Zero
- Azure Container Apps control plane configured with HTTP scaling rules to scale to zero replicas after 10 minutes of inactivity (`minReplicas: 0`, `maxReplicas: 1`).
- Container Apps Job for research compute triggers on-demand from Azure Queue Storage and terminates upon batch completion.
- Production deployment scripts (`deploy.sh`) and Bicep infrastructure templates (`main.bicep`).
