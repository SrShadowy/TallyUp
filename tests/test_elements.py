"""Novos tipos de elemento: texto livre, imagem e timer/cronômetro."""

import io
import time


def create(client, **kw):
    r = client.post("/counter/create", json=kw)
    assert r.status_code == 200, r.text
    return r.json()["counter"]


# ------------------------------------------------------------------- criação
def test_create_types_and_defaults(client):
    t = create(client, name="Aviso", type="text")
    assert t["type"] == "text"
    i = create(client, name="Logo", type="image")
    assert i["type"] == "image" and i["style"] == {"card_width": 320}
    tm = create(client, name="Run", type="timer")
    assert tm["type"] == "timer" and tm["running"] is False and tm["elapsed"] == 0
    c = create(client, name="Normal")
    assert c["type"] == "counter"


def test_create_invalid_type_falls_back_to_counter(client):
    c = create(client, name="X", type="video")
    assert c["type"] == "counter"


def test_old_data_gets_type_counter(client):
    # elementos antigos (sem "type") são sanitizados como counter
    counters = client.get("/counters").json()["counters"]
    assert all("type" in c for c in counters)


# --------------------------------------------------------------------- timer
def test_timer_start_pause_reset(client):
    tm = create(client, name="Run", type="timer")
    cid = tm["id"]

    r = client.post("/counter/timer", json={"id": cid, "op": "start"})
    assert r.json()["counter"]["running"] is True
    time.sleep(0.15)
    r = client.post("/counter/timer", json={"id": cid, "op": "pause"})
    c = r.json()["counter"]
    assert c["running"] is False and 0.1 < c["elapsed"] < 5

    r = client.post("/counter/timer", json={"id": cid, "op": "reset"})
    assert r.json()["counter"]["elapsed"] == 0

    # toggle liga e desliga
    assert client.post("/counter/timer", json={"id": cid, "op": "toggle"}).json()["counter"]["running"] is True
    assert client.post("/counter/timer", json={"id": cid, "op": "toggle"}).json()["counter"]["running"] is False


def test_timer_list_reports_live_elapsed(client):
    tm = create(client, name="Run", type="timer")
    client.post("/counter/timer", json={"id": tm["id"], "op": "start"})
    time.sleep(0.12)
    got = next(c for c in client.get("/counters").json()["counters"] if c["id"] == tm["id"])
    assert got["elapsed"] > 0.1   # list() calcula o decorrido até agora


def test_timer_invalid_op_and_wrong_type(client):
    tm = create(client, name="Run", type="timer")
    assert client.post("/counter/timer", json={"id": tm["id"], "op": "explodir"}).status_code == 400
    c = create(client, name="Normal")
    assert client.post("/counter/timer", json={"id": c["id"], "op": "start"}).status_code == 404


def test_hotkey_action_toggles_timer(client):
    """Via ActionManager (mesmo caminho das hotkeys): inc = play/pause, reset = zerar."""
    tm = create(client, name="Run", type="timer")
    actions = client.server.actions
    assert actions.dispatch("inc", tm["id"], notify=False)["running"] is True
    assert actions.dispatch("dec", tm["id"], notify=False)["running"] is False
    assert actions.dispatch("reset", tm["id"], notify=False)["elapsed"] == 0


# -------------------------------------------------------------------- imagem
def test_set_src(client):
    i = create(client, name="Logo", type="image")
    r = client.post("/counter/src", json={"id": i["id"], "src": "https://exemplo.com/a.png"})
    assert r.json()["counter"]["src"] == "https://exemplo.com/a.png"


def test_upload_png_and_reject_other(client, tmp_storage):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    r = client.post("/assets/upload", files={"file": ("logo.png", io.BytesIO(png), "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert url.startswith("/assets/uploads/") and url.endswith(".png")
    # arquivo foi gravado e é servível
    assert client.get(url).status_code == 200

    r = client.post("/assets/upload", files={"file": ("virus.exe", io.BytesIO(b"x"), "application/x-msdownload")})
    assert r.status_code == 400


# ------------------------------------------------------------------ conversão
def test_convert_type(client):
    c = create(client, name="Meu elemento")
    r = client.post("/counter/type", json={"id": c["id"], "type": "timer"})
    conv = r.json()["counter"]
    assert conv["type"] == "timer" and conv["running"] is False
    # converter para imagem ganha largura padrão
    r = client.post("/counter/type", json={"id": c["id"], "type": "image"})
    assert r.json()["counter"]["style"].get("card_width") == 320
    # volta para contador mantendo nome/posição
    r = client.post("/counter/type", json={"id": c["id"], "type": "counter"})
    back = r.json()["counter"]
    assert back["type"] == "counter" and back["name"] == "Meu elemento"


def test_convert_running_timer_pauses(client):
    tm = create(client, name="Run", type="timer")
    client.post("/counter/timer", json={"id": tm["id"], "op": "start"})
    client.post("/counter/type", json={"id": tm["id"], "type": "text"})
    r = client.post("/counter/type", json={"id": tm["id"], "type": "timer"})
    c = r.json()["counter"]
    assert c["running"] is False and c["started_at"] is None


def test_convert_invalid_type(client):
    c = create(client, name="X")
    assert client.post("/counter/type", json={"id": c["id"], "type": "video"}).status_code == 400
    assert client.post("/counter/type", json={"id": "c-fantasma", "type": "text"}).status_code == 404


# ----------------------------------------------------------------- duplicação
def test_duplicate_keeps_type_and_pauses_timer(client):
    tm = create(client, name="Run", type="timer")
    client.post("/counter/timer", json={"id": tm["id"], "op": "start"})
    r = client.post("/counter/duplicate", json={"id": tm["id"]})
    clone = r.json()["counter"]
    assert clone["type"] == "timer" and clone["running"] is False and clone["started_at"] is None
