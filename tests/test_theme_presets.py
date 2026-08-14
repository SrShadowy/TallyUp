"""Presets de tema do usuário: salvar, sobrescrever, excluir e persistir."""


def save(client, name, pid=None, ok=True):
    r = client.post("/theme/presets/save", json={"name": name, "id": pid})
    if ok:
        assert r.status_code == 200, r.text
        return r.json()
    return r


def listing(client):
    return client.get("/theme/presets").json()["presets"]


# ------------------------------------------------------------------- salvar
def test_save_and_list(client):
    client.post("/theme", json={"value_color": "#ff0000", "font_size": 60})
    d = save(client, "Meu Tema")
    assert d["preset"]["id"] == "meu-tema" and d["preset"]["name"] == "Meu Tema"
    ps = listing(client)
    assert len(ps) == 1
    assert ps[0]["theme"]["value_color"] == "#ff0000"
    assert ps[0]["theme"]["font_size"] == 60


def test_save_strips_profile_keys(client):
    client.post("/theme", json={"canvas_width": 1280, "canvas_height": 720,
                                "winrate_w": "abc", "winrate_l": "def"})
    d = save(client, "Sem Perfil")
    t = d["preset"]["theme"]
    for k in ("canvas_width", "canvas_height", "winrate_w", "winrate_l", "name"):
        assert k not in t


def test_save_same_name_overwrites(client):
    client.post("/theme", json={"value_color": "#111111"})
    save(client, "Duplicado")
    client.post("/theme", json={"value_color": "#222222"})
    save(client, "Duplicado")
    ps = listing(client)
    assert len(ps) == 1
    assert ps[0]["theme"]["value_color"] == "#222222"


def test_save_empty_name_rejected(client):
    r = save(client, "   ", ok=False)
    assert r.status_code == 400


def test_save_with_explicit_id_updates(client):
    save(client, "Original")
    d = save(client, "Renomeado", pid="original")
    assert d["preset"]["id"] == "original" and d["preset"]["name"] == "Renomeado"
    assert len(listing(client)) == 1


# ------------------------------------------------------------------ excluir
def test_delete_preset(client):
    save(client, "Apagável")
    r = client.post("/theme/presets/delete", json={"id": "apagavel"})
    assert r.status_code == 200
    assert listing(client) == []


def test_delete_missing_404(client):
    r = client.post("/theme/presets/delete", json={"id": "nao-existe"})
    assert r.status_code == 404


# ------------------------------------------------------------- aplicar/persistir
def test_apply_preset_via_theme_route(client):
    """Aplicar = POST /theme com o theme do preset (como o painel faz)."""
    client.post("/theme", json={"value_color": "#00ff00"})
    p = save(client, "Verde")["preset"]
    client.post("/theme", json={"value_color": "#ffffff"})
    client.post("/theme", json=p["theme"])
    assert client.get("/theme").json()["value_color"] == "#00ff00"


def test_presets_survive_reload(client):
    save(client, "Persistente")
    mgr = client.server.theme_presets
    mgr.load()
    assert mgr.get("persistente") is not None


def test_presets_are_global_across_profiles(client):
    save(client, "Global")
    client.post("/profiles/create", json={"name": "Outro"})
    client.post("/profiles/switch", json={"name": "outro"})
    assert any(p["id"] == "global" for p in listing(client))
