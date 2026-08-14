"""profiles.py — slugs, criação (cópia e template), troca e exclusão."""

import pytest

from backend import storage
from backend.profiles import TEMPLATES, ProfileManager, slugify, templates_payload


def test_slugify():
    assert slugify("Dark Souls") == "dark-souls"
    assert slugify("  Ranqueada 2026!  ") == "ranqueada-2026"
    assert slugify("Ação & Aventura") == "acao-aventura"
    assert slugify("") == ""
    assert slugify("---") == ""


def test_list_starts_with_default(tmp_storage):
    pm = ProfileManager()
    assert pm.list() == ["default"]
    assert pm.current() == "default"


def test_create_copies_active_files(tmp_storage):
    storage.save_json(storage.config_path("counters.json"), {"counters": [{"name": "Origem"}]})
    pm = ProfileManager()
    slug = pm.create("Meu Jogo")
    assert slug == "meu-jogo"
    data = storage.load_json(pm.path("meu-jogo", "counters.json"))
    assert data["counters"][0]["name"] == "Origem"


def test_create_from_template_writes_counters_and_theme(tmp_storage):
    pm = ProfileManager()
    slug = pm.create("OW", template="overwatch")
    counters = storage.load_json(pm.path(slug, "counters.json"))["counters"]
    assert [c["name"] for c in counters] == ["Vitórias", "Derrotas", "Empates"]
    theme = storage.load_json(pm.path(slug, "theme.json"))
    assert theme["label_color"] == "#f99e1a"
    hk = storage.load_json(pm.path(slug, "hotkeys.json"))
    assert hk == {"enabled": False, "bindings": {}, "devices": []}


def test_create_validations(tmp_storage):
    pm = ProfileManager()
    with pytest.raises(ValueError):
        pm.create("")                      # nome vazio
    with pytest.raises(ValueError):
        pm.create("default")               # reservado
    pm.create("X")
    with pytest.raises(ValueError):
        pm.create("X")                     # duplicado
    with pytest.raises(ValueError):
        pm.create("Y", template="nao-existe")


def test_switch_and_delete_rules(tmp_storage):
    pm = ProfileManager()
    pm.create("A")
    pm.switch("a")
    assert pm.current() == "a"
    with pytest.raises(ValueError):
        pm.delete("a")                     # não exclui o ativo
    with pytest.raises(ValueError):
        pm.delete("default")               # não exclui o padrão
    pm.switch("default")
    assert "a" not in pm.delete("a")


def test_fallback_when_saved_profile_missing(tmp_storage):
    pm = ProfileManager(active="sumiu")
    assert pm.current() == "default"


def test_all_templates_are_complete():
    assert len(TEMPLATES) >= 6
    for tid, t in TEMPLATES.items():
        assert t["label"] and t["name"], tid
        assert t["counters"], tid
        for c in t["counters"]:
            assert c["name"] and "value" in c and "step" in c
        assert t["theme"].get("value_color") and t["theme"].get("card_background"), tid
    ids = [t["id"] for t in templates_payload()]
    assert ids == list(TEMPLATES.keys())
