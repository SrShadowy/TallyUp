"""API REST + WebSocket — rotas, guard de origem e fluxo de perfis."""

import pytest

EVIL = {"origin": "https://evil.example"}
LOCAL = {"origin": "http://127.0.0.1:3210"}


def first_id(client):
    return client.get("/counters").json()["counters"][0]["id"]


# ------------------------------------------------------------------ básicos
def test_health(client):
    d = client.get("/health").json()
    assert d["ok"] is True and "version" in d


def test_startup_creates_example_counter(client):
    counters = client.get("/counters").json()["counters"]
    assert len(counters) == 1 and counters[0]["name"] == "Mortes"


def test_startup_creates_initial_backup(client, tmp_storage):
    from backend import storage
    assert list(storage.BACKUP_DIR.glob("backup-*.zip"))


# ------------------------------------------------------------- contadores
def test_counter_crud_flow(client):
    r = client.post("/counter/create", json={"name": "Wins", "value": 2, "step": 3})
    c = r.json()["counter"]
    assert (c["name"], c["value"], c["step"]) == ("Wins", 2, 3)
    cid = c["id"]

    assert client.post("/counter/inc", json={"id": cid}).json()["counter"]["value"] == 5
    assert client.post("/counter/dec", json={"id": cid, "amount": 1}).json()["counter"]["value"] == 4
    assert client.post("/counter/set", json={"id": cid, "value": 99}).json()["counter"]["value"] == 99
    assert client.post("/counter/reset", json={"id": cid}).json()["counter"]["value"] == 0
    assert client.post("/counter/rename", json={"id": cid, "name": "Vitórias"}).json()["counter"]["name"] == "Vitórias"
    assert client.post("/counter/delete", json={"id": cid}).json()["ok"] is True
    assert client.post("/counter/inc", json={"id": cid}).status_code == 404


def test_counter_unknown_id_404(client):
    for route in ("/counter/inc", "/counter/dec", "/counter/reset"):
        assert client.post(route, json={"id": "c-fantasma"}).status_code == 404


def test_move_validates_direction(client):
    cid = first_id(client)
    assert client.post("/counter/move", json={"id": cid, "direction": "sideways"}).status_code == 400


def test_style_accepts_advanced_keys(client):
    cid = first_id(client)
    r = client.post("/counter/style", json={"id": cid, "style": {"opacity": 60, "card_width": 300}})
    assert r.json()["counter"]["style"] == {"opacity": 60, "card_width": 300}


# ----------------------------------------------------------- guard de origem
def test_post_with_foreign_origin_is_rejected(client):
    cid = first_id(client)
    r = client.post("/counter/inc", json={"id": cid}, headers=EVIL)
    assert r.status_code == 403


def test_post_with_local_or_no_origin_is_allowed(client):
    cid = first_id(client)
    assert client.post("/counter/inc", json={"id": cid}, headers=LOCAL).status_code == 200
    assert client.post("/counter/inc", json={"id": cid}).status_code == 200  # sem Origin (curl/OBS)


def test_get_is_not_blocked(client):
    assert client.get("/counters", headers=EVIL).status_code == 200


def test_post_same_origin_lan_is_allowed(client):
    """Servidor em 0.0.0.0 acessado pela LAN: Origin com o MESMO host da
    requisição deve passar (o TestClient usa o host 'testserver')."""
    cid = first_id(client)
    r = client.post("/counter/inc", json={"id": cid}, headers={"origin": "http://testserver"})
    assert r.status_code == 200


def test_post_other_lan_origin_still_rejected(client):
    """Origin de OUTRO host da rede continua bloqueado (não é same-origin)."""
    cid = first_id(client)
    r = client.post("/counter/inc", json={"id": cid}, headers={"origin": "http://192.168.1.99:3210"})
    assert r.status_code == 403


