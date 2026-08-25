#!/usr/bin/env python3
"""One-time, evidence-based repair for contacts saved in Today's Targets.

The old response form saved notes and outcomes while silently retaining the
company's existing list.  These explicit corrections are based only on the
saved outcome/notes.  Records that merely say no contact information was
available are deliberately left for manual review.
"""

import json
import time

import server


REPAIR_VERSION = "2026-08-25-contact-routing-v2"
ROUTING_REPAIRS = {
    # CRN: (target list, minimum attempt count, evidence)
    "SC895247": ("unreachable", 2, "A second unsuccessful attempt was saved as No answer."),
    "SC529301": ("off_our_list", 1, "Contact notes identify a wrong number."),
    "SC691033": ("off_our_list", 1, "Contact notes identify a wrong number."),
    "SC752935": ("unreachable", 2, "A second unsuccessful attempt was saved as No answer."),
    "11059555": ("off_our_list", 1, "The saved outcome says Not interested."),
    "12599772": ("reached", 1, "The saved outcome says Email the info."),
    "10857233": ("off_our_list", 1, "The saved notes say the authority was not interested."),
    "SC868621": ("off_our_list", 0, "The saved outcome says Not interested."),
    "11755119": ("contacted", 1, "A voicemail attempt was recorded."),
    "12134890": ("contacted", 1, "Busy / call tomorrow is an unsuccessful contact attempt, not evidence that the decision maker was reached."),
    "12210431": ("reached", 0, "The saved outcome says Email the info."),
    "13126410": ("off_our_list", 0, "The saved outcome says Not interested."),
    "00685176": ("reached", 0, "The saved outcome says Email the info."),
    "07751578": ("contacted", 1, "A voicemail attempt was recorded."),
    "10565277": ("contacted", 1, "A referral was recorded but the decision maker was not reached."),
    "11111259": ("off_our_list", 0, "The saved outcome says Not interested."),
    "12263245": ("off_our_list", 0, "The saved outcome says Not interested."),
    "12584663": ("contacted", 1, "A voicemail attempt was recorded."),
    "12584680": ("contacted", 1, "A voicemail attempt was recorded."),
    "12606966": ("contacted", 1, "An unsuccessful attempt found the number was not in service."),
    "12668435": ("contacted", 1, "A voicemail attempt was recorded."),
    "12864917": ("off_our_list", 0, "The saved outcome says Not interested."),
    "14283753": ("contacted", 1, "A voicemail attempt was recorded."),
    "15145431": ("contacted", 1, "A No Answer attempt was recorded."),
    "04962248": ("contacted", 1, "A voicemail attempt was recorded."),
    "08173921": ("off_our_list", 0, "The saved outcome says Not interested."),
    "06257050": ("contacted", 1, "A No Answer attempt was recorded."),
    "08744269": ("off_our_list", 0, "The saved outcome says Not interested."),
    "08709736": ("contacted", 1, "A voicemail attempt was recorded."),
    "NI638479": ("contacted", 1, "Call tomorrow does not establish that the decision maker was reached."),
    "07014594": ("contacted", 1, "A voicemail attempt was recorded."),
    "08655784": ("contacted", 1, "Call tomorrow does not establish that the decision maker was reached."),
    "07731927": ("contacted", 1, "A No Answer attempt was recorded."),
}

DEFERRED_REVIEW = {
    "12572025", "14870919", "SC788938", "SC852294",
    "SC865370", "SC521023", "SC736028", "SC754412",
}

LIST_NAMES = {
    "contacted": "Contacted - Not Reached",
    "reached": "Reached",
    "unreachable": "Unreachable",
    "off_our_list": "Off Our List",
}


def main():
    with server.PERSISTENCE_LOCK:
        state = server.load_json_safe(server.PIPELINE_STATE_FILE, {})
        history = server.load_json_safe(server.CALL_HISTORY_FILE, [])
        companies = server.load_json_safe(server.OUTPUT_JSON, {})
        eligible = []

        for crn, (target_list, minimum_attempts, reason) in ROUTING_REPAIRS.items():
            entry = state.get(crn)
            if not isinstance(entry, dict):
                continue
            if entry.get("routing_repair_version") == REPAIR_VERSION:
                continue
            if not (str(entry.get("call_notes") or "").strip() or str(entry.get("last_outcome") or "").strip()):
                continue
            current_attempts = int(entry.get("contact_attempts") or 0)
            if entry.get("pipeline_list") == target_list and current_attempts >= minimum_attempts:
                continue
            eligible.append((crn, target_list, minimum_attempts, reason))

        if not eligible:
            print(json.dumps({
                "status": "ok",
                "repaired": 0,
                "deferred_for_manual_review": len(DEFERRED_REVIEW),
                "repair_version": REPAIR_VERSION,
            }))
            return

        snapshot = server.create_snapshot(
            name="Before contact routing repair",
            notes="Recovery point before moving contacts that were incorrectly left in Today's Targets.",
            created_by="System",
            snap_type="pre_routing_repair",
            custom_state=state,
            custom_history=history,
        )

        now = int(time.time() * 1000)
        repaired_counts = {}
        for offset, (crn, target_list, minimum_attempts, reason) in enumerate(eligible):
            entry = dict(state[crn])
            attempts = max(int(entry.get("contact_attempts") or 0), minimum_attempts)
            updated_at = now + offset
            entry.update({
                "pipeline_list": target_list,
                "contact_attempts": attempts,
                "pipeline_updated_at": updated_at,
                "last_updated": updated_at,
                "last_caller": "System",
                "routing_repair_version": REPAIR_VERSION,
                "routing_repaired_at": updated_at,
            })
            state[crn] = entry

            company = companies.get(crn) if isinstance(companies, dict) else {}
            history.append({
                "id": updated_at,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "isoDate": time.strftime("%Y-%m-%d"),
                "caller": "System",
                "crn": crn,
                "company_name": (company or {}).get("company_name") or crn,
                "decision_maker": entry.get("last_dm_reached") or "Director",
                "phone_used": entry.get("last_phone_used") or "-",
                "transition": LIST_NAMES[target_list],
                "outcome": entry.get("last_outcome") or "Routing corrected from saved contact notes",
                "notes": "Routing repair: " + reason,
                "list": target_list,
                "event_type": "routing_repair",
                "attempt_number": attempts,
            })
            repaired_counts[target_list] = repaired_counts.get(target_list, 0) + 1

        history.sort(key=lambda item: item.get("id") or 0, reverse=True)
        server.save_json_atomic(server.PIPELINE_STATE_FILE, state)
        server.save_json_atomic(server.CALL_HISTORY_FILE, history)

    print(json.dumps({
        "status": "ok",
        "repaired": len(eligible),
        "by_list": repaired_counts,
        "deferred_for_manual_review": len(DEFERRED_REVIEW),
        "snapshot": snapshot["filename"],
        "repair_version": REPAIR_VERSION,
    }, indent=2))


if __name__ == "__main__":
    main()
