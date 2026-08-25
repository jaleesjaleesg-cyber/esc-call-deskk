#!/usr/bin/env python3
"""
Cold Calling Copilot Live Server
--------------------------------
Serves the Cold Calling Copilot web app with:
1. Dynamic REST API (/api/status, /api/companies, /api/sync, /api/state, /api/snapshots)
2. Background case directory watcher that auto-recompiles when cases are added/modified
3. Crash-proof atomic state persistence (pipeline_state.json & call_history.json)
4. Comprehensive Snapshot Save, Restore, Export, & Auto-Backup System
5. No-cache static file delivery for real-time frontend syncing
"""

import os
import sys
import json
import re
import time
import glob
import hmac
import secrets
import threading
from http.cookies import SimpleCookie
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

try:
    from compile_prospect_database import (
        compile_database,
        check_needs_recompile,
        METADATA_FILE,
        OUTPUT_JSON,
        CASES_DIR,
        PIPELINE_STATE_FILE,
        CALL_HISTORY_FILE,
        DELETED_COMPANIES_FILE
    )
except ImportError:
    import compile_prospect_database as cpd
    compile_database = cpd.compile_database
    check_needs_recompile = cpd.check_needs_recompile
    METADATA_FILE = cpd.METADATA_FILE
    OUTPUT_JSON = cpd.OUTPUT_JSON
    CASES_DIR = cpd.CASES_DIR
    PIPELINE_STATE_FILE = getattr(cpd, "PIPELINE_STATE_FILE", os.path.join(SCRIPT_DIR, "pipeline_state.json"))
    CALL_HISTORY_FILE = getattr(cpd, "CALL_HISTORY_FILE", os.path.join(SCRIPT_DIR, "call_history.json"))
    DELETED_COMPANIES_FILE = getattr(cpd, "DELETED_COMPANIES_FILE", os.path.join(SCRIPT_DIR, "deleted_companies.json"))

SNAPSHOTS_DIR = os.path.join(SCRIPT_DIR, "snapshots")
WORKSPACE_SETTINGS_FILE = os.path.join(SCRIPT_DIR, "workspace_settings.json")
DEFAULT_WORKSPACE_SETTINGS = {"unreachable_after_attempts": 2}
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
PERSISTENCE_LOCK = threading.RLock()
MAX_REQUEST_BYTES = 32 * 1024 * 1024
AUTO_SNAPSHOT_INTERVAL_SECONDS = max(60, int(os.environ.get("ESC_AUTO_SNAPSHOT_SECONDS", "300")))
SESSION_TTL_SECONDS = 12 * 60 * 60
AUTH_SESSIONS = {}
AUTH_LOCK = threading.RLock()
AUTH_USERS = {
    "aroosa": {
        "name": "Aroosa",
        "role": "caller",
        "passwords": [os.environ.get("ESC_AROOSA_PASSWORD", "aroosa")],
    },
    "jalees": {
        "name": "Jalees",
        "role": "handler",
        "passwords": [password for password in os.environ.get("ESC_JALEES_PASSWORDS", "goraya,jalees").split(",") if password],
    },
}


# =============================================================================
# ATOMIC FILE PERSISTENCE & SNAPSHOT ENGINE
# =============================================================================

def save_json_atomic(filepath, data):
    """Safely saves JSON data atomically using a temporary file."""
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    temp_file = f"{filepath}.tmp.{os.getpid()}.{int(time.time() * 1000)}"
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp_file, filepath)


def load_json_safe(filepath, default_val=None):
    """Safely loads JSON from disk; returns default_val if missing or corrupt."""
    if default_val is None:
        default_val = {}
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            sys.stderr.write(f"[-] Error loading {filepath}: {e}\n")
    return default_val


def load_deleted_companies():
    data = load_json_safe(DELETED_COMPANIES_FILE, {})
    return data if isinstance(data, dict) else {}


def authenticate_credentials(username, password):
    username = str(username or "").strip().lower()
    supplied = str(password or "")
    user = AUTH_USERS.get(username)
    if not user or not supplied:
        return None
    if not any(hmac.compare_digest(supplied, expected) for expected in user["passwords"]):
        return None
    return {"username": username, "name": user["name"], "role": user["role"]}


