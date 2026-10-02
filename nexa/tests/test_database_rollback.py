from pathlib import Path
import importlib.util
import sqlite3
import tempfile
import unittest

module_path = Path(__file__).parents[1] / 'deploy/restore-local-database.py'
spec = importlib.util.spec_from_file_location('rollback', module_path)
rollback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollback)


class DatabaseRollbackTests(unittest.TestCase):
    def test_restores_old_schema_and_preserves_failed_migration(self):
        with tempfile.TemporaryDirectory(prefix='bridge-db-rollback-') as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            db = data / 'storage.sqlite'
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE settings (value TEXT)')
                c.execute("INSERT INTO settings VALUES ('original')")
            c.close()
            snapshot = root / 'snapshot.sqlite'
            with sqlite3.connect(db) as c, sqlite3.connect(snapshot) as backup:
                c.backup(backup)
            c.close()
            backup.close()
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE future_schema (id INTEGER)')
                c.execute("UPDATE settings SET value='changed'")
            c.close()
            result = rollback.restore_database(data, snapshot, root / 'failed')
            self.assertTrue(result['databaseRestored'])
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute('SELECT value FROM settings').fetchone()[0], 'original')
                self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='future_schema'").fetchone())
            with sqlite3.connect(root / 'failed/storage.sqlite') as c:
                self.assertEqual(c.execute('SELECT value FROM settings').fetchone()[0], 'changed')
                self.assertIsNotNone(c.execute("SELECT name FROM sqlite_master WHERE name='future_schema'").fetchone())

    def test_rejects_bad_snapshot_without_moving_current_database(self):
        with tempfile.TemporaryDirectory(prefix='bridge-db-rollback-') as directory:
            root = Path(directory)
            current = root / 'storage.sqlite'
            current.write_bytes(b'original')
            invalid = root / 'invalid.sqlite'
            invalid.write_bytes(b'not sqlite')
            with self.assertRaises(sqlite3.DatabaseError):
                rollback.restore_database(root, invalid, root / 'failed')
            self.assertEqual(current.read_bytes(), b'original')
            self.assertFalse((root / 'failed').exists())


if __name__ == '__main__':
    unittest.main()
