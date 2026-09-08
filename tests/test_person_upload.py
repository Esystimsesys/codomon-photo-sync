"""人物アルバムと送信履歴の回帰テスト（Photos・ネットワーク操作なし）。"""

import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import export_person as export
import mitene_upload as mitene
from common import PersonPhoto


class PersonAlbumTests(unittest.TestCase):
    def run_export(self, options=(), names=("current.jpeg",), members=()):
        config = {**export._CFG, "person": "Alice", "person_album": "Alice custom"}
        candidates = [PersonPhoto(n, 50, 1, 1, 1, True, "") for n in names]
        # 不採用写真がアルバムに追加されないことも検証する。
        candidates.append(PersonPhoto("excluded.jpeg", 0, 0, 1, 1, False, "胴体のみ"))
        source = MagicMock()
        source.glob.return_value = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["export_person.py", "--person", "Alice", "--no-copy", *options]))
            replacements = {
                "_CFG": config, "ALBUM": "Source", "SOURCE_ROOT": source,
                "open_library": MagicMock(return_value=object()),
                "album_pk": MagicMock(return_value=1),
                "person_photo_candidates": MagicMock(return_value=candidates),
                "analysis_gap": MagicMock(return_value=0),
                "album_member_names": MagicMock(return_value=set(members)),
                "append_album": MagicMock(return_value=True),
                "rebuild_album": MagicMock(return_value=True),
                "log": MagicMock(),
            }
            for key, value in replacements.items():
                stack.enter_context(patch.object(export, key, value))
            self.assertEqual(export.main(), 0)
            return replacements

    def test_other_person_uses_separate_album(self):
        mocks = self.run_export(["--person", "Bob"])
        mocks["append_album"].assert_called_once_with(["current.jpeg"], "Source（Bob）")

    def test_explicit_album_takes_precedence(self):
        mocks = self.run_export(["--person", "Bob", "--album", "Chosen"])
        mocks["append_album"].assert_called_once_with(["current.jpeg"], "Chosen")

    def test_configured_person_keeps_custom_album_and_selection(self):
        mocks = self.run_export()
        mocks["append_album"].assert_called_once_with(["current.jpeg"], "Alice custom")
        mocks["rebuild_album"].assert_not_called()

    def test_zero_selected_clears_stale_album(self):
        mocks = self.run_export(names=(), members=["old.jpeg"])
        mocks["rebuild_album"].assert_called_once_with([], "Alice custom", ["old.jpeg"])
        mocks["append_album"].assert_not_called()

    def test_zero_selected_without_stale_does_not_create_album(self):
        mocks = self.run_export(names=())
        mocks["rebuild_album"].assert_not_called()
        mocks["append_album"].assert_not_called()


class EmptyRebuildTests(unittest.TestCase):
    def test_failed_temp_creation_does_not_delete_old_album(self):
        with patch.object(export, "_osa", return_value=MagicMock(returncode=1, stderr="failed")) as osa, \
                patch.object(export, "_add_all") as add, \
                patch.object(export, "log"):
            self.assertFalse(export.rebuild_album([], "Person", ["old.jpeg"]))
        self.assertEqual(osa.call_count, 1)
        add.assert_not_called()
        self.assertNotIn('delete album "Person"', osa.call_args.args[0])

    def test_nonempty_temp_does_not_replace_with_stale_photos(self):
        with patch.object(export, "_osa", return_value=MagicMock(returncode=0)) as osa, \
                patch.object(export, "_add_all", return_value=True), \
                patch.object(export, "_count", return_value=1), \
                patch.object(export, "log"):
            self.assertFalse(export.rebuild_album([], "Person", ["old.jpeg"]))
        self.assertEqual(osa.call_count, 1)

    def test_verified_empty_temp_replaces_old_album(self):
        with patch.object(export, "_osa", return_value=MagicMock(returncode=0)) as osa, \
                patch.object(export, "_add_all", return_value=True), \
                patch.object(export, "_count", return_value=0), \
                patch.object(export, "log"):
            self.assertTrue(export.rebuild_album([], "Person", ["old.jpeg"]))
        self.assertEqual(osa.call_count, 2)
        self.assertIn('delete album "Person"', osa.call_args.args[0])


class SeedTests(unittest.TestCase):
    def test_seed_preserves_previously_uploaded_files(self):
        state = MagicMock()
        state.exists.return_value = True
        with patch.object(sys, "argv", ["mitene_upload.py", "--seed"]), \
                patch.object(mitene, "STATE_FILE", state), \
                patch.object(mitene, "person_files", return_value=[Path("current.jpeg")]), \
                patch.object(mitene, "load_ledger", return_value={"previous.jpeg"}), \
                patch.object(mitene, "save_ledger") as save, \
                patch.object(mitene, "upload") as upload, \
                patch.object(mitene, "log"):
            self.assertEqual(mitene.main(), 0)
        save.assert_called_once_with({"previous.jpeg", "current.jpeg"})
        upload.assert_not_called()


if __name__ == "__main__":
    unittest.main()