def create_auth_session(user):
    token = secrets.token_urlsafe(32)
    with AUTH_LOCK:
        now = time.time()
        for old_token, session in list(AUTH_SESSIONS.items()):
            if session.get("expires_at", 0) <= now:
                AUTH_SESSIONS.pop(old_token, None)
        AUTH_SESSIONS[token] = {**user, "expires_at": now + SESSION_TTL_SECONDS}
    return token


def get_auth_session(token):
    if not token:
        return None
    with AUTH_LOCK:
        session = AUTH_SESSIONS.get(token)
        if not session or session.get("expires_at", 0) <= time.time():
            AUTH_SESSIONS.pop(token, None)
            return None
        return {key: session[key] for key in ("username", "name", "role")}


def delete_company_record(crn, deleted_by):
    """Soft-delete a company from generated data and clear its active workspace data."""
    crn = str(crn or "").strip().upper()
    if not crn or not re.fullmatch(r"[A-Z0-9]{4,12}", crn):
        return None, "Invalid company registration number."

    with PERSISTENCE_LOCK:
        companies = load_json_safe(OUTPUT_JSON, {})
        company = companies.get(crn) if isinstance(companies, dict) else None
        if not company:
            return None, "Company not found or already deleted."

        pipeline_state = load_json_safe(PIPELINE_STATE_FILE, {})
        call_history = load_json_safe(CALL_HISTORY_FILE, [])
        create_snapshot(
            name=f"Before deleting {company.get('company_name') or crn}",
            notes=f"Automatic recovery point before Jalees deleted {crn}.",
            created_by=deleted_by,
            snap_type="pre_delete",
            custom_state=pipeline_state,
            custom_history=call_history,
        )

        deleted = load_deleted_companies()
        deleted[crn] = {
            "crn": crn,
            "company_name": company.get("company_name") or crn,
            "deleted_at": int(time.time() * 1000),
            "deleted_by": deleted_by,
        }
        save_json_atomic(DELETED_COMPANIES_FILE, deleted)

        if isinstance(pipeline_state, dict):
            pipeline_state.pop(crn, None)
            save_json_atomic(PIPELINE_STATE_FILE, pipeline_state)
        if isinstance(call_history, list):
            call_history = [item for item in call_history if not isinstance(item, dict) or str(item.get("crn", "")).upper() != crn]
            save_json_atomic(CALL_HISTORY_FILE, call_history)

        compile_database(quiet=True)
        return deleted[crn], None


def get_state_revision():
    mtimes = [os.stat(path).st_mtime_ns for path in (PIPELINE_STATE_FILE, CALL_HISTORY_FILE, WORKSPACE_SETTINGS_FILE, DELETED_COMPANIES_FILE) if os.path.exists(path)]
    return max(mtimes, default=time.time_ns())


def normalize_workspace_settings(settings):
    normalized = dict(DEFAULT_WORKSPACE_SETTINGS)
    if isinstance(settings, dict):
        try:
            normalized["unreachable_after_attempts"] = min(20, max(1, int(settings.get("unreachable_after_attempts", 2))))
        except (TypeError, ValueError):
            pass
    return normalized


def load_workspace_settings():
    return normalize_workspace_settings(load_json_safe(WORKSPACE_SETTINGS_FILE, {}))


def save_workspace_settings(settings):
    with PERSISTENCE_LOCK:
        normalized = normalize_workspace_settings(settings)
        save_json_atomic(WORKSPACE_SETTINGS_FILE, normalized)
        return normalized


def load_workspace_state():
    with PERSISTENCE_LOCK:
        return load_json_safe(PIPELINE_STATE_FILE, {}), load_json_safe(CALL_HISTORY_FILE, []), load_workspace_settings(), get_state_revision()


def _entry_revision(entry, field, fallback_field=None):
    if not isinstance(entry, dict):
        return 0
    return entry.get(field) or (entry.get(fallback_field) if fallback_field else 0) or entry.get("last_updated", 0) or 0


