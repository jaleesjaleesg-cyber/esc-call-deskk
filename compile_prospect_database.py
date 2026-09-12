#!/usr/bin/env python3
"""
compile_prospect_database.py
Aggregates all company intelligence from:
1. generate_sia_acs_word_report.py (Ranked 37 company dossiers, tailored pitches, why_buy, target packages, email angles, evidence)
2. final acs system/output/v9/cases/ (All investigated cases with decision.json, contacts.json, evidence.jsonl, investigation_report.md)
3. final acs system/output/v9/prospects_v9_master.json
4. final acs system/prospect_sources/master_registry/master_all_companies.json (Registry entries)

Outputs:
- cold_calling/companies_intelligence.json
- cold_calling/companies_intelligence_data.js (window.COMPANIES_INTELLIGENCE)
- cold_calling/metadata.json (sync status, counts, timestamps)
"""

import os
import sys
import json
import glob
import re
import time
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
ACS_DIR = os.path.join(ROOT_DIR, "final acs system")
CASES_DIR = os.getenv("ESC_V9_CASES_DIR", os.path.join(ACS_DIR, "output/v9/cases"))
SIA_ACS_CSV = os.getenv("ESC_SIA_ACS_CSV", os.path.join(ROOT_DIR, "ALL SIA ACS APPROVED COMPANIES - company_house_numbers.csv.csv"))
METADATA_FILE = os.path.join(SCRIPT_DIR, "metadata.json")
OUTPUT_JSON = os.path.join(SCRIPT_DIR, "companies_intelligence.json")
OUTPUT_JS = os.path.join(SCRIPT_DIR, "companies_intelligence_data.js")
PIPELINE_STATE_FILE = os.path.join(SCRIPT_DIR, "pipeline_state.json")
CALL_HISTORY_FILE = os.path.join(SCRIPT_DIR, "call_history.json")
DELETED_COMPANIES_FILE = os.path.join(SCRIPT_DIR, "deleted_companies.json")


