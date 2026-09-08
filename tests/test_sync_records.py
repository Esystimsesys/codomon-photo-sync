"""Record archival regression tests; no network or Photos access."""

import json
import tempfile
import unittest
from contextlib import ExitStack
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

import sync_photos as sync


def post(identifier, content):
    return {"id": identifier, "display_date": "2026-09-01",
            "timeline_kind": "activities", "overview": content}


def response(items=None, next_page=False, status=200):
    result = MagicMock(status=status)
    result.text.return_value = json.dumps({"data": items or [], "next_page": next_page})
    return result


class SyncRecordsTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(sync, "SAVE_ROOT", self.root))
        self.stack.enter_context(patch.object(sync, "log"))
        self.a = post("A", "施設Aの記録")
        self.b = post("B", "施設Bの記録")

    def archive(self):
        return {name: (self.root / "2026-09-01" / name).read_bytes()
                for name in ("posts.json", "記録.md")}

    def run_sync(self, service_ids, responses):
        playwright = self.stack.enter_context(patch.object(sync, "sync_playwright"))
        context = playwright.return_value.__enter__.return_value.chromium.launch.return_value.new_context.return_value
        context.request.get.side_effect = responses
        for name, value in (("ensure_login", None), ("get_service_ids", service_ids),
                            ("download_photos", (0, 0)), ("download_files", (0, 0))):
            self.stack.enter_context(patch.object(sync, name, return_value=value))
        self.stack.enter_context(patch.object(sync, "IMPORT_TO_PHOTOS", False))
        sync.sync()

    def test_single_service_preserves_record_format(self):
        self.run_sync(["one"], [response([self.a])])
        archive = self.archive()
        self.assertEqual(archive["posts.json"].decode(),
                         json.dumps([self.a], ensure_ascii=False, indent=2))
        self.assertEqual(archive["記録.md"].decode(),
                         "# 2026-09-01 の記録\n\n## [活動記録]\n\n施設Aの記録\n")

    def test_same_day_records_from_both_services_are_preserved(self):
        self.run_sync(["one", "two"], [response([self.a]), response([self.b])])
        self.assertEqual(json.loads(self.archive()["posts.json"]), [self.a, self.b])
        text = self.archive()["記録.md"].decode()
        self.assertIn("施設Aの記録", text)
        self.assertIn("施設Bの記録", text)

    def test_failed_second_page_leaves_existing_files_unchanged(self):
        sync.save_records([self.a, self.b])
        before = self.archive()
        with self.assertRaisesRegex(RuntimeError, "status=500"):
            self.run_sync(["one"], [response([self.a], next_page=True), response(status=500)])
        self.assertEqual(self.archive(), before)

    def test_failed_second_service_leaves_existing_files_unchanged(self):
        sync.save_records([self.a, self.b])
        before = self.archive()
        with self.assertRaisesRegex(RuntimeError, "status=503"):
            self.run_sync(["one", "two"], [response([self.a]), response(status=503)])
        self.assertEqual(self.archive(), before)

    def test_page_limit_does_not_archive_partial_records(self):
        sync.save_records([self.a, self.b])
        before = self.archive()
        with patch.object(sync, "MAX_PAGES", 1), self.assertRaisesRegex(RuntimeError, "ページ上限"):
            self.run_sync(["one"], [response([self.a], next_page=True)])
        self.assertEqual(self.archive(), before)

    def test_last_page_at_limit_is_valid(self):
        context = MagicMock()
        context.request.get.return_value = response([self.a])
        with patch.object(sync, "MAX_PAGES", 1):
            self.assertEqual(sync.fetch_timeline(context, "one", date.today(), date.today()), [self.a])

    def test_empty_page_with_next_page_is_not_success(self):
        context = MagicMock()
        context.request.get.return_value = response(next_page=True)
        with self.assertRaisesRegex(RuntimeError, "空なのに"):
            sync.fetch_timeline(context, "one", date.today(), date.today())


if __name__ == "__main__":
    unittest.main()