def merge_pipeline_entries_by_revision(disk_entry, incoming_entry):
    """Merge independently edited pipeline, caller-note, and pin fields."""
    disk_entry = disk_entry if isinstance(disk_entry, dict) else {}
    incoming_entry = incoming_entry if isinstance(incoming_entry, dict) else {}
    disk_last = disk_entry.get("last_updated", 0) or 0
    incoming_last = incoming_entry.get("last_updated", 0) or 0
    merged = {**disk_entry, **incoming_entry} if incoming_last >= disk_last else {**incoming_entry, **disk_entry}

    groups = (
        ("pipeline_updated_at", None, ("pipeline_list", "contact_attempts", "last_phone_used", "last_dm_reached")),
        ("notes_updated_at", None, ("call_notes", "last_outcome")),
        ("pin_updated_at", "pinned_at", ("is_pinned", "pinned_at", "pinned_by")),
    )
    for revision_field, fallback_field, fields in groups:
        incoming_revision = _entry_revision(incoming_entry, revision_field, fallback_field)
        disk_revision = _entry_revision(disk_entry, revision_field, fallback_field)
        source = incoming_entry if incoming_revision >= disk_revision else disk_entry
        for field in fields:
            if field in source:
                merged[field] = source[field]
        merged[revision_field] = _entry_revision(source, revision_field, fallback_field)

    merged["last_updated"] = max(disk_last, incoming_last)
    return merged


def merge_workspace_state(pipeline_state=None, call_history=None, replace_history=False):
    """Merge one browser's copy without allowing an older tab to overwrite newer entries."""
    with PERSISTENCE_LOCK:
        deleted_company_ids = set(load_deleted_companies())
        if isinstance(pipeline_state, dict):
            current_state = load_json_safe(PIPELINE_STATE_FILE, {})
            for crn, entry in pipeline_state.items():
                if str(crn).strip().upper() in deleted_company_ids:
                    continue
                if not isinstance(entry, dict):
                    continue
                disk_entry = current_state.get(crn)
                if not isinstance(disk_entry, dict):
                    current_state[crn] = entry
                    continue

                # List movement, caller notes, pins, and manager guidance can be
                # edited by different people at nearly the same time. Merge each
                # domain by its own revision so a newer note cannot undo a list move.
                merged_entry = merge_pipeline_entries_by_revision(disk_entry, entry)

                incoming_manager_revision = entry.get("jalees_notes_updated_at", 0) or 0
                disk_manager_revision = disk_entry.get("jalees_notes_updated_at", 0) or 0
                manager_source = entry if incoming_manager_revision >= disk_manager_revision else disk_entry
                for field in ("jalees_notes", "jalees_notes_updated_at", "jalees_notes_updated_by"):
                    if field in manager_source:
                        merged_entry[field] = manager_source[field]
                current_state[crn] = merged_entry
            save_json_atomic(PIPELINE_STATE_FILE, current_state)

        if isinstance(call_history, list):
            call_history = [
                item for item in call_history
                if isinstance(item, dict) and str(item.get("crn", "")).strip().upper() not in deleted_company_ids
            ]
            if replace_history:
                merged_history = [item for item in call_history if isinstance(item, dict)]
            else:
                disk_history = [
                    item for item in load_json_safe(CALL_HISTORY_FILE, [])
                    if isinstance(item, dict) and str(item.get("crn", "")).strip().upper() not in deleted_company_ids
                ]
                history_map = {str(item.get("id") or item.get("timestamp")): item for item in disk_history if isinstance(item, dict)}
                for item in call_history:
                    if isinstance(item, dict):
                        history_map[str(item.get("id") or item.get("timestamp"))] = item
                merged_history = sorted(history_map.values(), key=lambda item: item.get("id") or 0, reverse=True)
            save_json_atomic(CALL_HISTORY_FILE, merged_history)

        return load_json_safe(PIPELINE_STATE_FILE, {}), load_json_safe(CALL_HISTORY_FILE, []), get_state_revision()