def load_persisted_pipeline_state():
    """Loads persisted user pipeline state from disk if present."""
    if os.path.exists(PIPELINE_STATE_FILE):
        try:
            with open(PIPELINE_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception as e:
            print(f"[-] Warning loading pipeline_state.json: {e}")
    return {}


def load_deleted_company_ids():
    """Load CRNs hidden from every generated cold-calling database."""
    if not os.path.exists(DELETED_COMPANIES_FILE):
        return set()
    try:
        with open(DELETED_COMPANIES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(crn).strip().upper() for crn in data}
        if isinstance(data, list):
            return {str(crn).strip().upper() for crn in data}
    except Exception as e:
        print(f"[-] Warning loading deleted_companies.json: {e}")
    return set()


def load_sia_acs_registry():
    """Loads all official SIA ACS approved companies from the project CSV."""
    sia_map = {}
    if not os.path.exists(SIA_ACS_CSV):
        return sia_map
    try:
        import csv
        with open(SIA_ACS_CSV, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            for row in reader:
                if len(row) >= 2:
                    raw_name = row[0].strip()
                    raw_crn = row[1].strip().upper()
                    acts = row[2].strip() if len(row) > 2 else ""
                    dirs = row[3].strip() if len(row) > 3 else ""
                    if raw_crn:
                        norm_crn = raw_crn.zfill(8) if raw_crn.isdigit() and len(raw_crn) < 8 else raw_crn
                        info = {
                            "name": raw_name,
                            "crn": norm_crn,
                            "raw_crn": raw_crn,
                            "activities": acts,
                            "directors": dirs
                        }
                        sia_map[norm_crn] = info
                        sia_map[raw_crn] = info
    except Exception as e:
        print(f"[-] Error loading SIA ACS CSV: {e}")
    return sia_map



def _clean_sentence(value, limit=260):
    """Return a short, display-safe sentence without pretending it is new evidence."""
    text = re.sub(r"\s+", " ", str(value or "")).strip(" \t\r\n-*\"“”")
    if not text:
        return ""
    match = re.match(r"(.+?[.!?])(?:\s|$)", text)
    sentence = match.group(1) if match else text
    if len(sentence) > limit:
        sentence = sentence[:limit].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"
    return sentence


def _best_operational_sentence(value):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    useful_terms = [
        "provid", "operat", "deploy", "special", "guard", "patrol", "event",
        "keyholding", "protection", "venue", "contract", "training", "facilit"
    ]
    noise_terms = ["statutory", "incorporat", "companies house", "linked to its official website"]
    scored = []
    for index, sentence in enumerate(sentences[:6]):
        lowered = sentence.lower()
        score = sum(2 for term in useful_terms if term in lowered)
        score -= sum(2 for term in noise_terms if term in lowered)
        scored.append((score, -index, sentence))
    best = max(scored)[2] if scored else text
    return _clean_sentence(best)


def _has_confirmed_acs(primary_verdict, why_buy, rationale):
    """Detect affirmative ACS status while excluding 'lacks/without ACS' language."""
    verdict = str(primary_verdict or "").lower()
    if "acs accredited" in verdict or "acs approved" in verdict:
        return True
    text = " ".join([str(why_buy or ""), str(rationale or "")]).lower()
    positive = [
        r"\bholds?\s+(?:current\s+)?sia\s+acs\b",
        r"\bis\s+(?:an\s+)?(?:established\s+)?acs\s+(?:approved\s+)?contractor\b",
        r"\bas\s+an\s+(?:established\s+)?acs\s+contractor\b",
        r"\bwith\s+(?:current\s+)?sia\s+acs\s+(?:status|approval|accreditation)\b",
        r"\bevidenced\s+by\s+its\s+sia\s+acs\s+(?:status|accreditation)\b",
        r"\bsia\s+approved\s+contractor\s+status\b",
    ]
    for pattern in positive:
        for match in re.finditer(pattern, text):
            prefix = text[max(0, match.start() - 35):match.start()]
            if re.search(r"(?:do|does|did)\s+not\s+$|without\s+$|lacks?\s+$|not\s+$", prefix):
                continue
            return True
    return False


def label_phone_purpose(number_str, dm_name=None, dm_role=None, is_primary=False, company_name=""):
    """Determines the purpose label and type of a UK or international phone number."""
    raw = re.sub(r"[^\d+]", "", str(number_str or ""))
    norm = re.sub(r"\s+", " ", str(number_str or "")).strip()
    if not norm:
        return None

    # Check if tied to a specific named decision maker
    if dm_name and dm_name not in ["Director", "Managing Director", "Director Operations"]:
        role_label = f" · {dm_role}" if dm_role and dm_role != "Director" else ""
        if raw.startswith("07") or raw.startswith("+447") or raw.startswith("447"):
            return {
                "number": norm,
                "raw": raw,
                "purpose": f"Direct Mobile ({dm_name}{role_label})",
                "type": "mobile",
                "dm_name": dm_name
            }
        else:
            return {
                "number": norm,
                "raw": raw,
                "purpose": f"Direct Line ({dm_name}{role_label})",
                "type": "direct",
                "dm_name": dm_name
            }

    # Check phone prefix patterns
    if raw.startswith("07") or raw.startswith("+447") or raw.startswith("447"):
        label = f"Direct Mobile ({dm_name})" if dm_name and dm_name != "Director" else "Direct Mobile"
        return {"number": norm, "raw": raw, "purpose": label, "type": "mobile"}
    elif raw.startswith("+92") or raw.startswith("92") or raw.startswith("0300"):
        return {"number": norm, "raw": raw, "purpose": f"Mobile ({dm_name or 'Director'})", "type": "mobile"}
    elif raw.startswith("0800") or raw.startswith("0808") or raw.startswith("+44800"):
        return {"number": norm, "raw": raw, "purpose": "Toll-Free Support / Operations", "type": "tollfree"}
    elif raw.startswith("0333") or raw.startswith("0300") or raw.startswith("0345") or raw.startswith("+44333") or raw.startswith("+44300"):
        return {"number": norm, "raw": raw, "purpose": "Main Operations / Inquiries", "type": "corporate"}
    elif raw.startswith("0141") or raw.startswith("+44141"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Glasgow HQ)", "type": "landline"}
    elif raw.startswith("0131") or raw.startswith("+44131"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Edinburgh)", "type": "landline"}
    elif raw.startswith("0121") or raw.startswith("+44121"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Birmingham)", "type": "landline"}
    elif raw.startswith("01224") or raw.startswith("+441224"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Aberdeen)", "type": "landline"}
    elif raw.startswith("01463") or raw.startswith("+441463"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Inverness)", "type": "landline"}
    elif raw.startswith("01698") or raw.startswith("+441698"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Lanarkshire/Motherwell)", "type": "landline"}
    elif raw.startswith("01382") or raw.startswith("+441382"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Dundee)", "type": "landline"}
    elif raw.startswith("01786") or raw.startswith("+441786"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Stirling)", "type": "landline"}
    elif raw.startswith("01324") or raw.startswith("+441324"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (Falkirk HQ)", "type": "landline"}
    elif raw.startswith("020") or raw.startswith("+4420"):
        return {"number": norm, "raw": raw, "purpose": "Main Office (London)", "type": "landline"}
    elif is_primary:
        return {"number": norm, "raw": raw, "purpose": "Main Switchboard / Office", "type": "landline"}
    else:
        return {"number": norm, "raw": raw, "purpose": "Office Contact", "type": "landline"}


def extract_all_labeled_phones(primary_phone, decision_makers, dossier_phone=None):
    """Aggregates all unique phone numbers across company contacts, decision makers, and dossiers."""
    seen_raw = set()
    phone_list = []

    def _normalize_raw(num):
        if not num:
            return ""
        s = re.sub(r"[^\d+]", "", str(num))
        # normalize 447... vs 07...
        if s.startswith("+44"):
            s = "0" + s[3:]
        elif s.startswith("44") and len(s) >= 11:
            s = "0" + s[2:]
        return s

    # 1. Primary Phone
    if primary_phone:
        raw_key = _normalize_raw(primary_phone)
        if raw_key and raw_key not in seen_raw:
            seen_raw.add(raw_key)
            dm0 = decision_makers[0] if decision_makers else None
            dm_name = dm0.get("name") if dm0 and dm0.get("phone") and _normalize_raw(dm0.get("phone")) == raw_key else None
            dm_role = dm0.get("role") if dm_name else None
            labeled = label_phone_purpose(primary_phone, dm_name=dm_name, dm_role=dm_role, is_primary=True)
            if labeled:
                phone_list.append(labeled)

    # 2. Decision Makers Phones
    for dm in (decision_makers or []):
        p = dm.get("phone")
        if not p:
            continue
        raw_key = _normalize_raw(p)
        if raw_key and raw_key not in seen_raw:
            seen_raw.add(raw_key)
            labeled = label_phone_purpose(p, dm_name=dm.get("name"), dm_role=dm.get("role"), is_primary=False)
            if labeled:
                phone_list.append(labeled)

    # 3. Dossier Phone
    if dossier_phone:
        raw_key = _normalize_raw(dossier_phone)
        if raw_key and raw_key not in seen_raw:
            seen_raw.add(raw_key)
            labeled = label_phone_purpose(dossier_phone, is_primary=len(phone_list) == 0)
            if labeled:
                phone_list.append(labeled)

    return phone_list


def extract_all_social_profiles(contacts_social, decision_makers):
    """Extracts and normalizes social profiles from company contacts and decision makers."""
    soc = {}
    if isinstance(contacts_social, dict):
        for k, v in contacts_social.items():
            if v and str(v).strip() and str(v).lower() not in ["null", "none", "n/a"]:
                soc[k] = str(v).strip()

    # Decision makers personal linkedin
    personal_linkedin = []
    for dm in (decision_makers or []):
        if isinstance(dm, dict) and dm.get("linkedin_url"):
            l_url = str(dm.get("linkedin_url")).strip()
            if l_url and l_url.lower() not in ["null", "none", "n/a"]:
                personal_linkedin.append({
                    "name": dm.get("name") or "Director",
                    "role": dm.get("role") or "Director",
                    "url": l_url
                })
    if personal_linkedin:
        soc["linkedin_directors"] = personal_linkedin

    return soc



def build_call_profile(company_name, prospect_status, primary_verdict, why_buy,
                       rationale, target_package, report_text, has_dossier,
                       is_sia_acs_approved=False, sia_acs_activities=""):
    """Build the call-safe context consumed by the response-aware UI.

    Registry rows and disqualified cases deliberately do not receive a sales pitch.
    A tailored profile must be grounded in a completed dossier.
    """
    # Classification uses the final verdict and summaries, not arbitrary words
    # deep in a long dossier (which may discuss unrelated comparison services).
    searchable = " ".join([
        str(primary_verdict or ""), str(why_buy or ""), str(rationale or ""),
        str(target_package or "")
    ]).lower()

    fatal_summary = " ".join([str(why_buy or ""), str(rationale or "")]).lower()
    fatal_outreach_terms = [
        "commercially disqualified", "disqualified due to", "formal entry into insolvency",
        "liquidation (cvl)", "catastrophic financial and reputational risk",
        "non-operational, non-trading", "zero capacity, infrastructure, personnel"
    ]

    if prospect_status == "DISQUALIFIED" or any(term in fatal_summary for term in fatal_outreach_terms):
        return {
            "readiness": "do_not_call",
            "reason": _clean_sentence(rationale or why_buy) or "This case was disqualified by the investigation.",
            "sector": "unqualified",
            "primary_offer": "No sales offer",
            "labour_supply_relevant": False,
            "acs_status": "unknown",
        }
    if not has_dossier:
        return {
            "readiness": "research_required",
            "reason": "Only a registry record is available; operational activity and service fit have not been verified.",
            "sector": "unverified security registration",
            "primary_offer": "Research before calling",
            "labour_supply_relevant": False,
            "acs_status": "unknown",
        }

    sector = "manned guarding"
    sector_phrase = "manned guarding operations"
    opportunity = "direct commercial guarding work"
    discovery_question = "Which contracts are you trying to win next, and what currently blocks supplier approval?"
    if "outside broadcast" in searchable or re.search(r"\bob\s+security\b", searchable):
        sector = "outside broadcast and live-event security"
        sector_phrase = "specialist outside-broadcast and live-event security work"
        opportunity = "direct work with production companies, broadcasters, and live-event principals"
        discovery_question = "When larger OB or live-event contracts come up, is the bigger friction client pre-qualification, staff vetting, or audit paperwork?"
    elif any(term in searchable for term in ["event security", "stewarding", "festival", "venue security"]):
        sector = "event security and stewarding"
        sector_phrase = "event-security and crowd-management deployments"
        opportunity = "larger venue, festival, and event-principal contracts"
        discovery_question = "For the next larger event contract, is the main barrier buyer pre-qualification, evidencing staff vetting, or controlling subcontracted crews?"
    elif any(term in searchable for term in ["mobile patrol", "keyholding", "alarm response"]):
        sector = "mobile patrols and keyholding"
        sector_phrase = "mobile-patrol, response, and keyholding operations"
        opportunity = "multi-site retail, industrial, and property-management patrol contracts"
        discovery_question = "When you pursue larger patrol or keyholding routes, is the sticking point buyer approval, BS 7984 procedures, or staff vetting evidence?"
    elif any(term in searchable for term in ["close protection", "executive protection", "secure transport", "chauffeur"]):
        sector = "close protection and secure transport"
        sector_phrase = "close-protection and secure-transport work"
        opportunity = "direct corporate, executive, and institutional protection contracts"
        discovery_question = "For larger direct protection contracts, is the current barrier procurement credentials, documented operating controls, or screening evidence?"
    elif any(term in searchable for term in ["door supervision", "door supervisor", "nightlife", "leisure venue"]):
        sector = "door supervision and venue security"
        sector_phrase = "door-supervision and venue-security deployments"
        opportunity = "direct venue-group work and approved supply relationships"
        discovery_question = "Are you aiming to win venue contracts directly, supply teams to larger operators, or both?"
    elif any(term in searchable for term in ["corporate guarding", "concierge", "business park", "property guarding"]):
        sector = "corporate and property guarding"
        sector_phrase = "corporate front-of-house and property-guarding work"
        opportunity = "multi-site property, managing-agent, and institutional tenant contracts"
        discovery_question = "Which buyer requirement causes more friction today: pre-qualification, policy evidence, or maintaining consistent vetting files across sites?"
    elif any(term in searchable for term in ["canine", " k9", "dog handling", "dog patrol"]):
        sector = "canine and specialist guarding"
        sector_phrase = "specialist canine and guarding deployments"
        opportunity = "direct infrastructure, construction, and high-risk site contracts"
        discovery_question = "For the next specialist site contract, is buyer pre-qualification or proving consistent handler and guard controls the bigger obstacle?"
    elif any(term in searchable for term in ["training academy", "security training", "training provider"]):
        sector = "security training and guarding"
        sector_phrase = "combined security-training and frontline guarding operations"
        opportunity = "direct guarding contracts that use the strength of the in-house training pipeline"
        discovery_question = "Are you trying to grow the guarding arm, the training-to-deployment pipeline, or both?"
    elif any(term in searchable for term in ["facilities management", "integrated services", "cleaning and guarding", " fm contracts"]):
        sector = "integrated facilities and guarding"
        sector_phrase = "integrated facilities and manned-guarding work"
        opportunity = "bundled facilities contracts where guarding must pass separate procurement checks"
        discovery_question = "When guarding is bundled into an FM bid, which requirement slows you down most: security pre-qualification, screening evidence, or the audit trail?"

    existing_acs = is_sia_acs_approved or _has_confirmed_acs(primary_verdict, why_buy, rationale)
    labour_evidence = any(term in " ".join([str(why_buy or ""), str(rationale or ""), str(target_package or "")]).lower()
                          for term in ["cop 119", "labour supply", "labour provision", "subcontractor", "subcontracted", "supply chain"])

    if existing_acs:
        acts_str = f" for {sia_acs_activities}" if sia_acs_activities else ""
        primary_offer = "BS 10119 labour-provision readiness, BS 7858 screening controls, and annual ACS maintenance"
        offer_reason = f"leverage existing SIA ACS status{acts_str} to unlock Tier-1 subcontracting and maintain annual audit compliance"
        discovery_question = "Are you preparing for an ACS re-assessment, and does labour provision under BS 10119 form part of your contracts?"
    elif labour_evidence and any(term in str(target_package or "").lower() for term in ["cop 119", "labour"]):
        primary_offer = "BS 10119 labour-provision controls and BS 7858 screening"
        offer_reason = "support approved labour-supply relationships with traceable screening and operating controls"
    else:
        primary_offer = "SIA ACS readiness and BS 7858 screening controls"
        offer_reason = "strengthen procurement credibility and make the assessment workload manageable"

    source_fact = _best_operational_sentence(why_buy) or _best_operational_sentence(rationale)
    if is_sia_acs_approved:
        source_fact = f"{company_name} is an SIA ACS Approved Contractor{(' (' + sia_acs_activities + ')') if sia_acs_activities else ''}."
    elif sector == "outside broadcast and live-event security":
        source_fact = f"{company_name} operates in specialist outside-broadcast and live-event security."

    if is_sia_acs_approved:
        hook = (
            f"I called {company_name} because you are an established SIA Approved Contractor in {sector_phrase}. "
            f"Our focus with accredited firms is BS 10119 labour-provision readiness where relevant and managing annual ACS re-assessment audits."
        )
    else:
        hook = (
            f"I called {company_name} specifically because of its {sector_phrase}. "
            f"The relevant opportunity is {opportunity}; the compliance conversation should therefore focus on "
            f"{primary_offer}, not a generic list of accreditations."
        )
    return {
        "readiness": "tailored",
        "reason": source_fact,
        "sector": sector,
        "sector_phrase": sector_phrase,
        "opportunity": opportunity,
        "primary_offer": primary_offer,
        "offer_reason": offer_reason,
        "discovery_question": discovery_question,
        "tailored_hook": hook,
        "labour_supply_relevant": bool(labour_evidence or existing_acs),
        "acs_status": "confirmed_existing" if existing_acs else "not_confirmed",
        "source_fact": source_fact,
    }

def extract_word_report_dossiers():
    """Extract all company detailed dossiers from generate_sia_acs_word_report.py"""
    report_script = os.getenv("ESC_WORD_REPORT_SCRIPT", os.path.join(ACS_DIR, "generate_sia_acs_word_report.py"))
    if not os.path.exists(report_script):
        return {}

    with open(report_script, "r", encoding="utf-8") as f:
        content = f.read()

    recorder_code = """
global_captured = {}
def add_company_dossier(doc, rank, name, crn, tier, score, verdict, address, website, phone, email, dms, why_buy, target_pkg, phone_pitch, email_pitch, evidence_points):
    global_captured[crn.strip().upper()] = {
        "rank": rank,
        "company_name": name,
        "crn": crn.strip().upper(),
        "tier": tier,
        "score": score,
        "verdict": verdict,
        "address": address,
        "website": website,
        "phone": phone,
        "email": email,
        "decision_makers": dms,
        "why_buy": why_buy,
        "target_package": target_pkg,
        "phone_pitch": phone_pitch,
        "email_pitch": email_pitch,
        "evidence_points": evidence_points
    }
"""

    pattern = r'def add_company_dossier\([^)]*\):[\s\S]*?(?=\n\ndef main|\ndef [a-zA-Z_])'
    modified_content = re.sub(pattern, recorder_code, content, count=1)
    modified_content = re.sub(r"doc\.save\([^)]*\)[\s\S]*", "pass", modified_content)

    sandbox = {
        "os": os,
        "sys": sys,
        "json": json,
        "re": re,
        "docx": None,
        "Document": lambda *a: type('Doc', (object,), {'save': lambda *a: None, 'sections': [], 'styles': {'Normal': type('Style', (object,), {'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()}, 'add_paragraph': lambda *a, **kw: type('P', (object,), {'paragraph_format': type('PF', (object,), {'space_before': 0, 'space_after': 0, 'line_spacing': 1, 'keep_with_next': False})(), 'add_run': lambda *a, **kw: type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})(), 'text': '', 'alignment': 0, 'runs': [type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()]})(), 'add_heading': lambda *a, **kw: type('H', (object,), {'paragraph_format': type('PF', (object,), {'space_before': 0, 'space_after': 0, 'line_spacing': 1, 'keep_with_next': False})(), 'runs': [type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()]})(), 'add_table': lambda *a, **kw: type('T', (object,), {'alignment': 0, 'autofit': False, 'columns': [type('C', (object,), {'width': 0})() for _ in range(20)], 'rows': [type('R', (object,), {'cells': [type('Cell', (object,), {'width': 0, 'paragraphs': [type('P', (object,), {'text': '', 'alignment': 0, 'runs': [type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()]})()]})() for _ in range(20)]})() for _ in range(50)], 'cell': lambda *a: type('Cell', (object,), {'width': 0, 'paragraphs': [type('P', (object,), {'text': '', 'alignment': 0, 'paragraph_format': type('PF', (object,), {'space_before': 0, 'space_after': 0, 'line_spacing': 1})(), 'runs': [type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()]})()], '_element': type('El', (object,), {'get_or_add_tcPr': lambda *a: type('TcPr', (object,), {'append': lambda *a: None})(), 'xpath': lambda *a: [type('X', (object,), {'append': lambda *a: None})()]})()})(), 'add_row': lambda *a: type('R', (object,), {'cells': [type('Cell', (object,), {'width': 0, 'paragraphs': [type('P', (object,), {'text': '', 'alignment': 0, 'paragraph_format': type('PF', (object,), {'space_before': 0, 'space_after': 0, 'line_spacing': 1})(), 'runs': [type('R', (object,), {'bold': False, 'font': type('F', (object,), {'name': '', 'size': None, 'color': type('C', (object,), {'rgb': None})()})()})()]})()]})() for _ in range(20)]})()})()})(),
        "Inches": lambda x: x,
        "Pt": lambda x: x,
        "RGBColor": lambda *a: None,
        "WD_ALIGN_PARAGRAPH": type('obj', (object,), {'CENTER': 1, 'LEFT': 0, 'RIGHT': 2}),
        "WD_TABLE_ALIGNMENT": type('obj', (object,), {'CENTER': 1, 'LEFT': 0, 'RIGHT': 2}),
        "WD_ALIGN_VERTICAL": type('obj', (object,), {'CENTER': 1, 'TOP': 0, 'BOTTOM': 2}),
        "parse_xml": lambda *a: None,
        "nsdecls": lambda *a: None,
        "qn": lambda *a: None,
        "OxmlElement": lambda *a: None
    }

    orig_open = open
    def custom_open(path, *args, **kwargs):
        if "prospects_v9_master.json" in str(path):
            p = os.getenv("ESC_V9_MASTER_JSON", os.path.join(ACS_DIR, "output/v9/prospects_v9_master.json"))
            if os.path.exists(p):
                return orig_open(p, *args, **kwargs)
        return orig_open(path, *args, **kwargs)
    sandbox["open"] = custom_open

    try:
        exec(modified_content, sandbox)
        if "main" in sandbox:
            sandbox["main"]()
    except Exception as e:
        pass

    captured = sandbox.get("global_captured", {})
    return captured

def get_latest_cases_mtime():
    """Returns the newest mtime and count of all case directories."""
    if not os.path.exists(CASES_DIR):
        return 0, 0
    folders = [os.path.join(CASES_DIR, d) for d in os.listdir(CASES_DIR) if os.path.isdir(os.path.join(CASES_DIR, d))]
    if not folders:
        return 0, 0
    max_mtime = max(os.path.getmtime(f) for f in folders)
    return max_mtime, len(folders)

def check_needs_recompile():
    """Checks if output/v9/cases has newer cases than metadata."""
    if not os.path.exists(METADATA_FILE) or not os.path.exists(OUTPUT_JSON):
        return True
    try:
        with open(METADATA_FILE, "r", encoding="utf-8") as f:
            meta = json.load(f)
        last_mtime, count = get_latest_cases_mtime()
        if count != meta.get("case_count", 0):
            return True
        if last_mtime > meta.get("last_cases_mtime", 0):
            return True
        return False
    except Exception:
        return True

def compile_database(quiet=False, write_files=True):
    """Compile intelligence in memory, optionally writing the local Call Desk files."""
    start_time = time.time()
    if not quiet:
        print("⚡ Compiling Cold Calling Intelligence Database...")

    sia_acs_registry = load_sia_acs_registry()
    if not quiet and sia_acs_registry:
        print(f"[*] Loaded {len(sia_acs_registry)//2 if sia_acs_registry else 0} official SIA ACS approved entities from CSV.")

    word_dossiers = extract_word_report_dossiers()
    if not quiet and word_dossiers:
        print(f"[*] Loaded {len(word_dossiers)} structured dossiers from Word report.")

    compiled_companies = {}
    deleted_company_ids = load_deleted_company_ids()
    case_folders = glob.glob(os.path.join(CASES_DIR, "*")) if os.path.exists(CASES_DIR) else []
    if not quiet:
        print(f"[*] Found {len(case_folders)} case folders in {CASES_DIR}")

    # Track newly investigated qualified cases to rank dynamically
    unranked_qualified = []

    for case_path in case_folders:
        crn = os.path.basename(case_path).strip().upper()
        decision_file = os.path.join(case_path, "decision.json")
        contacts_file = os.path.join(case_path, "contacts.json")
        report_file = os.path.join(case_path, "investigation_report.md")
        evidence_file = os.path.join(case_path, "evidence.jsonl")

        decision = {}
        contacts = {}
        report_text = ""
        evidence_list = []

        if os.path.exists(decision_file):
            try:
                with open(decision_file, "r", encoding="utf-8") as f:
                    decision = json.load(f)
            except Exception:
                pass

        if os.path.exists(contacts_file):
            try:
                with open(contacts_file, "r", encoding="utf-8") as f:
                    contacts = json.load(f)
            except Exception:
                pass

        if os.path.exists(report_file):
            try:
                with open(report_file, "r", encoding="utf-8") as f:
                    report_text = f.read()
            except Exception:
                pass

        if os.path.exists(evidence_file):
            try:
                with open(evidence_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            evidence_list.append(json.loads(line))
            except Exception:
                pass

        dossier = word_dossiers.get(crn, {})

        company_name = (
            dossier.get("company_name") or
            decision.get("company_name") or
            contacts.get("company_name") or
            f"Company {crn}"
        )

        # Cross-reference with Official SIA ACS Registry
        clean_crn = crn.strip().upper()
        norm_crn = clean_crn.zfill(8) if clean_crn.isdigit() and len(clean_crn) < 8 else clean_crn
        sia_info = sia_acs_registry.get(clean_crn) or sia_acs_registry.get(norm_crn)
        is_sia_acs_approved = bool(sia_info)
        sia_acs_activities = sia_info["activities"] if sia_info else ""
        sia_acs_directors = sia_info["directors"] if sia_info else ""
        sia_acs_name = sia_info["name"] if sia_info else ""

        prospect_status = decision.get("prospect_status") or ("QUALIFIED" if dossier else "DISQUALIFIED")
        deterministic_score = dossier.get("score") if dossier.get("score") is not None else decision.get("deterministic_score", 0)
        primary_verdict = dossier.get("verdict") or decision.get("primary_service_verdict") or "Security Services"

        comp_contacts = contacts.get("company_contacts", {})
        website = dossier.get("website") or comp_contacts.get("official_website")
        phone = dossier.get("phone") or comp_contacts.get("primary_phone")
        email = dossier.get("email") or comp_contacts.get("primary_email")
        operational_address = dossier.get("address") or comp_contacts.get("operational_address")
        registered_address = contacts.get("registered_address")

        dms = dossier.get("decision_makers") or contacts.get("decision_makers", [])
        if not dms and contacts.get("statutory_directors"):
            dms = []
            for sd in contacts.get("statutory_directors", []):
                sd_name = re.sub(r'\(.*?\)', '', sd).strip()
                parts = sd_name.split(",")
                if len(parts) == 2:
                    sd_name = f"{parts[1].strip()} {parts[0].strip().title()}"
                dms.append({
                    "name": sd_name,
                    "role": "Director",
                    "phone": phone,
                    "email": email,
                    "linkedin_url": None
                })

        phone_pitch = dossier.get("phone_pitch")
        email_pitch = dossier.get("email_pitch")
        why_buy = dossier.get("why_buy") or decision.get("rationale") or ""
        service_routes = list(decision.get("service_routes") or [])
        if is_sia_acs_approved and "ACS_NEW" in service_routes:
            service_routes = ["ACS_MAINTENANCE" if route == "ACS_NEW" else route for route in service_routes]
        target_package = dossier.get("target_package") or ("BS 10119 Labour Provision & ACS Re-assessment Support" if is_sia_acs_approved else "SIA ACS Readiness & Compliance Support")
        target_package = re.sub(r"\s*\(?£[\d,]+\)?", "", str(target_package)).strip()
        evidence_points = dossier.get("evidence_points") or decision.get("red_flags", [])

        if not phone_pitch:
            dm_name = dms[0].get("name") if dms and dms[0].get("name") else "[Name]"
            if is_sia_acs_approved:
                phone_pitch = f"“Hi {dm_name}, I see {company_name} is already an SIA Approved Contractor. We support ACS re-assessment and BS 10119 labour-provision controls where those are relevant to your contracts. Can I ask which compliance work is currently taking the most management time?”"
            elif prospect_status == "QUALIFIED":
                phone_pitch = f"“Hi {dm_name}, I see {company_name} is active in {primary_verdict}. We help security providers prepare for SIA ACS approval and the supporting operational controls. Is ACS something you are working toward, or have you already ruled it out?”"
            else:
                phone_pitch = f"“Hi {dm_name}, Jalees here from ESC. We support security providers with SIA ACS and, where labour provision is part of the model, BS 10119. I wanted to check what services {company_name} actually delivers before assuming either is relevant.”"

        if not email_pitch:
            dm_name = dms[0].get("name") if dms and dms[0].get("name") else "[Name]"
            if is_sia_acs_approved:
                email_pitch = f"Subject: ACS Maintenance and BS 10119 Support for {company_name}\nOpening: Hi {dm_name}, We support approved contractors with ACS re-assessment and, where labour provision is in scope, BS 10119 readiness."
            else:
                email_pitch = f"Subject: SIA ACS Readiness for {company_name}\nOpening: Hi {dm_name}, We help UK security firms assess and implement the controls needed for SIA ACS approval."

        rank = dossier.get("rank")
        tier = dossier.get("tier")

        if not tier:
            if is_sia_acs_approved:
                tier = "SIA ACS Approved Contractor"
            elif prospect_status == "QUALIFIED":
                tier = "Qualified Prospect"
            elif prospect_status == "DISQUALIFIED":
                tier = "Disqualified Case"
            else:
                tier = "Audited Case"

        phone_numbers = extract_all_labeled_phones(phone, dms, dossier.get("phone"))
        social_profiles = extract_all_social_profiles(contacts.get("social_profiles", {}), dms)

        company_entry = {
            "crn": crn,
            "company_name": company_name,
            "prospect_status": prospect_status,
            "decision_basis": decision.get("decision_basis", "LEGACY_RESULT"),
            "review_owner": decision.get("review_owner", "HUMAN" if prospect_status == "NEEDS_REVIEW" else "NONE"),
            "activity_classifications": decision.get("activity_classifications", ["UNKNOWN"]),
            "service_routes": service_routes,
            "service_route": decision.get("service_route") or (service_routes[0] if service_routes else "NONE"),
            "reachability": decision.get("reachability", {
                "has_phone": bool(phone), "has_email": bool(email),
                "has_social": bool(social_profiles), "has_website": bool(website),
                "contactable": bool(phone or email or website or social_profiles)
            }),
            "website_opportunity": decision.get("website_opportunity", bool(not website and (phone or email or social_profiles))),
            "evidence_search_exhausted": decision.get("evidence_search_exhausted", False),
            "is_sia_acs_approved": is_sia_acs_approved,
            "sia_acs_activities": sia_acs_activities,
            "sia_acs_directors": sia_acs_directors,
            "sia_acs_registered_name": sia_acs_name,
            "rank": rank,
            "tier": tier,
            "deterministic_score": deterministic_score,
            "primary_service_verdict": primary_verdict,
            "is_physical_guarding": decision.get("is_physical_guarding", True),
            "confidence_score": decision.get("confidence_score", 0.95),
            "score_breakdown": decision.get("score_breakdown", {}),
            "red_flags": decision.get("red_flags", []),
            "rationale": decision.get("rationale", ""),
            "website": website,
            "phone": phone,
            "phone_numbers": phone_numbers,
            "email": email,
            "operational_address": operational_address,
            "registered_address": registered_address,
            "social_profiles": social_profiles,
            "decision_makers": dms,
            "statutory_directors": contacts.get("statutory_directors", []),
            "why_buy": why_buy,
            "target_package": target_package,
            "phone_pitch": phone_pitch,
            "email_pitch": email_pitch,
            "evidence_points": evidence_points,
            "has_full_dossier": bool(report_text),
            "investigation_report_preview": report_text[:2500] if report_text else "",
            "investigation_report_full": report_text if report_text else ""
        }

        compiled_companies[crn] = company_entry
        if prospect_status == "QUALIFIED" and rank is None:
            unranked_qualified.append(crn)

    # 2. Add word dossiers not in cases_dir (if any)
    for crn, dossier in word_dossiers.items():
        if crn not in compiled_companies:
            d_clean = crn.strip().upper()
            d_norm = d_clean.zfill(8) if d_clean.isdigit() and len(d_clean) < 8 else d_clean
            d_sia = sia_acs_registry.get(d_clean) or sia_acs_registry.get(d_norm)
            d_is_sia = bool(d_sia)
            d_acts = d_sia["activities"] if d_sia else ""
            d_dirs = d_sia["directors"] if d_sia else ""
            d_name = d_sia["name"] if d_sia else ""

            d_dms = dossier.get("decision_makers", [])
            d_phones = extract_all_labeled_phones(dossier.get("phone"), d_dms)
            d_socials = extract_all_social_profiles({}, d_dms)
            compiled_companies[crn] = {
                "crn": crn,
                "company_name": dossier["company_name"],
                "prospect_status": "QUALIFIED",
                "is_sia_acs_approved": d_is_sia,
                "sia_acs_activities": d_acts,
                "sia_acs_directors": d_dirs,
                "sia_acs_registered_name": d_name,
                "rank": dossier["rank"],
                "tier": dossier["tier"],
                "deterministic_score": dossier["score"],
                "primary_service_verdict": dossier["verdict"],
                "is_physical_guarding": True,
                "confidence_score": 0.98,
                "score_breakdown": {},
                "red_flags": [],
                "rationale": dossier["why_buy"],
                "website": dossier["website"],
                "phone": dossier["phone"],
                "phone_numbers": d_phones,
                "email": dossier["email"],
                "operational_address": dossier["address"],
                "registered_address": dossier["address"],
                "social_profiles": d_socials,
                "decision_makers": dossier["decision_makers"],
                "statutory_directors": [dm["name"] for dm in dossier["decision_makers"] if dm.get("name")],
                "why_buy": dossier["why_buy"],
                "target_package": dossier["target_package"],
                "phone_pitch": dossier["phone_pitch"],
                "email_pitch": dossier["email_pitch"],
                "evidence_points": dossier["evidence_points"],
                "has_full_dossier": True,
                "investigation_report_preview": dossier["why_buy"],
                "investigation_report_full": f"# {dossier['company_name']}\n\n## Commercial Justification\n{dossier['why_buy']}\n\n## Evidence\n" + "\n".join([f"- {ep}" for ep in dossier["evidence_points"]])
            }

    # 3. Dynamic ranking for newly added qualified cases
    existing_ranks = [c["rank"] for c in compiled_companies.values() if c.get("rank") is not None]
    max_rank = max(existing_ranks) if existing_ranks else 0
    unranked_qualified.sort(key=lambda c: compiled_companies[c].get("deterministic_score", 0), reverse=True)

    for i, c_crn in enumerate(unranked_qualified, start=max_rank + 1):
        c = compiled_companies[c_crn]
        c["rank"] = i
        if i <= 14:
            c["tier"] = "Tier 1 · Immediate Priority"
        elif i <= 23:
            c["tier"] = "Tier 2 · High Probability"
        elif i <= 32:
            c["tier"] = "Tier 3 · Strategic Growth"
        else:
            c["tier"] = f"Tier 4 · Qualified Lead (#{i})"

    # 4. Add registry entries for broad search
    registry_file = os.getenv("ESC_V9_REGISTRY_FILE", os.path.join(ACS_DIR, "prospect_sources/master_registry/master_all_companies.json"))
    registry_count = 0
    if os.path.exists(registry_file):
        try:
            with open(registry_file, "r", encoding="utf-8") as f:
                registry_data = json.load(f)
                for item in registry_data:
                    reg_crn = item.get("company_number", "").strip().upper()
                    if not reg_crn:
                        continue
                    registry_count += 1
                    if reg_crn not in compiled_companies:
                        reg_name = item.get("title", "").strip().title() or item.get("company_name", "").strip().title()
                        reg_address = item.get("address_snippet") or item.get("registered_address") or ""
                        reg_inc = item.get("date_of_creation", "")

                        reg_sia = sia_acs_registry.get(reg_crn) or sia_acs_registry.get(reg_crn.zfill(8) if reg_crn.isdigit() else reg_crn)
                        compiled_companies[reg_crn] = {
                            "crn": reg_crn,
                            "company_name": reg_name,
                            "prospect_status": "REGISTRY_PROSPECT",
                            "rank": None,
                            "tier": "Registry Database (SIC 80100)",
                            "deterministic_score": 10,
                            "primary_service_verdict": "Unknown — research required",
                            "is_physical_guarding": None,
                            "confidence_score": 0.0,
                            "decision_basis": "EVIDENCE_INCOMPLETE",
                            "review_owner": "RESEARCH_RETRY",
                            "activity_classifications": ["UNKNOWN"],
                            "service_routes": [],
                            "service_route": "NONE",
                            "reachability": {"has_phone": False, "has_email": False, "has_social": False, "has_website": False, "contactable": False, "channels": []},
                            "website_opportunity": False,
                            "evidence_search_exhausted": False,
                            "is_sia_acs_approved": bool(reg_sia),
                            "sia_acs_registered_name": reg_sia.get("name", "") if reg_sia else "",
                            "sia_acs_activities": reg_sia.get("activities", "") if reg_sia else "",
                            "score_breakdown": {"active_companies_house": 10},
                            "red_flags": [],
                            "rationale": f"Statutory security provider registered under SIC 80100 (Incorporated: {reg_inc}).",
                            "website": None,
                            "phone": None,
                            "email": None,
                            "operational_address": reg_address,
                            "registered_address": reg_address,
                            "social_profiles": {},
                            "decision_makers": [
                                {"name": "Director", "role": "Director", "phone": None, "email": None, "linkedin_url": None}
                            ],
                            "statutory_directors": ["Director"],
                            "why_buy": "No commercial fit has been established. This statutory record must be researched before outreach.",
                            "target_package": "Research required before selecting an offer",
                            "phone_pitch": "",
                            "email_pitch": "",
                            "evidence_points": [
                                f"Active UK Companies House registration: {reg_crn}",
                                f"Incorporation date: {reg_inc}",
                                f"Registered address: {reg_address}"
                            ],
                            "has_full_dossier": False,
                            "investigation_report_preview": f"Statutory company record for {reg_name} (CRN: {reg_crn}).",
                            "investigation_report_full": f"# Statutory Report: {reg_name}\n\n**CRN:** {reg_crn}\n**Registered Address:** {reg_address}\n**Incorporation:** {reg_inc}\n**SIC:** 80100 (Private security activities)"
                        }
        except Exception as e:
            if not quiet:
                print(f"[-] Note loading master registry: {e}")

    # 4b. Explicit Pipeline Updates and Custom Prospect Additions
    PIPELINE_COMPANY_UPDATES = {
        "SC845085": {
            "company_name": "SPOTLIGHT EVENT SECURITY LTD",
            "phone": "07526955896",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://spotlighteventsecurity.co.uk",
            "website_status": "none"
        },
        "SC831144": {
            "company_name": "ADAMANTINE GLOBAL GROUP LTD",
            "phone": "0131 261 5250",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://adamantineglobal.com/",
            "website_status": "good"
        },
        "SC733369": {
            "company_name": "TAILORED SECURITY SERVICES LIMITED",
            "phone": "01224 516101",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://tailoredsecurityservicesltd.com/",
            "website_status": "good"
        },
        "SC809604": {
            "company_name": "SCOTGUARD LTD",
            "phone": "0800 246 5323",
            "last_outcome": "No Answer",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "No answer on ring.",
            "website": "https://scotguard.org/",
            "website_status": "poor"
        },
        "SC743197": {
            "company_name": "HIGHLAND SECURITY LTD",
            "phone": "07710873598",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://highland-training.co.uk/security/",
            "website_status": "good"
        },
        "SC708087": {
            "company_name": "TFG EVENTS LTD",
            "phone": "0141 221 4455",
            "last_outcome": "Wrong Number",
            "pipeline_list": "off_our_list",
            "contact_attempts": 1,
            "call_notes": "Wrong number / unreachable line.",
            "website": "https://tfgevents.co.uk",
            "website_status": "poor"
        },
        "SC705442": {
            "company_name": "THREE GS GROUP LTD",
            "phone": "01463 579076",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://threegsgroup.com/",
            "website_status": "good"
        },
        "SC468741": {
            "company_name": "1ST CORPORATE SECURITY LTD",
            "phone": "0141 338 040",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://www.1stcorporatesecurity.com/",
            "website_status": "good"
        },
        "SC278820": {
            "company_name": "HFD SECURITY LIMITED",
            "phone": "01698 503 600",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://www.hfdgroup.com/",
            "website_status": "good"
        },
        "SC673426": {
            "company_name": "POLSEC GROUP LTD.",
            "phone": "0800 246 5324",
            "last_outcome": "No Answer",
            "pipeline_list": "sia_approved_entries",
            "contact_attempts": 1,
            "call_notes": "No answer on ring. Verified SIA ACS Approved for Key Holding.",
            "website": "https://polsec.group/",
            "website_status": "good"
        },
        "SC811745": {
            "company_name": "OPULENCE SECURITY & SERVICES LTD",
            "phone": "+44 7952 111 404",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://www.opulence-security.com/",
            "website_status": "good"
        },
        "SC895247": {
            "company_name": "CCO SECURITY SERVICES UK LTD",
            "phone": "0141 459 1292",
            "last_outcome": "Busy",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Busy — requested callback later.",
            "website": "https://ccosecurityservices.co.uk/",
            "website_status": "good"
        },
        "SC873583": {
            "company_name": "ROBERTS O.B. SECURITY LTD",
            "phone": "07710 912098",
            "last_outcome": "Follow-up Scheduled",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — will call back tomorrow.",
            "website": "https://www.r-ob-security.uk/",
            "website_status": "good"
        },
        "SC864731": {
            "company_name": "ISLAND SECURE LTD",
            "phone": "07718 787944",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://www.islandsecure.co.uk/",
            "website_status": "good"
        },
        "SC886906": {
            "company_name": "C.J.L SECURITY LTD",
            "phone": "+44 7544 497352",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": None,
            "website_status": ""
        },
        "SC681358": {
            "company_name": "ALPHA - ONE PLUS LTD",
            "phone": "+44 74 2526 7909",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://alphaoneplus.com/",
            "website_status": "good"
        },
        "SC465794": {
            "company_name": "EVAGREEN PROFESSIONAL SERVICES LIMITED",
            "phone": "01224 310888",
            "last_outcome": "Voicemail",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "Voicemail left.",
            "website": "https://evagreenproservices.co.uk/",
            "website_status": "good"
        },
        "CUSTOM-MOUNTAINGUARD": {
            "crn": "CUSTOM-MOUNTAINGUARD",
            "company_name": "Mountain Security Service",
            "phone": "+92 300 1922333",
            "last_outcome": "WhatsApp Info Sent",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "WhatsApp the info requested and sent to +92 300 1922333.",
            "website": "https://mountainguard.xyz/?utm_source=chatgpt.com",
            "website_status": "good",
            "prospect_status": "QUALIFIED",
            "rank": 38,
            "tier": "Tier 4 · Qualified Lead (#38)",
            "deterministic_score": 90,
            "primary_service_verdict": "Manned Guarding & Security Operations",
            "is_physical_guarding": True,
            "confidence_score": 0.95,
            "score_breakdown": {"operational_evidence": 50, "verified_contacts": 40},
            "red_flags": [],
            "rationale": "Active security provider with verified mobile phone and active domain.",
            "operational_address": "Pakistan / Global Operations",
            "registered_address": "Pakistan / Global Operations",
            "social_profiles": {},
            "decision_makers": [
                {"name": "Managing Director", "role": "Managing Director", "phone": "+92 300 1922333", "email": None, "linkedin_url": None}
            ],
            "statutory_directors": ["Managing Director"],
            "why_buy": "Mountain Security Service operates manned guarding. Reached and requested proposal roadmap over WhatsApp.",
            "target_package": "SIA ACS & BS 10119 Compliance Support",
            "phone_pitch": "“Hi Managing Director, we help growing security providers prepare for SIA ACS and, where relevant, BS 10119 labour-provision requirements. Can I share a roadmap via WhatsApp?”",
            "email_pitch": "Subject: Security Compliance & Accreditation Roadmap\n\nHi Managing Director, We assist international and regional security firms in setting up standard operating procedures and compliance frameworks.",
            "evidence_points": [
                "Active commercial website: mountainguard.xyz",
                "Verified WhatsApp contact: +92 300 1922333",
                "Frontline manned guarding and protection services."
            ],
            "has_full_dossier": True,
            "investigation_report_preview": "Verified active security operations with direct WhatsApp contact.",
            "investigation_report_full": "# Mountain Security Service\n\n## Commercial Profile\nVerified active security operations. Contact requested information via WhatsApp (+92 300 1922333)."
        },
        "CUSTOM-ONESECURITY": {
            "crn": "CUSTOM-ONESECURITY",
            "company_name": "One Security Limited",
            "phone": "+92 300 3453469",
            "last_outcome": "WhatsApp Info Sent",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "WhatsApp the info requested and sent to +92 300 3453469.",
            "website": "https://oss.com.pk/",
            "website_status": "good",
            "prospect_status": "QUALIFIED",
            "rank": 39,
            "tier": "Tier 4 · Qualified Lead (#39)",
            "deterministic_score": 90,
            "primary_service_verdict": "Manned Guarding & Protection Services",
            "is_physical_guarding": True,
            "confidence_score": 0.95,
            "score_breakdown": {"operational_evidence": 50, "verified_contacts": 40},
            "red_flags": [],
            "rationale": "Active security guarding firm with established website oss.com.pk and verified mobile contact.",
            "operational_address": "Pakistan / Global Operations",
            "registered_address": "Pakistan / Global Operations",
            "social_profiles": {},
            "decision_makers": [
                {"name": "Director Operations", "role": "Director Operations", "phone": "+92 300 3453469", "email": None, "linkedin_url": None}
            ],
            "statutory_directors": ["Director Operations"],
            "why_buy": "One Security Limited provides frontline guarding. Reached and requested compliance roadmap over WhatsApp.",
            "target_package": "SIA ACS & BS 10119 Compliance Support",
            "phone_pitch": "“Hi Director, we help growing security providers prepare for SIA ACS and, where relevant, BS 10119 labour-provision requirements. Can I share a roadmap via WhatsApp?”",
            "email_pitch": "Subject: Security Compliance & Standard Operating Procedures\n\nHi Director, We assist growing security firms with standard operating procedures and compliance accreditations.",
            "evidence_points": [
                "Active commercial website: oss.com.pk",
                "Verified WhatsApp contact: +92 300 3453469",
                "Frontline manned guarding and corporate protection services."
            ],
            "has_full_dossier": True,
            "investigation_report_preview": "Verified active security operations with direct WhatsApp contact.",
            "investigation_report_full": "# One Security Limited\n\n## Commercial Profile\nVerified active security operations. Contact requested information via WhatsApp (+92 300 3453469)."
        },
        "SC529301": {
            "company_name": "GENT SECURITY LTD",
            "phone": "01786 841222",
            "last_outcome": "No Answer",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "No answer on ring.",
            "website": None,
            "website_status": ""
        },
        "SC577107": {
            "company_name": "SECURITY CHAUFFEURS LIMITED",
            "phone": "0131 333 4400",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": None,
            "website_status": ""
        },
        "SC691033": {
            "company_name": "JUST PROFESSIONAL SOLUTIONS LTD",
            "phone": "07563 895346",
            "last_outcome": "No Answer",
            "pipeline_list": "contacted",
            "contact_attempts": 1,
            "call_notes": "No answer on ring.",
            "website": None,
            "website_status": ""
        },
        "SC750835": {
            "company_name": "GUARD DIRECT LTD",
            "phone": "07824 453326",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://guarddirectltd.co.uk/",
            "website_status": "good"
        },
        "SC873799": {
            "company_name": "CIRCUMSPECT SECURITY SERVICES LTD",
            "phone": "07492 189521",
            "last_outcome": "Not Interested",
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "call_notes": "Spoke to decision maker — not interested.",
            "website": "https://www.circumspect-securityservices.co.uk/",
            "website_status": "good"
        }
    }

    # Insert any custom prospects if not already present
    for custom_crn in ["CUSTOM-MOUNTAINGUARD", "CUSTOM-ONESECURITY"]:
        if custom_crn not in compiled_companies and custom_crn in PIPELINE_COMPANY_UPDATES:
            compiled_companies[custom_crn] = PIPELINE_COMPANY_UPDATES[custom_crn]

    persisted_pipeline = load_persisted_pipeline_state()

    # 5. Attach evidence-grounded call profiles and default pipeline fields
    for crn, company in compiled_companies.items():
        is_sia = company.get("is_sia_acs_approved", False)
        sia_acts = company.get("sia_acs_activities", "")
        company["source_phone_pitch"] = company.get("phone_pitch")
        profile = build_call_profile(
            company_name=company.get("company_name"),
            prospect_status=company.get("prospect_status"),
            primary_verdict=company.get("primary_service_verdict"),
            why_buy=company.get("why_buy"),
            rationale=company.get("rationale"),
            target_package=company.get("target_package"),
            report_text=company.get("investigation_report_full"),
            has_dossier=bool(company.get("has_full_dossier")),
            is_sia_acs_approved=is_sia,
            sia_acs_activities=sia_acts
        )
        company["call_profile"] = profile

        # Pipeline assignment:
        # Priority 1: Persisted user state from disk (preserves custom target assignments, notes, calls)
        # Priority 2: Hardcoded historical updates
        # Priority 3: Default algorithmic baseline
        if crn in persisted_pipeline:
            saved = persisted_pipeline[crn]
            company["pipeline_list"] = saved.get("pipeline_list", "all_qualified")
            company["contact_attempts"] = saved.get("contact_attempts", 0)
            company["call_notes"] = saved.get("call_notes", "")
            company["last_outcome"] = saved.get("last_outcome", None)
            if saved.get("last_phone_used"):
                company["last_phone_used"] = saved["last_phone_used"]
            if saved.get("last_dm_reached"):
                company["last_dm_reached"] = saved["last_dm_reached"]
            if saved.get("last_caller"):
                company["last_caller"] = saved["last_caller"]
            if saved.get("last_updated"):
                company["last_updated"] = saved["last_updated"]
        elif crn in PIPELINE_COMPANY_UPDATES:
            up = PIPELINE_COMPANY_UPDATES[crn]
            for k, v in up.items():
                if v is not None or k not in company:
                    company[k] = v
        else:
            if profile["readiness"] == "do_not_call" or company.get("prospect_status") == "DISQUALIFIED":
                company["pipeline_list"] = "off_our_list"
            elif is_sia:
                # Company already holds SIA ACS accreditation -> move to dedicated SIA Approved Entries list
                company["pipeline_list"] = "sia_approved_entries"
            elif company.get("rank") is not None and company.get("rank") <= 25 and profile["readiness"] == "tailored":
                company["pipeline_list"] = "todays_targets"
            elif profile["readiness"] == "tailored" or company.get("prospect_status") == "QUALIFIED":
                company["pipeline_list"] = "all_qualified"
            else:
                company["pipeline_list"] = "master_list"
            company["contact_attempts"] = 0
            company["call_notes"] = ""
            company["last_outcome"] = None

        # Ensure phone_numbers and social_profiles are always populated
        if not company.get("phone_numbers"):
            company["phone_numbers"] = extract_all_labeled_phones(
                company.get("phone"),
                company.get("decision_makers", [])
            )
        if not company.get("social_profiles"):
            company["social_profiles"] = extract_all_social_profiles(
                company.get("social_profiles", {}),
                company.get("decision_makers", [])
            )

        decision_makers = company.get("decision_makers") or []
        dm_name = decision_makers[0].get("name") if decision_makers else "Director"
        if profile["readiness"] == "tailored":
            company["phone_pitch"] = (
                f"“Hi {dm_name}, {profile['tailored_hook']} "
                f"{profile['discovery_question']}”"
            )
            company["email_pitch"] = (
                f"Subject: {profile['sector'].title()} compliance priorities for {company.get('company_name')}\n\n"
                f"Hi {dm_name},\n\n"
                f"I am getting in touch specifically because {profile['source_fact']} "
                f"For that operating model, the relevant area is {profile['primary_offer']}: "
                f"{profile['offer_reason']}.\n\n"
                f"One question before I send anything generic: {profile['discovery_question']}"
            )
        elif profile["readiness"] == "do_not_call":
            company["phone_pitch"] = "DO NOT CALL — this company was disqualified by the investigation."
            company["email_pitch"] = "DO NOT CONTACT — review the disqualification evidence first."
        else:
            company["phone_pitch"] = "RESEARCH REQUIRED — no tailored script is available from registry data alone."
            company["email_pitch"] = "RESEARCH REQUIRED — verify the company before creating outreach."

    # A server-managed tombstone prevents a deleted company from returning the
    # next time the upstream intelligence sources are compiled.
    for deleted_crn in deleted_company_ids:
        compiled_companies.pop(deleted_crn, None)

    if write_files:
        # Output JSON file
        with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
            json.dump(compiled_companies, f, indent=2)

        # Output JS file
        with open(OUTPUT_JS, "w", encoding="utf-8") as f:
            f.write("// Auto-generated by compile_prospect_database.py\n")
            f.write("window.COMPANIES_INTELLIGENCE = ")
            json.dump(compiled_companies, f)
            f.write(";\n")

    # Initialize pipeline state only during an explicit local database rebuild.
    # Portable research exports must not change Call Desk state.
    if write_files and not os.path.exists(PIPELINE_STATE_FILE):
        try:
            initial_state = {}
            for c_crn, comp_data in compiled_companies.items():
                initial_state[c_crn] = {
                    "pipeline_list": comp_data.get("pipeline_list", "master_list"),
                    "contact_attempts": comp_data.get("contact_attempts", 0),
                    "call_notes": comp_data.get("call_notes", ""),
                    "last_outcome": comp_data.get("last_outcome", None),
                    "last_phone_used": comp_data.get("last_phone_used", None),
                    "last_dm_reached": comp_data.get("last_dm_reached", None),
                    "last_caller": comp_data.get("last_caller", "Aroosa"),
                    "last_updated": int(time.time() * 1000)
                }
            with open(PIPELINE_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(initial_state, f, indent=2)
            if not quiet:
                print(f"[✓] Initialized persisted state: {PIPELINE_STATE_FILE}")
        except Exception as e:
            print(f"[-] Warning initializing pipeline_state.json: {e}")

    latest_mtime, folder_count = get_latest_cases_mtime()
    qualified_count = len([c for c in compiled_companies.values() if c.get("prospect_status") == "QUALIFIED"])

    metadata = {
        "status": "synced",
        "last_updated": time.time(),
        "last_updated_str": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "last_cases_mtime": latest_mtime,
        "case_count": len(case_folders),
        "qualified_count": qualified_count,
        "total_prospects": len(compiled_companies),
        "compilation_time_seconds": round(time.time() - start_time, 2)
    }

    if write_files:
        with open(METADATA_FILE, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

    if not quiet:
        print(f"[✓] Compiled {len(compiled_companies)} prospects ({len(case_folders)} cases, {qualified_count} qualified) in {metadata['compilation_time_seconds']}s")
        if write_files:
            print(f"[✓] Saved JSON: {OUTPUT_JSON}")
            print(f"[✓] Saved JS:   {OUTPUT_JS}")
            print(f"[✓] Saved Meta: {METADATA_FILE}")
        else:
            print("[✓] Prepared research import source in memory; local Call Desk files were not changed.")

    return {
        "metadata": metadata,
        "companies": compiled_companies
    }

def main():
    compile_database(quiet=False)

if __name__ == "__main__":
    main()
