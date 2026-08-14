"""Efeitos (VFX) — biblioteca, CRUD e integração com a API."""


def test_defaults_seeded(client):
    d = client.get("/effects").json()
    ids = [e["id"] for e in d["effects"]]
    assert {"pop", "flash", "shake", "bounce", "zoom", "slide", "glow", "rainbow"} <= set(ids)
    pop = next(e for e in d["effects"] if e["id"] == "pop")
    assert pop["builtin"] is True and ".fx-pop" in pop["css"]


def test_create_custom_effect(client):
    r = client.post("/effects/save", json={"name": "Explosão Máxima", "css": ".fx-explosao-maxima { animation: x 1s; }"})
    assert r.status_code == 200, r.text
    e = r.json()["effect"]
    assert e["id"] == "explosao-maxima" and e["builtin"] is False


def test_edit_keeps_id(client):
    client.post("/effects/save", json={"name": "Meu", "css": ".fx-meu{}"})
    r = client.post("/effects/save", json={"id": "meu", "name": "Meu Renomeado", "css": ".fx-meu{color:red}"})
    e = r.json()["effect"]
    assert e["id"] == "meu" and e["name"] == "Meu Renomeado"
    ids = [x["id"] for x in r.json()["effects"]]
    assert ids.count("meu") == 1


def test_save_validations(client):
    assert client.post("/effects/save", json={"name": "", "css": "x"}).status_code == 400
    assert client.post("/effects/save", json={"name": "X", "css": "   "}).status_code == 400
    assert client.post("/effects/save", json={"name": "X", "css": "a" * 30000}).status_code == 400


def test_delete_and_reset_restores_builtins_keeps_customs(client):
    client.post("/effects/save", json={"name": "Custom", "css": ".fx-custom{}"})
    assert client.post("/effects/delete", json={"id": "pop"}).status_code == 200
    assert client.post("/effects/delete", json={"id": "nao-existe"}).status_code == 404
    ids = [e["id"] for e in client.get("/effects").json()["effects"]]
    assert "pop" not in ids and "custom" in ids

    r = client.post("/effects/reset")
    ids = [e["id"] for e in r.json()["effects"]]
    assert "pop" in ids and "custom" in ids   # padrão volta, custom permanece


def test_effects_persist_across_reload(client, tmp_storage):
    from backend.effects import EffectsManager
    client.post("/effects/save", json={"name": "Persistente", "css": ".fx-persistente{}"})
    m = EffectsManager()   # recarrega do disco
    assert m.get("persistente") is not None


def test_ws_init_includes_effects(client):
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
    assert msg["type"] == "init" and "effects" in msg
    assert any(e["id"] == "pop" for e in msg["effects"])


def test_theme_has_effect_default(client):
    assert client.get("/theme").json()["effect"] == "pop"


def test_element_style_accepts_effect(client):
    cid = client.get("/counters").json()["counters"][0]["id"]
    r = client.post("/counter/style", json={"id": cid, "style": {"effect": "shake"}})
    assert r.json()["counter"]["style"]["effect"] == "shake"