def clear_call_history_record(cleared_by="User"):
    """Atomically clears call history from disk after saving a recovery snapshot."""
    with PERSISTENCE_LOCK:
        pipeline_state = load_json_safe(PIPELINE_STATE_FILE, {})
        call_history = load_json_safe(CALL_HISTORY_FILE, [])
        if call_history:
            create_snapshot(
                name=f"Before clearing history ({len(call_history)} records)",
                notes=f"Automatic recovery point before call history was cleared by {cleared_by}.",
                created_by=cleared_by,
                snap_type="pre_clear_history",
                custom_state=pipeline_state,
                custom_history=call_history,
            )
        save_json_atomic(CALL_HISTORY_FILE, [])
        return get_state_revision()


def compute_snapshot_stats(pipeline_state, call_history, total_companies_count=0):
    """Computes distribution counts for pipeline lists and history."""
    counts = {
        "all_qualified": 0,
        "todays_targets": 0,
        "sia_approved_entries": 0,
        "contacted": 0,
        "reached": 0,
        "unreachable": 0,
        "off_our_list": 0,
        "permanently_off_our_list": 0,
        "master_list": 0
    }
    if isinstance(pipeline_state, dict):
        for item in pipeline_state.values():
            list_name = item.get("pipeline_list") if isinstance(item, dict) else None
            if list_name in counts:
                counts[list_name] += 1
            elif list_name:
                counts["master_list"] += 1

    return {
        "total_tracked": len(pipeline_state) if isinstance(pipeline_state, dict) else 0,
        "total_companies": total_companies_count or (len(pipeline_state) if isinstance(pipeline_state, dict) else 0),
        "todays_targets": counts["todays_targets"],
        "all_qualified": counts["all_qualified"],
        "sia_approved_entries": counts["sia_approved_entries"],
        "contacted": counts["contacted"],
        "reached": counts["reached"],
        "unreachable": counts["unreachable"],
        "off_our_list": counts["off_our_list"],
        "permanently_off_our_list": counts["permanently_off_our_list"],
        "total_history_records": len(call_history) if isinstance(call_history, list) else 0
    }


def list_all_snapshots():
    """Lists all available snapshots sorted newest first."""
    os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
    files = glob.glob(os.path.join(SNAPSHOTS_DIR, "snapshot_*.json"))
    snapshots = []
    for filepath in files:
        filename = os.path.basename(filepath)
        try:
            data = load_json_safe(filepath, {})
            if data:
                stat = os.stat(filepath)
                snapshots.append({
                    "id": data.get("id") or filename.replace(".json", ""),
                    "filename": filename,
                    "name": data.get("name") or filename,
                    "type": data.get("type", "manual"),
                    "timestamp": data.get("timestamp", int(stat.st_mtime * 1000)),
                    "date_str": data.get("date_str") or time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
                    "created_by": data.get("created_by", "User"),
                    "notes": data.get("notes", ""),
                    "stats": data.get("stats") or {},
                    "size_bytes": stat.st_size
                })
        except Exception:
            pass
    snapshots.sort(key=lambda s: s.get("timestamp", 0), reverse=True)
    return snapshots


