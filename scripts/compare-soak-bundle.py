"""Read-only full bundle comparison against one pinned ZIP. Never extracts."""
import hashlib
import json
import os
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def digest(stream):
    value = hashlib.sha256()
    while True:
        data = stream.read(1024 * 1024)
        if not data:
            return value.hexdigest()
        value.update(data)


def compare(app, archive):
    app = Path(app)
    if app.is_symlink() or not app.is_dir() or app.resolve() != app:
        raise ValueError('bundle path must be a canonical directory')
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('archive is not a private regular file')
        zip_sha = digest(stream)
        stream.seek(0)
        records = []
        with zipfile.ZipFile(stream) as zipped:
            if len(zipped.infolist()) > 50000:
                raise ValueError('archive inventory exceeds bound')
            names = [entry.filename for entry in zipped.infolist()]
            if len(set(names)) != len(names):
                raise ValueError('duplicate archive entry')
            prefixes = set()
            for name in names:
                parts = PurePosixPath(name).parts
                if name.startswith('/') or '\\' in name or '..' in parts:
                    raise ValueError('unsafe archive path')
                for i, part in enumerate(parts):
                    if part == app.name and (not parts or parts[0] != '__MACOSX'):
                        prefixes.add('/'.join(parts[:i + 1]) + '/')
            if len(prefixes) != 1:
                raise ValueError('archive must contain exactly this bundle')
            prefix = prefixes.pop()
            total = 0
            for entry in zipped.infolist():
                if not entry.filename.startswith(prefix) or entry.is_dir():
                    continue
                relative = entry.filename[len(prefix):]
                target = app / relative
                actual = target.lstat()
                mode = entry.external_attr >> 16
                total += entry.file_size
                if entry.file_size > 1024 ** 3 or total > 8 * 1024 ** 3:
                    raise ValueError('bundle byte inventory exceeds bound')
                if stat.S_ISLNK(mode):
                    expected = zipped.read(entry).decode('utf-8')
                    if not target.is_symlink() or os.readlink(target) != expected:
                        raise ValueError('bundle symlink differs: ' + relative)
                    target.resolve().relative_to(app)
                    records.append({'path': relative, 'kind': 'symlink', 'target': expected})
                else:
                    if not stat.S_ISREG(actual.st_mode) or target.is_symlink() or actual.st_size != entry.file_size:
                        raise ValueError('bundle regular file differs: ' + relative)
                    target.resolve().relative_to(app)
                    if mode & 0o777 and actual.st_mode & 0o777 != mode & 0o777:
                        raise ValueError('bundle mode differs: ' + relative)
                    source_fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(source_fd, 'rb') as source, zipped.open(entry) as expected:
                        pinned = os.fstat(source.fileno())
                        if identity(pinned) != identity(actual) or pinned.st_nlink != 1:
                            raise ValueError('bundle file identity changed: ' + relative)
                        source_sha, expected_sha = digest(source), digest(expected)
                        if source_sha != expected_sha or identity(os.fstat(source.fileno())) != identity(pinned) or identity(target.lstat()) != identity(pinned):
                            raise ValueError('bundle bytes changed: ' + relative)
                    records.append({'path': relative, 'kind': 'file', 'bytes': actual.st_size,
                                    'mode': actual.st_mode & 0o777, 'sha256': source_sha})
        actual_paths = set()
        for root, dirs, files in os.walk(app, followlinks=False):
            for name in files + dirs:
                target = Path(root) / name
                if target.is_symlink() or target.is_file():
                    actual_paths.add(target.relative_to(app).as_posix())
        if actual_paths != {row['path'] for row in records}:
            raise ValueError('bundle and archive inventories differ')
        if identity(os.fstat(stream.fileno())) != identity(before) or identity(os.lstat(archive)) != identity(before):
            raise ValueError('archive identity changed')
        records.sort(key=lambda row: row['path'])
        manifest = json.dumps(records, sort_keys=True, separators=(',', ':')).encode()
        return {'zipSha256': zip_sha, 'manifestSha256': hashlib.sha256(manifest).hexdigest(),
                'files': records, 'bytes': total}


if __name__ == '__main__':
    try:
        print(json.dumps(compare(sys.argv[1], sys.argv[2]), separators=(',', ':')))
    except Exception as error:
        print('bundle comparison failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
