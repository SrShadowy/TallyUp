"""backup.py — snapshot zip e rotação (prune)."""

import zipfile

from backend import backup, storage


def test_make_snapshot_includes_all_json(tmp_storage):
    storage.save_json(storage.config_path("counters.json"), {"counters": []})
    storage.save_json(storage.config_path("theme.json"), {"name": "x"})
    (storage.CONFIG_DIR / "profiles" / "abc").mkdir(parents=True)
    storage.save_json(storage.CONFIG_DIR / "profiles" / "abc" / "counters.json", {"counters": []})

    dest = backup.make_snapshot()
    assert dest is not None and dest.exists()
    names = set(zipfile.ZipFile(dest).namelist())
    assert "counters.json" in names
    assert "theme.json" in names
    assert "profiles/abc/counters.json" in names


def test_snapshot_excludes_backup_dir(tmp_storage):
    storage.save_json(storage.config_path("a.json"), {})
    first = backup.make_snapshot()
    second = backup.make_snapshot()
    names = zipfile.ZipFile(second).namelist()
    assert not any(n.startswith("backups") for n in names)
    assert first.exists()  # snapshot anterior não entra nem é apagado


def test_prune_keeps_most_recent(tmp_storage):
    storage.ensure_dirs()
    for i in range(12):
        (storage.BACKUP_DIR / f"backup-202601{i:02d}-000000.zip").write_bytes(b"x")
    backup._prune(keep=5)
    left = sorted(p.name for p in storage.BACKUP_DIR.glob("backup-*.zip"))
    assert len(left) == 5
    assert left[0] == "backup-20260107-000000.zip"  # ficaram os 5 mais novos
