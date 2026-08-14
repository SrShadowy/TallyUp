"""counter.py — CRUD, ordem, sanitização e persistência com debounce."""

from backend import storage
from backend.counter import CounterManager


def make(tmp_storage):
    return CounterManager()


def test_create_and_list_order(tmp_storage):
    m = make(tmp_storage)
    a = m.create("A")
    b = m.create("B")
    ids = [c["id"] for c in m.list()]
    assert ids == [a["id"], b["id"]]
    assert [c["order"] for c in m.list()] == [0, 1]


def test_increment_uses_step_and_amount(tmp_storage):
    m = make(tmp_storage)
    c = m.create("X", value=0, step=5)
    assert m.increment(c["id"])["value"] == 5
    assert m.increment(c["id"], amount=2)["value"] == 7
    assert m.decrement(c["id"])["value"] == 2
    assert m.reset(c["id"])["value"] == 0


def test_value_changes_are_debounced_then_flushed(tmp_storage):
    m = make(tmp_storage)
    c = m.create("X")                       # estrutural: salva na hora
    m.increment(c["id"])                    # valor: agenda debounce
    m.flush()                               # força a gravação pendente
    data = storage.load_json(storage.config_path("counters.json"))
    saved = next(x for x in data["counters"] if x["id"] == c["id"])
    assert saved["value"] == 1


def test_sanitize_fills_missing_fields(tmp_storage):
    storage.save_json(storage.config_path("counters.json"),
                      {"counters": [{"name": "Sujo"}, "lixo", {"id": "c-x", "value": "3"}]})
    m = CounterManager()
    cs = m.list()
    assert len(cs) == 2                      # "lixo" (não-dict) foi descartado
    for c in cs:
        for field in ("id", "name", "value", "step", "visible", "locked", "order", "x", "y", "style"):
            assert field in c
    assert cs[1]["value"] == 3               # "3" -> int


def test_delete_and_reorder(tmp_storage):
    m = make(tmp_storage)
    a, b, c = m.create("A"), m.create("B"), m.create("C")
    assert m.delete(b["id"]) is True
    assert m.delete("nao-existe") is False
    m.reorder([c["id"], a["id"]])
    assert [x["name"] for x in m.list()] == ["C", "A"]
    assert [x["order"] for x in m.list()] == [0, 1]


def test_duplicate_copies_style_and_offsets_position(tmp_storage):
    m = make(tmp_storage)
    a = m.create("A")
    m.set_style(a["id"], {"value_color": "#ff0000"})
    m.set_position(a["id"], 100, 200)
    d = m.duplicate(a["id"])
    assert d["name"] == "A cópia"
    assert d["style"] == {"value_color": "#ff0000"}
    assert (d["x"], d["y"]) == (124.0, 224.0)


def test_style_merge_and_replace(tmp_storage):
    m = make(tmp_storage)
    a = m.create("A")
    m.set_style(a["id"], {"opacity": 60, "rotation": 10})
    m.set_style(a["id"], {"rotation": None})          # merge: None remove a chave
    assert m.get(a["id"])["style"] == {"opacity": 60}
    m.set_style(a["id"], {"card_width": 300}, merge=False)  # replace total
    assert m.get(a["id"])["style"] == {"card_width": 300}


def test_visibility_toggle(tmp_storage):
    m = make(tmp_storage)
    a = m.create("A")
    assert m.toggle_visibility(a["id"])["visible"] is False
    assert m.set_visibility(a["id"], True)["visible"] is True