def create_snapshot(name="Manual Snapshot", notes="", created_by="User", snap_type="manual", custom_state=None, custom_history=None, custom_settings=None):
    """Creates a persistent snapshot backup file on disk."""
    with PERSISTENCE_LOCK:
        os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
        pipeline_state = custom_state if custom_state is not None else load_json_safe(PIPELINE_STATE_FILE, {})
        call_history = custom_history if custom_history is not None else load_json_safe(CALL_HISTORY_FILE, [])
        workspace_settings = normalize_workspace_settings(custom_settings if custom_settings is not None else load_json_safe(WORKSPACE_SETTINGS_FILE, {}))

    now_ts = int(time.time() * 1000)
    date_str = time.strftime("%Y-%m-%d %H:%M:%S")
    clean_name = (name or "snapshot").strip()
    slug = re.sub(r'[^a-zA-Z0-9_-]', '_', clean_name.lower())[:35]
    snap_id = f"snapshot_{time.strftime('%Y%m%d_%H%M%S')}_{now_ts % 1000:03d}_{slug}"
    filename = f"{snap_id}.json"
    filepath = os.path.join(SNAPSHOTS_DIR, filename)

    stats = compute_snapshot_stats(pipeline_state, call_history)

    snapshot_doc = {
        "id": snap_id,
        "name": clean_name or f"Snapshot {date_str}",
        "type": snap_type,
        "timestamp": now_ts,
        "date_str": date_str,
        "created_by": created_by or "User",
        "notes": notes or "",
        "stats": stats,
        "pipeline_state": pipeline_state,
        "call_history": call_history,
        "settings": workspace_settings
    }

    save_json_atomic(filepath, snapshot_doc)

    # Auto prune old auto-snapshots to keep directory lightweight
    if snap_type == "auto":
        all_snaps = list_all_snapshots()
        auto_snaps = [s for s in all_snaps if s.get("type") == "auto"]
        if len(auto_snaps) > 25:
            for old in auto_snaps[25:]:
                old_path = os.path.join(SNAPSHOTS_DIR, old["filename"])
                if os.path.exists(old_path):
                    try:
                        os.remove(old_path)
                    except Exception:
                        pass

    return {
        "id": snap_id,
        "filename": filename,
        "name": snapshot_doc["name"],
        "type": snap_type,
        "timestamp": now_ts,
        "date_str": date_str,
        "created_by": snapshot_doc["created_by"],
        "notes": snapshot_doc["notes"],
        "stats": stats,
        "size_bytes": os.path.getsize(filepath)
    }


def restore_snapshot(snap_id_or_filename):
    """Restores active pipeline state and history from a chosen snapshot."""
    filename = snap_id_or_filename if snap_id_or_filename.endswith(".json") else f"{snap_id_or_filename}.json"
    filepath = os.path.join(SNAPSHOTS_DIR, filename)
    if not os.path.exists(filepath):
        matches = [f for f in glob.glob(os.path.join(SNAPSHOTS_DIR, "*.json")) if snap_id_or_filename in os.path.basename(f)]
        if matches:
            filepath = matches[0]
        else:
            return None, f"Snapshot '{snap_id_or_filename}' not found."

    with PERSISTENCE_LOCK:
        snapshot_doc = load_json_safe(filepath)
        if not snapshot_doc or "pipeline_state" not in snapshot_doc:
            return None, "Corrupted snapshot file: missing pipeline_state."

        pipeline_state = snapshot_doc.get("pipeline_state", {})
        call_history = snapshot_doc.get("call_history", [])
        workspace_settings = normalize_workspace_settings(snapshot_doc.get("settings", {}))

        save_json_atomic(PIPELINE_STATE_FILE, pipeline_state)
        save_json_atomic(CALL_HISTORY_FILE, call_history)
        save_json_atomic(WORKSPACE_SETTINGS_FILE, workspace_settings)

    # Recompile database to propagate restored state
    compile_database(quiet=True)

    return {
        "id": snapshot_doc.get("id"),
        "name": snapshot_doc.get("name"),
        "restored_at": time.time(),
        "stats": compute_snapshot_stats(pipeline_state, call_history),
        "pipeline_state": pipeline_state,
        "call_history": call_history,
        "settings": workspace_settings
    }, None


