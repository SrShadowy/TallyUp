"""Grupos (placar por times): parent, ciclos, exclusão e duplicação."""


def create(client, **kw):
    r = client.post("/counter/create", json=kw)
    assert r.status_code == 200, r.text
    return r.json()["counter"]


def set_parent(client, cid, parent, ok=True):
    r = client.post("/counter/parent", json={"id": cid, "parent": parent})
    if ok:
        assert r.status_code == 200, r.text
        return r.json()["counter"]
    return r


def by_id(client, cid):
    return next((c for c in client.get("/counters").json()["counters"] if c["id"] == cid), None)


# ------------------------------------------------------------------- criação
def test_create_group_and_child(client):
    g = create(client, name="Placar", type="group")
    assert g["type"] == "group" and g["parent"] == ""
    c = create(client, name="Vitórias", parent=g["id"])
    assert c["parent"] == g["id"]


def test_create_with_invalid_parent_falls_back_to_root(client):
    c = create(client, name="X", parent="nao-existe")
    assert c["parent"] == ""
    # pai que não é grupo também não vale
    plain = create(client, name="Normal")
    c2 = create(client, name="Y", parent=plain["id"])
    assert c2["parent"] == ""


def test_nested_groups(client):
    match = create(client, name="Partida", type="group")
    team = create(client, name="Time A", type="group", parent=match["id"])
    wins = create(client, name="Vitórias", parent=team["id"])
    assert team["parent"] == match["id"] and wins["parent"] == team["id"]


# --------------------------------------------------------------- set_parent
def test_set_parent_moves_and_clears(client):
    g = create(client, name="G", type="group")
    c = create(client, name="C")
    assert set_parent(client, c["id"], g["id"])["parent"] == g["id"]
    assert set_parent(client, c["id"], "")["parent"] == ""


def test_set_parent_rejects_non_group(client):
    a = create(client, name="A")
    b = create(client, name="B")
    r = set_parent(client, a["id"], b["id"], ok=False)
    assert r.status_code == 400


def test_set_parent_rejects_self_and_cycle(client):
    g1 = create(client, name="G1", type="group")
    g2 = create(client, name="G2", type="group", parent=g1["id"])
    # dentro de si mesmo
    assert set_parent(client, g1["id"], g1["id"], ok=False).status_code == 400
    # ciclo: G1 dentro de G2 (que já está dentro de G1)
    assert set_parent(client, g1["id"], g2["id"], ok=False).status_code == 400


# ----------------------------------------------------------------- exclusão
def test_delete_group_releases_children(client):
    g = create(client, name="G", type="group")
    a = create(client, name="A", parent=g["id"])
    b = create(client, name="B", parent=g["id"])
    r = client.post("/counter/delete", json={"id": g["id"]})
    assert r.status_code == 200
    ca, cb = by_id(client, a["id"]), by_id(client, b["id"])
    assert ca is not None and cb is not None          # filhos NÃO são apagados
    assert ca["parent"] == "" and cb["parent"] == ""  # voltam para a raiz
    assert ca["y"] != cb["y"]                          # empilhados, não sobrepostos


def test_delete_nested_group_moves_children_up(client):
    outer = create(client, name="Fora", type="group")
    inner = create(client, name="Dentro", type="group", parent=outer["id"])
    c = create(client, name="C", parent=inner["id"])
    client.post("/counter/delete", json={"id": inner["id"]})
    assert by_id(client, c["id"])["parent"] == outer["id"]


def test_convert_group_to_counter_releases_children(client):
    g = create(client, name="G", type="group")
    c = create(client, name="C", parent=g["id"])
    r = client.post("/counter/type", json={"id": g["id"], "type": "counter"})
    assert r.status_code == 200
    assert by_id(client, c["id"])["parent"] == ""


# --------------------------------------------------------------- duplicação
def test_duplicate_group_copies_subtree(client):
    match = create(client, name="Partida", type="group")
    team = create(client, name="Time A", type="group", parent=match["id"])
    create(client, name="Vitórias", value=3, parent=team["id"])

    before = len(client.get("/counters").json()["counters"])
    r = client.post("/counter/duplicate", json={"id": match["id"]})
    assert r.status_code == 200
    clone = r.json()["counter"]
    all_after = client.get("/counters").json()["counters"]
    assert len(all_after) == before + 3               # grupo + time + contador

    teams = [c for c in all_after if c["parent"] == clone["id"]]
    assert len(teams) == 1 and teams[0]["name"] == "Time A"
    kids = [c for c in all_after if c["parent"] == teams[0]["id"]]
    assert len(kids) == 1 and kids[0]["value"] == 3   # valor preservado


def test_duplicate_child_keeps_parent(client):
    g = create(client, name="G", type="group")
    c = create(client, name="C", parent=g["id"])
    r = client.post("/counter/duplicate", json={"id": c["id"]})
    assert r.json()["counter"]["parent"] == g["id"]


# ------------------------------------------------------------- persistência
def test_parent_survives_reload(client):
    g = create(client, name="G", type="group")
    c = create(client, name="C", parent=g["id"])
    client.server.counters.flush()
    client.server.counters.load()
    assert by_id(client, c["id"])["parent"] == g["id"]


def test_load_fixes_orphan_parent(client):
    g = create(client, name="G", type="group")
    c = create(client, name="C", parent=g["id"])
    # simula dado corrompido: pai apontando para id inexistente
    mgr = client.server.counters
    with mgr._lock:
        raw = mgr._find(c["id"])
        raw["parent"] = "fantasma"
        mgr.save()
    mgr.load()
    assert by_id(client, c["id"])["parent"] == ""
