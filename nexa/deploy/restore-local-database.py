#!/usr/bin/env python3
"""Restore the pre-deployment SQLite snapshot after stopping the service."""
from pathlib import Path
import json
import os
import shutil
import sqlite3
import subprocess
import sys


def restore_database(data_dir, snapshot, preserved_dir):
    data_dir, snapshot, preserved_dir = map(Path, (data_dir, snapshot, preserved_dir))
    if not snapshot.is_file() or preserved_dir.exists():
        raise RuntimeError('Missing snapshot or occupied database preservation destination')
    source = sqlite3.connect(f'file:{snapshot.resolve()}?mode=ro', uri=True)
    try:
        if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Rollback snapshot failed integrity verification')
    finally:
        source.close()
    current = [data_dir / name for name in ('storage.sqlite', 'storage.sqlite-wal', 'storage.sqlite-shm')]
    existing = [p for p in current if p.exists()]
    if existing:
        opened = subprocess.run(['lsof', '-t', *map(str, existing)], capture_output=True, text=True)
        if opened.returncode not in (0, 1) or opened.stdout.strip():
            raise RuntimeError('Database still has open handles; service must be stopped')
    staged = data_dir / ('storage.sqlite.rollback-' + str(os.getpid()))
    if staged.exists():
        raise RuntimeError('Occupied database staging destination')
    preserved_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copyfile(snapshot, staged)
    staged.chmod(0o600)
    moved = []
    try:
        for p in existing:
            dest = preserved_dir / p.name
            print(f'Preserving post-deployment database file: {p} -> {dest}')
            p.rename(dest)
            moved.append((p, dest))
        staged.rename(data_dir / 'storage.sqlite')
    except Exception:
        for original, preserved in reversed(moved):
            if not original.exists():
                preserved.rename(original)
        raise
    return {'ok': True, 'databaseRestored': True, 'postDeploymentDatabase': str(preserved_dir)}


if __name__ == '__main__':
    print(json.dumps(restore_database(*sys.argv[1:4])))