# =============================================================================
# HTTP SERVER & API REQUEST ROUTING
# =============================================================================

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class CopilotRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SCRIPT_DIR, **kwargs)

    def end_headers(self):
        # Disable caching for live data synchronization
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def _send_json(self, data, status_code=200, cookie_header=None):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        if cookie_header:
            self.send_header("Set-Cookie", cookie_header)
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get("esc_session")
        return morsel.value if morsel else ""

    def _current_user(self):
        return get_auth_session(self._session_token())

    def _read_json_body(self):
        try:
            content_len = int(self.headers.get('Content-Length', 0))
            if content_len > MAX_REQUEST_BYTES:
                raise ValueError("request body is too large")
            if content_len > 0:
                raw_body = self.rfile.read(content_len)
                return json.loads(raw_body.decode('utf-8'))
        except Exception as e:
            sys.stderr.write(f"[-] Error parsing JSON body: {e}\n")
        return {}

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        if path == "/api/auth/session":
            user = self._current_user()
            if not user:
                self._send_json({"authenticated": False}, status_code=401)
            else:
                self._send_json({"authenticated": True, "user": user})
            return

        # 1. /api/status
        if path.startswith("/api/status"):
            meta = load_json_safe(METADATA_FILE, {})
            if not meta:
                meta = {
                    "status": "active",
                    "case_count": 0,
                    "qualified_count": 0,
                    "total_prospects": 0,
                    "last_updated": time.time()
                }
            self._send_json(meta)
            return

        # 2. /api/companies
        if path.startswith("/api/companies"):
            if check_needs_recompile():
                compile_database(quiet=True)

            if os.path.exists(OUTPUT_JSON):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                with open(OUTPUT_JSON, "rb") as f:
                    while chunk := f.read(65536):
                        self.wfile.write(chunk)
                return
            else:
                self._send_json({"error": "Database not compiled"}, status_code=404)
                return

        # 3. /api/state (persisted pipeline state & history)
        if path.startswith("/api/state"):
            pipeline_state, call_history, settings, revision = load_workspace_state()
            stats = compute_snapshot_stats(pipeline_state, call_history)
            self._send_json({
                "status": "ok",
                "last_updated": revision // 1_000_000,
                "revision": revision,
                "stats": stats,
                "pipeline_state": pipeline_state,
                "call_history": call_history,
                "settings": settings
            })
            return

        if path.startswith("/api/settings"):
            self._send_json({"status": "ok", "settings": load_workspace_settings(), "revision": get_state_revision()})
            return

        # 4. /api/snapshots (list all snapshots)
        if path == "/api/snapshots":
            snapshots = list_all_snapshots()
            self._send_json({
                "status": "ok",
                "snapshots": snapshots,
                "total_snapshots": len(snapshots)
            })
            return

        # 5. /api/snapshots/download
        if path.startswith("/api/snapshots/download"):
            query_params = parse_qs(parsed_url.query)
            snap_id = (query_params.get("id") or query_params.get("filename") or [""])[0]
            if not snap_id:
                self._send_json({"error": "Missing snapshot id or filename"}, status_code=400)
                return

            filename = snap_id if snap_id.endswith(".json") else f"{snap_id}.json"
            filepath = os.path.join(SNAPSHOTS_DIR, filename)
            if not os.path.exists(filepath):
                matches = [f for f in glob.glob(os.path.join(SNAPSHOTS_DIR, "*.json")) if snap_id in os.path.basename(f)]
                if matches:
                    filepath = matches[0]
                    filename = os.path.basename(filepath)
                else:
                    self._send_json({"error": "Snapshot file not found"}, status_code=404)
                    return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            with open(filepath, "rb") as f:
                while chunk := f.read(65536):
                    self.wfile.write(chunk)
            return

        # Default static file handling
        return super().do_GET()

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        body = self._read_json_body()

        if path == "/api/auth/login":
            user = authenticate_credentials(body.get("username"), body.get("password"))
            if not user:
                self._send_json({"error": "Invalid username or password."}, status_code=401)
                return
            token = create_auth_session(user)
            cookie = f"esc_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL_SECONDS}"
            self._send_json({"status": "ok", "user": user}, cookie_header=cookie)
            return

        if path == "/api/auth/logout":
            token = self._session_token()
            with AUTH_LOCK:
                AUTH_SESSIONS.pop(token, None)
            self._send_json(
                {"status": "ok"},
                cookie_header="esc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
            )
            return

        if path == "/api/companies/delete":
            user = self._current_user()
            if not user:
                self._send_json({"error": "Please log in again before deleting a company."}, status_code=401)
                return
            if user.get("username") != "jalees" or user.get("role") != "handler":
                self._send_json({"error": "Only Jalees can delete companies."}, status_code=403)
                return
            deleted, err = delete_company_record(body.get("crn"), user["name"])
            if err:
                status = 404 if "not found" in err.lower() else 400
                self._send_json({"error": err}, status_code=status)
                return
            self._send_json({"status": "ok", "deleted": deleted, "revision": get_state_revision()})
            return

        if path == "/api/history/clear" or path.startswith("/api/history/clear"):
            user = self._current_user()
            cleared_by = (user.get("name") if user else None) or body.get("active_user") or "User"
            revision = clear_call_history_record(cleared_by=cleared_by)
            self._send_json({
                "status": "ok",
                "message": "Call history cleared successfully.",
                "revision": revision,
                "call_history": []
            })
            return

        # 1. /api/sync (recompile on demand)
        if path.startswith("/api/sync"):
            res = compile_database(quiet=True)
            self._send_json(res.get("metadata", {"status": "synced"}))
            return

        if path.startswith("/api/settings"):
            settings = save_workspace_settings(body.get("settings") or body)
            self._send_json({"status": "ok", "settings": settings, "revision": get_state_revision()})
            return

        # 2. /api/state (save pipeline state and/or call history)
        if path.startswith("/api/state"):
            pipeline_state = body.get("pipeline_state")
            call_history = body.get("call_history")
            caller = body.get("active_user") or "User"

            current_pipeline, current_history, revision = merge_workspace_state(
                pipeline_state,
                call_history,
                replace_history=bool(body.get("replace_history")),
            )

            # Check if auto-snapshot requested
            if body.get("create_snapshot") or body.get("auto_snapshot"):
                snap_name = body.get("snapshot_name") or f"Auto Save by {caller}"
                create_snapshot(
                    name=snap_name,
                    notes=body.get("snapshot_notes", ""),
                    created_by=caller,
                    snap_type="auto"
                )

            current_pipeline, current_history, settings, revision = load_workspace_state()
            stats = compute_snapshot_stats(current_pipeline, current_history)

            self._send_json({
                "status": "ok",
                "saved_at": int(time.time() * 1000),
                "revision": revision,
                "settings": settings,
                "stats": stats
            })
            return

        # 3. /api/snapshots/create (save snapshot)
        if path.startswith("/api/snapshots/create"):
            snap_name = body.get("name") or "Manual Snapshot"
            snap_notes = body.get("notes", "")
            created_by = body.get("created_by") or "User"
            snap_type = body.get("type", "manual")
            custom_state = body.get("pipeline_state")
            custom_history = body.get("call_history")
            custom_settings = body.get("settings")

            # Merge the browser copy into the host before capturing both destinations.
            merge_workspace_state(custom_state, custom_history)
            if custom_settings is not None:
                save_workspace_settings(custom_settings)

            info = create_snapshot(
                name=snap_name,
                notes=snap_notes,
                created_by=created_by,
                snap_type=snap_type,
                custom_settings=custom_settings
            )
            self._send_json({"status": "ok", "snapshot": info})
            return

        # 4. /api/snapshots/restore (restore snapshot)
        if path.startswith("/api/snapshots/restore"):
            snap_id = body.get("id") or body.get("filename")
            if not snap_id:
                self._send_json({"error": "Missing snapshot id or filename"}, status_code=400)
                return

            restored, err = restore_snapshot(snap_id)
            if err:
                self._send_json({"error": err}, status_code=400)
                return

            self._send_json({
                "status": "ok",
                "message": f"Successfully restored snapshot '{restored.get('name')}'.",
                "restored": restored
            })
            return

        # 5. /api/snapshots/delete (delete snapshot)
        if path.startswith("/api/snapshots/delete"):
            snap_id = body.get("id") or body.get("filename")
            if not snap_id:
                self._send_json({"error": "Missing snapshot id or filename"}, status_code=400)
                return

            filename = snap_id if snap_id.endswith(".json") else f"{snap_id}.json"
            filepath = os.path.join(SNAPSHOTS_DIR, filename)
            if not os.path.exists(filepath):
                matches = [f for f in glob.glob(os.path.join(SNAPSHOTS_DIR, "*.json")) if snap_id in os.path.basename(f)]
                if matches:
                    filepath = matches[0]
                else:
                    self._send_json({"error": "Snapshot not found"}, status_code=404)
                    return

            try:
                os.remove(filepath)
                self._send_json({"status": "ok", "message": f"Snapshot deleted."})
            except Exception as e:
                self._send_json({"error": f"Failed to delete snapshot: {e}"}, status_code=500)
            return

        # 6. /api/snapshots/upload (import snapshot)
        if path.startswith("/api/snapshots/upload"):
            payload = body.get("snapshot") or body
            if not payload or not isinstance(payload, dict) or "pipeline_state" not in payload:
                self._send_json({"error": "Invalid snapshot file format: missing pipeline_state"}, status_code=400)
                return

            now_ts = int(time.time() * 1000)
            snap_name = payload.get("name") or f"Imported Snapshot {time.strftime('%Y-%m-%d %H:%M')}"
            slug = re.sub(r'[^a-zA-Z0-9_-]', '_', snap_name.lower())[:30]
            snap_id = f"snapshot_{time.strftime('%Y%m%d_%H%M%S')}_{slug}"
            filename = f"{snap_id}.json"
            filepath = os.path.join(SNAPSHOTS_DIR, filename)

            payload["id"] = snap_id
            payload["timestamp"] = payload.get("timestamp") or now_ts
            payload["date_str"] = payload.get("date_str") or time.strftime("%Y-%m-%d %H:%M:%S")
            payload["stats"] = compute_snapshot_stats(payload.get("pipeline_state", {}), payload.get("call_history", []))

            save_json_atomic(filepath, payload)

            if body.get("restore_immediately"):
                restore_snapshot(snap_id)

            self._send_json({
                "status": "ok",
                "message": "Snapshot imported successfully.",
                "snapshot": {
                    "id": snap_id,
                    "filename": filename,
                    "name": snap_name,
                    "type": "imported",
                    "timestamp": payload["timestamp"],
                    "date_str": payload["date_str"],
                    "created_by": payload.get("created_by", "Imported"),
                    "notes": payload.get("notes", ""),
                    "stats": payload["stats"],
                    "size_bytes": os.path.getsize(filepath)
                }
            })
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        # Only log non-static requests or errors to keep terminal clean
        try:
            message = format % args
        except (TypeError, ValueError):
            message = " ".join(str(arg) for arg in args)
        if "/api/" in message or re.search(r"\b[45]\d\d\b", message):
            sys.stderr.write(f"[{self.log_date_time_string()}] {message}\n")


