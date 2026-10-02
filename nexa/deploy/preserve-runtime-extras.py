from pathlib import Path
import sys, shutil

source, target = map(Path, sys.argv[1:3])
for item in source.iterdir():
    if item.name in ('bin', 'lib'):
        continue
    destination = target / item.name
    if destination.exists():
        raise RuntimeError(f'Staged extra already exists: {destination}')
    print(f'Preserving runtime extra: {item.name}')
    if item.is_dir():
        shutil.copytree(item, destination)
    else:
        shutil.copy2(item, destination)
