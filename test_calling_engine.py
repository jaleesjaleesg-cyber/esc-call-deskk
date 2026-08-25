import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

DATA_PATH = BASE_DIR / "companies_intelligence.json"
FULL_DATASET_AVAILABLE = DATA_PATH.exists()
UI_PATH = BASE_DIR / "esc_cold_call_copilot.html"
NODE_SERVER_PATH = BASE_DIR / "server.js"
PACKAGE_PATH = BASE_DIR / "package.json"
COMPILER_PATH = BASE_DIR / "compile_prospect_database.py"


class CallingEngineRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.companies = (
            json.loads(DATA_PATH.read_text(encoding="utf-8"))
            if FULL_DATASET_AVAILABLE
            else {}
        )
        cls.ui = UI_PATH.read_text(encoding="utf-8")
        cls.node_server = NODE_SERVER_PATH.read_text(encoding="utf-8")
        cls.compiler = COMPILER_PATH.read_text(encoding="utf-8")
        cls.package = json.loads(PACKAGE_PATH.read_text(encoding="utf-8"))

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_roberts_ob_uses_outside_broadcast_context_not_labour_supply(self):
        company = self.companies["SC873583"]
        profile = company["call_profile"]
        self.assertEqual(profile["readiness"], "tailored")
        self.assertEqual(profile["sector"], "outside broadcast and live-event security")
        self.assertFalse(profile["labour_supply_relevant"])
        self.assertNotIn("COP 119", company["phone_pitch"])
        self.assertNotIn("labour supply", company["phone_pitch"].lower())

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_labour_supply_is_only_added_when_evidence_supports_it(self):
        for company in self.companies.values():
            profile = company["call_profile"]
            if profile["readiness"] == "tailored" and not profile["labour_supply_relevant"]:
                self.assertNotIn("COP 119", company["phone_pitch"], company["company_name"])

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_existing_acs_company_is_not_sold_initial_acs_again(self):
        advantage = next(
            company for company in self.companies.values()
            if company["company_name"] == "ADVANTAGE SECURITY LIMITED"
        )
        profile = advantage["call_profile"]
        self.assertEqual(profile["acs_status"], "confirmed_existing")
        self.assertIn("annual ACS", profile["primary_offer"])
        self.assertNotIn("SIA ACS readiness and", profile["primary_offer"])

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_disqualified_and_registry_only_records_cannot_receive_sales_scripts(self):
        for company in self.companies.values():
            readiness = company["call_profile"]["readiness"]
            if company["prospect_status"] == "DISQUALIFIED":
                self.assertEqual(readiness, "do_not_call")
                self.assertTrue(company["phone_pitch"].startswith("DO NOT CALL"))
    def test_ui_minimalist_structure_and_clutter_toggle(self):
        self.assertIn('id="toggleScriptViewBtn"', self.ui)
        self.assertIn('id="pipelineDrawerBtn"', self.ui)
        self.assertIn('id="heroPhoneBadgesGrid"', self.ui)
        self.assertIn('id="directorsListContainer"', self.ui)
        self.assertIn('id="battleWhyBuy"', self.ui)
        self.assertIn('id="battleTargetPkg"', self.ui)
        self.assertIn('id="battleEvidenceList"', self.ui)
        self.assertIn('id="logResponseMoveListSelect"', self.ui)
        self.assertIn('data-pipeline-tab="all_qualified"', self.ui)
        self.assertIn('data-pipeline-tab="master_list"', self.ui)
        self.assertIn('data-pipeline-tab="off_our_list"', self.ui)

    def test_no_whatsapp_buttons_in_ui(self):
        self.assertNotIn("btn-whatsapp", self.ui)
        self.assertNotIn("heroWhatsAppBtn", self.ui)

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_master_list_vs_qualified_separation(self):
        total = len(self.companies)
        qualified = [c for c in self.companies.values() if c.get("prospect_status") == "QUALIFIED"]
        disqualified = [c for c in self.companies.values() if c.get("prospect_status") == "DISQUALIFIED"]
        self.assertGreaterEqual(total, 1942)
        self.assertGreaterEqual(len(qualified), 60)
        self.assertGreaterEqual(len(disqualified), 140)

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_phone_numbers_labeled_with_purpose(self):
        spotlight = self.companies.get("SC845085")
        self.assertIsNotNone(spotlight)
        phones = spotlight.get("phone_numbers", [])
        self.assertGreaterEqual(len(phones), 1)
        self.assertTrue(any("Callum" in p.get("purpose", "") or p.get("type") == "mobile" for p in phones))
        self.assertTrue(any(p.get("type") in ["corporate", "landline", "mobile"] for p in phones))

    @unittest.skipUnless(FULL_DATASET_AVAILABLE, "production company data is intentionally excluded from Git")
    def test_social_profiles_extracted(self):
        spotlight = self.companies.get("SC845085")
        self.assertIn("facebook", spotlight.get("social_profiles", {}))
        edgbaston = self.companies.get("03682048")
        if edgbaston:
            self.assertIn("linkedin_company", edgbaston.get("social_profiles", {}))

    def test_authentication_and_roles(self):
        self.assertIn('id="loginModalBackdrop"', self.ui)
        self.assertIn('id="loginPasswordInput"', self.ui)
        self.assertIn('id="submitLoginBtn"', self.ui)
        self.assertIn('id="logoutBtn"', self.ui)
        self.assertIn('id="userBadgeDisplay"', self.ui)
        self.assertIn('aroosa: { username: "aroosa"', self.ui)
        self.assertIn('jalees: { username: "jalees"', self.ui)
        self.assertIn('<option value="aroosa">Aroosa</option>', self.ui)
        self.assertIn('<option value="jalees">Jalees</option>', self.ui)
        self.assertIn('/api/auth/login', self.ui)
        self.assertNotIn('passwords: ["goraya", "jalees"]', self.ui)

    def test_hostinger_server_fails_closed_and_protects_business_data(self):
        self.assertIn("app.use('/api', requireAuthenticated)", self.node_server)
        self.assertIn("ESC_AROOSA_PASSWORD and ESC_JALEES_PASSWORDS must be set", self.node_server)
        self.assertIn("secure: COOKIE_SECURE", self.node_server)
        self.assertIn("sameSite: 'strict'", self.node_server)
        self.assertIn("app.post('/api/settings', requireHandler", self.node_server)
        self.assertIn("app.post('/api/history/clear', requireHandler", self.node_server)
        self.assertIn("app.post('/api/snapshots/restore', requireHandler", self.node_server)
        self.assertIn("/^snapshot_[A-Za-z0-9_-]+\\.json$/", self.node_server)
        self.assertNotIn("express.static(SCRIPT_DIR)", self.node_server)
        self.assertNotIn("'cors'", self.package["dependencies"])
        self.assertIn("PersistentStore", self.node_server)
        self.assertIn("require('./persistent_store')", self.node_server)
        self.assertIn("getVisibleCompanies()", self.node_server)
        self.assertIn("mysql2", self.package["dependencies"])

    def test_hostinger_login_shell_does_not_preload_company_database(self):
        self.assertNotIn('<script src="companies_intelligence_data.js"></script>', self.ui)
        self.assertIn("const authenticated = await refreshAuthSession();", self.ui)
        self.assertIn("if (!authenticated)", self.ui)
        self.assertIn("sendAppOrLogin(req, res)", self.node_server)

    def test_pinned_tab_and_company_controls(self):
        self.assertIn('data-pipeline-tab="pinned"', self.ui)
        self.assertIn('id="countPinned"', self.ui)
        self.assertIn('id="pinCompanyBtn"', self.ui)
        self.assertIn('id="deleteCompanyBtn"', self.ui)
        self.assertIn('companyMatchesTab', self.ui)
        self.assertIn('is_pinned', self.ui)
        self.assertIn('/api/companies/delete', self.ui)

    def test_mandatory_contact_fields_validation_on_move(self):
        self.assertIn('id="mandatoryPhoneSection"', self.ui)
        self.assertIn('id="logDialedPhoneSelect"', self.ui)
        self.assertIn('id="callOutcomeInput"', self.ui)
        self.assertIn('Choose what happened on this call', self.ui)
        self.assertIn('id="loggerRouteHint"', self.ui)
        self.assertIn('if (!targetList)', self.ui)
        self.assertIn('serverSaveQueued = true', self.ui)
        self.assertIn('const needsFollowUp = serverSaveQueued', self.ui)
        self.assertIn('loggerSelectionCrn !== crn', self.ui)
        self.assertIn('if (companyChanged) loggerSelectionCrn = null', self.ui)
        self.assertIn('data-pipeline-tab="unreachable"', self.ui)
        self.assertIn('finalList = "unreachable"', self.ui)
        self.assertIn('attempts >= getUnreachableThreshold()', self.ui)

    def test_note_sync_cannot_undo_a_newer_pipeline_move(self):
        import server
        moved_on_server = {
            "pipeline_list": "reached",
            "contact_attempts": 1,
            "pipeline_updated_at": 300,
            "call_notes": "Older note",
            "notes_updated_at": 100,
            "is_pinned": True,
            "pin_updated_at": 250,
            "last_updated": 300,
        }
        newer_note_from_stale_tab = {
            "pipeline_list": "todays_targets",
            "contact_attempts": 0,
            "pipeline_updated_at": 200,
            "call_notes": "Spoke to Sarah and emailed the details",
            "last_outcome": "Email the info",
            "notes_updated_at": 400,
            "is_pinned": False,
            "pin_updated_at": 200,
            "last_updated": 400,
        }
        merged = server.merge_pipeline_entries_by_revision(moved_on_server, newer_note_from_stale_tab)
        self.assertEqual(merged["pipeline_list"], "reached")
        self.assertEqual(merged["contact_attempts"], 1)
        self.assertEqual(merged["call_notes"], "Spoke to Sarah and emailed the details")
        self.assertEqual(merged["last_outcome"], "Email the info")
        self.assertTrue(merged["is_pinned"])
        self.assertIn("mergePipelineEntriesByRevision", self.node_server)
        self.assertIn("pipeline_updated_at", self.node_server)
        self.assertIn("notes_updated_at", self.node_server)

    def test_contact_routing_repair_covers_all_evidenced_legacy_records(self):
        import repair_contact_routing

        expected_deferred = {
            "12572025", "14870919", "SC788938", "SC852294",
            "SC865370", "SC521023", "SC736028", "SC754412",
        }
        self.assertEqual(repair_contact_routing.DEFERRED_REVIEW, expected_deferred)
        self.assertEqual(repair_contact_routing.ROUTING_REPAIRS["12134890"][:2], ("contacted", 1))
        self.assertEqual(repair_contact_routing.ROUTING_REPAIRS["NI638479"][:2], ("contacted", 1))
        self.assertEqual(repair_contact_routing.ROUTING_REPAIRS["11111259"][0], "off_our_list")
        self.assertEqual(repair_contact_routing.ROUTING_REPAIRS["12584663"][:2], ("contacted", 1))
        self.assertTrue(expected_deferred.isdisjoint(repair_contact_routing.ROUTING_REPAIRS))

    def test_handler_suite_and_workflows(self):
        self.assertIn('id="handlerSuiteBtn"', self.ui)
        self.assertIn('id="handlerSuiteModalBackdrop"', self.ui)
        self.assertIn('id="handlerReportsTab"', self.ui)
        self.assertIn('id="handlerAssignTab"', self.ui)
        self.assertIn('id="handlerRetargetTab"', self.ui)
        self.assertIn('id="handlerImportTab"', self.ui)
        self.assertIn('id="researchImportFileInput"', self.ui)
        self.assertIn('id="previewResearchImportBtn"', self.ui)
        self.assertIn('id="commitResearchImportBtn"', self.ui)
        self.assertIn('/api/research-import/preview', self.ui)
        self.assertIn('/api/research-import/commit', self.ui)
        self.assertIn("app.post('/api/research-import/preview', requireHandler", self.node_server)
        self.assertIn("app.post('/api/research-import/commit', requireHandler", self.node_server)
        self.assertIn("def compile_database(quiet=False, write_files=True):", self.compiler)
        self.assertIn("if write_files and not os.path.exists(PIPELINE_STATE_FILE):", self.compiler)
        self.assertIn('id="assignBatchSizeInput"', self.ui)
        self.assertIn('id="executeAssignNextNBtn"', self.ui)
        self.assertIn('id="moveSelectedToTodaysTargetsBtn"', self.ui)
        self.assertIn('id="exportDailyReportCsvBtn"', self.ui)

    def test_user_defined_notes_display_only_when_available(self):
        self.assertIn('id="userSavedNotesCard"', self.ui)
        self.assertIn('id="userSavedNotesContent"', self.ui)
        self.assertTrue('savedNotesCard.style.display = "none"' in self.ui or "savedNotesCard.style.display = 'none'" in self.ui)
        self.assertTrue('savedNotesCard.style.display = "flex"' in self.ui or "savedNotesCard.style.display = 'flex'" in self.ui)

    def test_ui_snapshot_and_persistence_elements(self):
        self.assertIn('id="saveSnapshotBtn"', self.ui)
        self.assertIn('id="manageSnapshotsBtn"', self.ui)
        self.assertIn('id="snapshotsModalBackdrop"', self.ui)
        self.assertIn('id="diskStatusPill"', self.ui)
        self.assertIn('id="executeCreateSnapshotBtn"', self.ui)
        self.assertIn('id="executeUploadSnapshotBtn"', self.ui)
        self.assertIn('id="snapshotsListContainer"', self.ui)
        self.assertIn('syncStateToServer', self.ui)

    def test_pipeline_state_file_and_compiler_preservation(self):
        import compile_prospect_database

        # GitHub deliberately excludes live pipeline_state.json. Exercise the
        # compiler's preservation logic with an isolated fixture so this test
        # behaves the same in a clean checkout and beside the live workspace.
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "pipeline_state.json"
            expected = {
                "SC_TEST": {
                    "pipeline_list": "contacted",
                    "call_notes": "Existing live state must survive compilation",
                }
            }
            state_path.write_text(json.dumps(expected), encoding="utf-8")
            with patch.object(compile_prospect_database, "PIPELINE_STATE_FILE", str(state_path)):
                state = compile_prospect_database.load_persisted_pipeline_state()
            self.assertEqual(state, expected)

    def test_snapshot_engine(self):
        import server
        test_state = {"TEST_CRN_999": {"pipeline_list": "todays_targets", "call_notes": "Unit test note"}}
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            state_path = temp_path / "pipeline_state.json"
            history_path = temp_path / "call_history.json"
            settings_path = temp_path / "workspace_settings.json"
            snapshots_path = temp_path / "snapshots"
            snapshots_path.mkdir()
            state_path.write_text("{}", encoding="utf-8")
            history_path.write_text("[]", encoding="utf-8")
            settings_path.write_text('{"unreachable_after_attempts": 2}', encoding="utf-8")
            with patch.object(server, "PIPELINE_STATE_FILE", str(state_path)), \
                 patch.object(server, "CALL_HISTORY_FILE", str(history_path)), \
                 patch.object(server, "WORKSPACE_SETTINGS_FILE", str(settings_path)), \
                 patch.object(server, "SNAPSHOTS_DIR", str(snapshots_path)), \
                 patch.object(server, "compile_database", return_value={}):
                snap = server.create_snapshot(
                    name="Unit Test Snapshot", notes="Snapshot created during unit test",
                    created_by="UnitTest", snap_type="manual", custom_state=test_state
                )
                self.assertTrue(any(s["id"] == snap["id"] for s in server.list_all_snapshots()))
                restored, err = server.restore_snapshot(snap["id"])
                self.assertIsNone(err)
                self.assertIn("TEST_CRN_999", restored["pipeline_state"])

    def test_shared_contact_threshold_is_bounded(self):
        import server
        self.assertEqual(server.normalize_workspace_settings({"unreachable_after_attempts": 4})["unreachable_after_attempts"], 4)
        self.assertEqual(server.normalize_workspace_settings({"unreachable_after_attempts": 0})["unreachable_after_attempts"], 1)
        self.assertEqual(server.normalize_workspace_settings({"unreachable_after_attempts": 99})["unreachable_after_attempts"], 20)

    def test_server_authenticates_roles_and_rejects_wrong_password(self):
        import server
        self.assertEqual(server.authenticate_credentials("jalees", "jalees")["role"], "handler")
        self.assertEqual(server.authenticate_credentials("aroosa", "aroosa")["role"], "caller")
        self.assertIsNone(server.authenticate_credentials("aroosa", "wrong"))

    def test_company_delete_creates_tombstone_and_clears_active_data(self):
        import server
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            companies_path = temp_path / "companies.json"
            state_path = temp_path / "pipeline_state.json"
            history_path = temp_path / "call_history.json"
            deleted_path = temp_path / "deleted_companies.json"
            companies_path.write_text(json.dumps({"SC123456": {"crn": "SC123456", "company_name": "TEST SECURITY LTD"}}), encoding="utf-8")
            state_path.write_text(json.dumps({"SC123456": {"pipeline_list": "pinned", "is_pinned": True}}), encoding="utf-8")
            history_path.write_text(json.dumps([{"crn": "SC123456", "outcome": "Called"}, {"crn": "KEEP", "outcome": "Keep"}]), encoding="utf-8")
            with patch.object(server, "OUTPUT_JSON", str(companies_path)), \
                 patch.object(server, "PIPELINE_STATE_FILE", str(state_path)), \
                 patch.object(server, "CALL_HISTORY_FILE", str(history_path)), \
                 patch.object(server, "DELETED_COMPANIES_FILE", str(deleted_path)), \
                 patch.object(server, "create_snapshot") as snapshot_mock, \
                 patch.object(server, "compile_database", return_value={}):
                deleted, err = server.delete_company_record("SC123456", "Jalees")
                self.assertIsNone(err)
                self.assertEqual(deleted["deleted_by"], "Jalees")
                self.assertIn("SC123456", json.loads(deleted_path.read_text(encoding="utf-8")))
                self.assertNotIn("SC123456", json.loads(state_path.read_text(encoding="utf-8")))
                remaining_history = json.loads(history_path.read_text(encoding="utf-8"))
                self.assertEqual([item["crn"] for item in remaining_history], ["KEEP"])
                snapshot_mock.assert_called_once()

    def test_contact_workflow_and_fullscreen_workspace_elements(self):
        self.assertIn('id="unreachableThresholdInput"', self.ui)
        self.assertIn('id="saveCallingRulesBtn"', self.ui)
        self.assertIn('id="contactLogModalBackdrop"', self.ui)
        self.assertIn('id="saveContactAttemptBtn"', self.ui)
        self.assertIn('id="pipelineSortSelect"', self.ui)
        self.assertIn('id="pipelineWorkspaceTabs"', self.ui)
        self.assertIn('recordContactAttempt', self.ui)
        self.assertIn('event_type: "contact_attempt"', self.ui)

    def test_jalees_notes_ui_is_separate_and_handler_editable(self):
        self.assertIn('id="jaleesNotesCard"', self.ui)
        self.assertIn('id="jaleesNotesContent"', self.ui)
        self.assertIn('id="jaleesNotesModalBackdrop"', self.ui)
        self.assertIn('id="jaleesNotesTextarea"', self.ui)
        self.assertIn('id="saveJaleesNotesBtn"', self.ui)
        self.assertIn('class="btn btn-sm jalees-note-edit-control"', self.ui)
        self.assertIn('currentUser.role !== "handler"', self.ui)
        self.assertIn('jalees_notes_updated_at', self.ui)

    def test_newer_jalees_note_survives_an_unrelated_caller_sync(self):
        import server
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            state_path = temp_path / "pipeline_state.json"
            history_path = temp_path / "call_history.json"
            settings_path = temp_path / "workspace_settings.json"
            state_path.write_text(json.dumps({
                "TEST": {
                    "pipeline_list": "contacted",
                    "call_notes": "Old caller note",
                    "last_updated": 200,
                    "jalees_notes": "Ask for Sarah after 11am",
                    "jalees_notes_updated_at": 200,
                    "jalees_notes_updated_by": "Jalees",
                }
            }), encoding="utf-8")
            history_path.write_text("[]", encoding="utf-8")
            settings_path.write_text('{"unreachable_after_attempts": 2}', encoding="utf-8")
            with patch.object(server, "PIPELINE_STATE_FILE", str(state_path)), \
                 patch.object(server, "CALL_HISTORY_FILE", str(history_path)), \
                 patch.object(server, "WORKSPACE_SETTINGS_FILE", str(settings_path)):
                merged, _, _ = server.merge_workspace_state({
                    "TEST": {
                        "pipeline_list": "contacted",
                        "call_notes": "New caller note",
                        "last_updated": 300,
                    }
                })
                self.assertEqual(merged["TEST"]["call_notes"], "New caller note")
                self.assertEqual(merged["TEST"]["jalees_notes"], "Ask for Sarah after 11am")

                merged, _, _ = server.merge_workspace_state({
                    "TEST": {
                        **merged["TEST"],
                        "jalees_notes": "Use the mobile number first",
                        "jalees_notes_updated_at": 400,
                        "jalees_notes_updated_by": "Jalees",
                        "last_updated": 400,
                    }
                })
                self.assertEqual(merged["TEST"]["jalees_notes"], "Use the mobile number first")

    def test_pin_state_persists_without_changing_pipeline_list(self):
        import server
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            state_path = temp_path / "pipeline_state.json"
            history_path = temp_path / "call_history.json"
            settings_path = temp_path / "workspace_settings.json"
            deleted_path = temp_path / "deleted_companies.json"
            state_path.write_text("{}", encoding="utf-8")
            history_path.write_text("[]", encoding="utf-8")
            settings_path.write_text('{"unreachable_after_attempts": 2}', encoding="utf-8")
            deleted_path.write_text("{}", encoding="utf-8")
            with patch.object(server, "PIPELINE_STATE_FILE", str(state_path)), \
                 patch.object(server, "CALL_HISTORY_FILE", str(history_path)), \
                 patch.object(server, "WORKSPACE_SETTINGS_FILE", str(settings_path)), \
                 patch.object(server, "DELETED_COMPANIES_FILE", str(deleted_path)):
                merged, _, _ = server.merge_workspace_state({
                    "TEST": {
                        "pipeline_list": "todays_targets",
                        "is_pinned": True,
                        "pinned_by": "Aroosa",
                        "pinned_at": 500,
                        "last_updated": 500,
                    }
                })
                self.assertTrue(merged["TEST"]["is_pinned"])
                self.assertEqual(merged["TEST"]["pipeline_list"], "todays_targets")

    def test_permanently_off_our_list_ui_and_stats(self):
        import server
        self.assertIn('data-pipeline-tab="permanently_off_our_list"', self.ui)
        self.assertIn('id="countPermanentlyOffOurList"', self.ui)
        self.assertIn('value="permanently_off_our_list"', self.ui)
        self.assertIn('data-workspace-list="permanently_off_our_list"', self.ui)

        stats = server.compute_snapshot_stats(
            {"SC001": {"pipeline_list": "permanently_off_our_list"}},
            []
        )
        self.assertEqual(stats.get("permanently_off_our_list"), 1)

    def test_clear_call_history_record_creates_snapshot_and_resets_file(self):
        import server
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            state_path = temp_path / "pipeline_state.json"
            history_path = temp_path / "call_history.json"
            settings_path = temp_path / "workspace_settings.json"
            snapshots_path = temp_path / "snapshots"
            snapshots_path.mkdir()
            state_path.write_text("{}", encoding="utf-8")
            history_path.write_text(json.dumps([{"id": 1, "caller": "Aroosa", "outcome": "voicemail"}]), encoding="utf-8")
            settings_path.write_text('{"unreachable_after_attempts": 2}', encoding="utf-8")

            with patch.object(server, "PIPELINE_STATE_FILE", str(state_path)), \
                 patch.object(server, "CALL_HISTORY_FILE", str(history_path)), \
                 patch.object(server, "WORKSPACE_SETTINGS_FILE", str(settings_path)), \
                 patch.object(server, "SNAPSHOTS_DIR", str(snapshots_path)):
                rev = server.clear_call_history_record(cleared_by="Aroosa")
                self.assertIsNotNone(rev)
                remaining = json.loads(history_path.read_text(encoding="utf-8"))
                self.assertEqual(remaining, [])
                snaps = server.list_all_snapshots()
                self.assertTrue(any(s["type"] == "pre_clear_history" for s in snaps))

    def test_redesigned_history_modal_and_filter_elements(self):
        self.assertIn('id="historyModalBackdrop"', self.ui)
        self.assertIn('id="historyCallerFilter"', self.ui)
        self.assertIn('id="historyTypeFilter"', self.ui)
        self.assertIn('id="historyListFilter"', self.ui)
        self.assertIn('id="historyDateFilter"', self.ui)
        self.assertIn('id="historySearchInput"', self.ui)
        self.assertIn('id="historyPresetButtons"', self.ui)
        self.assertIn('id="clearHistoryModalBackdrop"', self.ui)
        self.assertIn('id="confirmClearHistoryBtn"', self.ui)
        self.assertIn('id="histStatAroosa"', self.ui)
        self.assertIn('id="histStatTotal"', self.ui)


if __name__ == "__main__":
    unittest.main()
