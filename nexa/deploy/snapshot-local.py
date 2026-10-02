#!/usr/bin/env python3
"""Create a private, consistent local backup without logging credential values."""
from pathlib import Path
import sys, sqlite3, shutil, json

home = Path.home()
target = Path(sys.argv[1]).resolve()
target.mkdir(mode=0o700, parents=True, exist_ok=False)
sources = [home/'.omniroute-local/.env', home/'.omniroute-local/bridge-upstream-dns.cjs', home/'Library/LaunchAgents/com.nexalance.omniroute.plist', home/'Library/Application Support/Local/run/router/nginx/conf/route.api-anthropic-bridge.conf', Path('/etc/hosts')]
for source in sources:
    if source.is_file():
        relative = source.relative_to(home) if source.is_relative_to(home) else Path('system/hosts')
        dest = target/relative
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        dest.chmod(0o600)
certs = home/'.omniroute-local/mitm'
if certs.is_dir():
    shutil.copytree(certs, target/'.omniroute-local/mitm')
    for p in (target/'.omniroute-local/mitm').rglob('*'):
        p.chmod(0o700 if p.is_dir() else 0o600)
db = home/'.omniroute-local/storage.sqlite'
if db.exists():
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as source:
        with sqlite3.connect(target/'storage.sqlite') as dest:
            source.backup(dest)
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup database integrity failed')
    (target/'storage.sqlite').chmod(0o600)
print(json.dumps({'ok': True, 'backup': str(target), 'databaseIntegrity': 'ok'}))