def background_watcher():
    """Monitors output/v9/cases directory for changes and compiles automatically."""
    time.sleep(2)
    while True:
        try:
            if check_needs_recompile():
                compile_database(quiet=True)
        except Exception:
            pass
        time.sleep(3)


def background_snapshotter():
    """Keep rotating recovery points when the persisted workspace changes."""
    last_snapshot_revision = get_state_revision()
    while True:
        time.sleep(AUTO_SNAPSHOT_INTERVAL_SECONDS)
        try:
            current_revision = get_state_revision()
            if current_revision != last_snapshot_revision:
                create_snapshot(
                    name="Automatic recovery point",
                    notes="Periodic host-side backup of the shared workspace.",
                    created_by="System",
                    snap_type="auto",
                )
                last_snapshot_revision = current_revision
        except Exception as exc:
            sys.stderr.write(f"[-] Automatic snapshot failed: {exc}\n")


def run_server(port=8000):
    # Initial compile check
    if check_needs_recompile():
        print("[*] Initializing Intelligence Database...")
        compile_database(quiet=False)
    else:
        print("[*] Intelligence Database is up to date.")

    # Start background auto-sync watcher
    watcher_thread = threading.Thread(target=background_watcher, daemon=True)
    watcher_thread.start()
    snapshot_thread = threading.Thread(target=background_snapshotter, daemon=True)
    snapshot_thread.start()

    server_address = ("", port)
    httpd = ThreadedHTTPServer(server_address, CopilotRequestHandler)
    print(f"[*] Copilot Live Server running on port {port} (PID: {os.getpid()})")
    print(f"[*] Persistence store: {PIPELINE_STATE_FILE}")
    print(f"[*] Snapshots directory: {SNAPSHOTS_DIR}")
    print(f"[*] Automatic recovery snapshots: every {AUTO_SNAPSHOT_INTERVAL_SECONDS} seconds after changes")
    print(f"[*] Background watcher active for: {CASES_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server...")
        httpd.server_close()


if __name__ == "__main__":
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run_server(port)
