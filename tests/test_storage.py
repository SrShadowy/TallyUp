"""storage.py — escrita atômica, backup .bak e recuperação de corrompidos."""

from backend import storage


def test_save_and_load_roundtrip(tmp_storage):
    p = storage.config_path("x.json")
    storage.save_json(p, {"a": 1, "acentuação": "çãé"})
    assert storage.load_json(p) == {"a": 1, "acentuação": "çãé"}


def test_load_missing_returns_default(tmp_storage):
    assert storage.load_json(storage.config_path("nao-existe.json"), default={"d": 1}) == {"d": 1}


def test_backup_bak_is_previous_version(tmp_storage):
    p = storage.config_path("x.json")
    storage.save_json(p, {"v": 1})
    storage.save_json(p, {"v": 2})
    bak = p.with_suffix(p.suffix + ".bak")
    assert bak.exists()
    assert storage.load_json(bak) == {"v": 1}
    assert storage.load_json(p) == {"v": 2}


def test_corrupted_file_falls_back_to_bak(tmp_storage):
    p = storage.config_path("x.json")
    storage.save_json(p, {"ok": True})
    storage.save_json(p, {"ok": "novo"})
    p.write_text("{isso não é json", encoding="utf-8")
    # arquivo corrompido -> usa o .bak (versão anterior)
    assert storage.load_json(p, default=None) == {"ok": True}


def test_no_tmp_leftovers(tmp_storage):
    p = storage.config_path("x.json")
    storage.save_json(p, {"a": 1})
    assert not list(p.parent.glob("*.tmp"))