def test_websocket_rejects_foreign_origin(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", headers=EVIL):
            pass


def test_websocket_init_payload(client):
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
    assert msg["type"] == "init"
    for key in ("counters", "theme", "hotkeys", "profiles"):
        assert key in msg
    assert msg["profiles"]["active"] == "default"


# ----------------------------------------------------------------- hotkeys
def test_hotkeys_binding_roundtrip(client):
    cid = first_id(client)
    r = client.post("/hotkeys/binding", json={"id": cid, "action": "inc", "keys": "CTRL+F1"})
    assert r.json()["bindings"][cid]["inc"] == "ctrl+f1"      # normalizado
    r = client.post("/hotkeys/binding", json={"id": cid, "action": "inc", "keys": ""})
    assert cid not in r.json()["bindings"]                     # "" limpa


def test_hotkeys_binding_invalid_action(client):
    cid = first_id(client)
    assert client.post("/hotkeys/binding", json={"id": cid, "action": "explodir", "keys": "f1"}).status_code == 400


def test_deleting_counter_removes_orphan_bindings(client):
    r = client.post("/counter/create", json={"name": "Temp"})
    cid = r.json()["counter"]["id"]
    client.post("/hotkeys/binding", json={"id": cid, "action": "inc", "keys": "f9"})
    client.post("/counter/delete", json={"id": cid})
    assert cid not in client.get("/hotkeys").json()["bindings"]


# ------------------------------------------------------------------ perfis
def test_profiles_full_flow(client):
    assert client.get("/profiles").json() == {"profiles": ["default"], "active": "default"}
    tpls = client.get("/profiles/templates").json()["templates"]
    assert {"overwatch", "darksouls", "speedrun"} <= {t["id"] for t in tpls}

    r = client.post("/profiles/create", json={"name": "Overwatch", "template": "overwatch"})
    assert r.json()["profile"] == "overwatch"
    client.post("/profiles/switch", json={"name": "overwatch"})
    names = [c["name"] for c in client.get("/counters").json()["counters"]]
    assert names == ["Vitórias", "Derrotas", "Empates"]

    # isolamento: criar aqui não vaza para o default
    client.post("/counter/create", json={"name": "SóAqui"})
    client.post("/profiles/switch", json={"name": "default"})
    assert "SóAqui" not in [c["name"] for c in client.get("/counters").json()["counters"]]

    # regras de exclusão
    assert client.post("/profiles/delete", json={"name": "default"}).status_code == 400
    assert client.post("/profiles/delete", json={"name": "overwatch"}).status_code == 200
    assert client.post("/profiles/switch", json={"name": "overwatch"}).status_code == 400


def test_profile_create_invalid_template(client):
    assert client.post("/profiles/create", json={"name": "X", "template": "zzz"}).status_code == 400


# ------------------------------------------------------------------- stats
def test_stats_records_session_events(client):
    cid = first_id(client)
    client.post("/counter/inc", json={"id": cid})
    client.post("/counter/inc", json={"id": cid})
    client.post("/counter/dec", json={"id": cid})
    d = client.get("/stats").json()
    assert d["ok"] and "started" in d
    evs = [e for e in d["events"] if e["counter_id"] == cid]
    assert [e["action"] for e in evs] == ["inc", "inc", "dec"]
    last = evs[-1]
    assert last["after"] == last["before"] - 1
    assert "ts" in last


def test_stats_includes_timer_events(client):
    r = client.post("/counter/create", json={"name": "Run", "type": "timer"})
    tid = r.json()["counter"]["id"]
    client.server.actions.dispatch("inc", tid, notify=False)   # hotkey -> toggle
    d = client.get("/stats").json()
    assert any(e["action"] == "timer_inc" and e["counter_id"] == tid for e in d["events"])


# -------------------------------------------------------------------- tema
def test_theme_update_and_reset(client):
    r = client.post("/theme", json={"rotation": -5, "card_background2": "#ff0000"})
    t = r.json()["theme"]
    assert t["rotation"] == -5 and t["card_background2"] == "#ff0000"
    t = client.post("/theme/reset").json()["theme"]
    assert t["rotation"] == 0 and t["card_background2"] == ""


def test_static_pages_are_no_cache(client):
    for path in ("/admin/", "/overlay/", "/admin/app.js", "/overlay/app.js"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers.get("cache-control") == "no-cache", path
