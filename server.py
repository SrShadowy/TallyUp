"""TallyUp — servidor local com FastAPI e WebSocket.

Como rodar:
    python server.py

Depois abre:
    Painel: http://127.0.0.1:3210/admin
    Overlay: http://127.0.0.1:3210/overlay

Tudo fica só em localhost. Sem nuvem, sem banco e sem login.
"""

from __future__ import annotations

import argparse
import os
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import uuid

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from backend import __version__, sysperms
from backend.actions import ActionManager
from backend.backup import BackupScheduler
from backend.config import ConfigManager
from backend.counter import CounterManager
from backend.effects import EffectsManager
from backend.hotkeys import HotkeyManager
from backend.logger import init_log
from backend.profiles import ProfileManager
from backend.theme_presets import ThemePresetsManager
from backend.themes import ThemeManager
from backend.websocket import ConnectionManager

init_log()

# ---------------------------------------------------------------------------
# Modo debug: ativa o registro de teclas para testar hotkeys sem abrir o painel.
# Isso grava tudo que for digitado no sistema, então é só para depuração.
# Também pode ser ligado com a env: TALLYUP_DEBUG=1.
# ---------------------------------------------------------------------------
DEBUG = os.environ.get("TALLYUP_DEBUG", "").strip() not in ("", "0", "false", "no")

# ---------------------------------------------------------------------------
# Caminhos
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
ADMIN_DIR = BASE_DIR / "admin"
OVERLAY_DIR = BASE_DIR / "overlay"
ASSETS_DIR = BASE_DIR / "assets"

# ---------------------------------------------------------------------------
# Gerenciadores do app
# ---------------------------------------------------------------------------
config = ConfigManager()
counters = CounterManager()
themes = ThemeManager()
hotkeys = HotkeyManager()
ws_manager = ConnectionManager()
backups = BackupScheduler()
effects = EffectsManager()   # biblioteca global de efeitos visuais
theme_presets = ThemePresetsManager()   # presets de tema salvos pelo usuário (global)
# Ponto único para mudar valores: botões, hotkeys e futuras integrações usam isso.
actions = ActionManager(counters)

# Se o perfil ativo não for o padrão, muda os arquivos usados por esse perfil
# antes de o app começar a servir o painel e o overlay.
profiles = ProfileManager(active=str(config.get("active_profile", "default")))


def _apply_profile_paths() -> None:
    p = profiles.current()
    counters.set_path(profiles.path(p, "counters.json"))
    themes.set_path(profiles.path(p, "theme.json"))
    hotkeys.set_path(profiles.path(p, "hotkeys.json"))


if profiles.current() != "default":
    _apply_profile_paths()

@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _startup()
    try:
        yield
    finally:
        # Fecha hotkeys, para backups e salva tudo pendente antes de sair.
        hotkeys.stop()
        backups.stop()
        counters.flush()


app = FastAPI(title="TallyUp", version=__version__, lifespan=lifespan)

# O painel e o overlay ficam no mesmo servidor, então não abrimos CORS livre.
# Isso evita que sites externos controlem o app. Posts com Origin fora do localhost
# são bloqueados. Requisições sem Origin continuam funcionando (curl, scripts locais).
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _origin_allowed(origin: Optional[str], request_host: Optional[str] = None) -> bool:
    """Valida o Origin de POSTs e do WebSocket.

    Além de localhost e do host configurado, aceita o caso SAME-ORIGIN
    dinâmico: o host do Origin é o MESMO host pelo qual a requisição chegou.
    Isso cobre o servidor escutando em 0.0.0.0 e acessado pela rede local
    (ex.: painel num tablet ou OBS em outro PC via http://192.168.x.x:3210)
    sem liberar páginas de outros sites/dispositivos.
    """
    if not origin:
        return True  # clientes não-navegador não enviam Origin
    try:
        from urllib.parse import urlparse
        host = urlparse(origin).hostname
        if host is None:
            return False
        return host in _LOCAL_HOSTS or host == config.host or (request_host is not None and host == request_host)
    except Exception:
        return False


@app.middleware("http")
async def origin_guard(request, call_next):
    if request.method == "POST" and not _origin_allowed(request.headers.get("origin"), request.url.hostname):
        return JSONResponse({"detail": "Origem não permitida"}, status_code=403)
    response = await call_next(request)
    # Evita cache antigo no navegador e no OBS. Assim o painel/overlay sempre
    # recarrega a versão mais recente sem dor de cabeça.
    p = request.url.path
    if request.method == "GET" and (p == "/" or p.startswith(("/admin", "/overlay", "/assets"))):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# Modelos de requisição
# ---------------------------------------------------------------------------
class CreateBody(BaseModel):
    name: str = "Novo Contador"
    value: int = 0
    step: int = 1
    type: str = "counter"    # counter | text | image | timer | group
    src: str = ""            # imagem: URL inicial
    parent: str = ""         # id de um grupo ("" = raiz do canvas)


class IdBody(BaseModel):
    id: str


class SetValueBody(BaseModel):
    id: str
    value: int


class AmountBody(BaseModel):
    id: str
    amount: Optional[int] = None


class RenameBody(BaseModel):
    id: str
    name: str


class StepBody(BaseModel):
    id: str
    step: int


class StyleBody(BaseModel):
    id: str
    style: dict[str, Any] = {}
    merge: bool = True


class PositionBody(BaseModel):
    id: str
    x: float
    y: float


class LockBody(BaseModel):
    id: str
    locked: bool


class VisibilityBody(BaseModel):
    id: str
    visible: Optional[bool] = None


class MoveBody(BaseModel):
    id: str
    direction: str  # "up" | "down"


class ReorderBody(BaseModel):
    order: list[str]


class HotkeysBody(BaseModel):
    enabled: Optional[bool] = None
    bindings: Optional[dict[str, Any]] = None


class HotkeyBindingBody(BaseModel):
    id: str
    action: str            # "inc" | "dec" | "reset"
    keys: str = ""         # "" limpa o atalho


class MonitorBody(BaseModel):
    on: bool = False


class HotkeysDevicesBody(BaseModel):
    devices: list[str] = []


class FixPermsBody(BaseModel):
    password: Optional[str] = None   # None -> usa pkexec (diálogo do sistema)


class ProfileBody(BaseModel):
    name: str
    template: Optional[str] = None   # só usado no /profiles/create


class TimerBody(BaseModel):
    id: str
    op: str                          # start | pause | toggle | reset


class SrcBody(BaseModel):
    id: str
    src: str = ""


class TypeBody(BaseModel):
    id: str
    type: str                        # counter | text | image | timer | group


class ParentBody(BaseModel):
    id: str
    parent: str = ""                 # id de um grupo ("" = raiz do canvas)


class EffectSaveBody(BaseModel):
    id: Optional[str] = None         # None -> novo (slug do nome)
    name: str
    css: str


class EffectIdBody(BaseModel):
    id: str


class PresetSaveBody(BaseModel):
    id: Optional[str] = None         # None -> novo (slug do nome)
    name: str


class PresetIdBody(BaseModel):
    id: str


# ---------------------------------------------------------------------------
# Broadcast helpers
# ---------------------------------------------------------------------------
async def push_counters() -> None:
    await ws_manager.broadcast({"type": "counters", "data": counters.list()})


async def push_theme() -> None:
    await ws_manager.broadcast({"type": "theme", "data": themes.get()})


async def push_hotkeys() -> None:
    await ws_manager.broadcast({"type": "hotkeys", "data": hotkeys.status()})


def _profiles_payload() -> dict[str, Any]:
    return {"profiles": profiles.list(), "active": profiles.current()}


async def push_profiles() -> None:
    await ws_manager.broadcast({"type": "profiles", "data": _profiles_payload()})


async def push_effects() -> None:
    await ws_manager.broadcast({"type": "effects", "data": effects.list()})


# O Action Manager notifica o WebSocket via esta fábrica de corrotina.
actions.set_push(lambda: ws_manager.broadcast({"type": "counters", "data": counters.list()}))


def _require(counter: Optional[dict[str, Any]]) -> dict[str, Any]:
    if counter is None:
        raise HTTPException(status_code=404, detail="Contador não encontrado")
    return counter


# ---------------------------------------------------------------------------
# Rotas GET (leitura)
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__, "clients": ws_manager.count}


@app.get("/counters")
async def get_counters() -> dict[str, Any]:
    return {"counters": counters.list()}


@app.get("/config")
async def get_config() -> dict[str, Any]:
    # Não expõe nada sensível — é tudo config local mesmo.
    return config.data


@app.get("/theme")
async def get_theme() -> dict[str, Any]:
    return themes.get()


@app.get("/effects")
async def get_effects() -> dict[str, Any]:
    return {"effects": effects.list()}


@app.post("/effects/save")
async def effects_save(body: EffectSaveBody) -> dict[str, Any]:
    """Cria ou atualiza um preset de efeito (VFX)."""
    try:
        entry = effects.upsert(body.name, body.css, effect_id=body.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await push_effects()
    return {"ok": True, "effect": entry, "effects": effects.list()}


@app.post("/effects/delete")
async def effects_delete(body: EffectIdBody) -> dict[str, Any]:
    if not effects.delete(body.id):
        raise HTTPException(status_code=404, detail="Efeito não encontrado")
    await push_effects()
    return {"ok": True, "effects": effects.list()}


@app.post("/effects/reset")
async def effects_reset() -> dict[str, Any]:
    """Restaura os efeitos padrão (mantém os personalizados)."""
    effects.reset()
    await push_effects()
    return {"ok": True, "effects": effects.list()}


_START_TS = time.time()


@app.get("/stats")
async def get_stats() -> dict[str, Any]:
    """Histórico de eventos da sessão (base do painel de estatísticas)."""
    return {"ok": True, "started": _START_TS, "events": actions.events}


# ---------------------------------------------------------------------------
# Rotas POST (contadores)
# ---------------------------------------------------------------------------
@app.post("/counter/create")
async def counter_create(body: CreateBody) -> dict[str, Any]:
    counter = counters.create(name=body.name, value=body.value, step=body.step,
                              el_type=body.type, src=body.src, parent=body.parent)
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/parent")
async def counter_parent(body: ParentBody) -> dict[str, Any]:
    """Move um elemento para dentro de um grupo ('' = raiz do canvas)."""
    try:
        counter = _require(counters.set_parent(body.id, body.parent))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/timer")
async def counter_timer(body: TimerBody) -> dict[str, Any]:
    """Controla um cronômetro: start | pause | toggle | reset."""
    if body.op not in ("start", "pause", "toggle", "reset"):
        raise HTTPException(status_code=400, detail="op deve ser start, pause, toggle ou reset")
    counter = _require(counters.timer_op(body.id, body.op))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/type")
async def counter_type(body: TypeBody) -> dict[str, Any]:
    """Converte um elemento existente para outro tipo."""
    if body.type not in ("counter", "text", "image", "timer", "group"):
        raise HTTPException(status_code=400, detail="type deve ser counter, text, image, timer ou group")
    counter = _require(counters.set_type(body.id, body.type))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/src")
async def counter_src(body: SrcBody) -> dict[str, Any]:
    """Define a imagem (URL ou caminho retornado pelo /assets/upload)."""
    counter = _require(counters.set_src(body.id, body.src))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/assets/upload")
async def assets_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    """Recebe uma imagem e salva em assets/uploads/; retorna a URL local."""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
        raise HTTPException(status_code=400, detail="Formato não suportado (png, jpg, gif, webp, svg).")
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Imagem muito grande (máximo 10 MB).")
    dest_dir = ASSETS_DIR / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex[:12] + ext
    (dest_dir / name).write_bytes(data)
    return {"ok": True, "url": f"/assets/uploads/{name}"}


@app.post("/counter/delete")
async def counter_delete(body: IdBody) -> dict[str, Any]:
    if not counters.delete(body.id):
        raise HTTPException(status_code=404, detail="Contador não encontrado")
    hotkeys.remove_counter(body.id)   # limpa atalhos órfãos
    await push_counters()
    await push_hotkeys()
    return {"ok": True, "counters": counters.list()}


# Estas 4 rotas passam pelo Action Manager (mesma lógica das hotkeys).
@app.post("/counter/set")
async def counter_set(body: SetValueBody) -> dict[str, Any]:
    counter = _require(actions.dispatch("set", body.id, value=body.value, notify=False))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/inc")
async def counter_inc(body: AmountBody) -> dict[str, Any]:
    counter = _require(actions.dispatch("inc", body.id, amount=body.amount, notify=False))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/dec")
async def counter_dec(body: AmountBody) -> dict[str, Any]:
    counter = _require(actions.dispatch("dec", body.id, amount=body.amount, notify=False))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/reset")
async def counter_reset(body: IdBody) -> dict[str, Any]:
    counter = _require(actions.dispatch("reset", body.id, notify=False))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/rename")
async def counter_rename(body: RenameBody) -> dict[str, Any]:
    counter = _require(counters.rename(body.id, body.name))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/step")
async def counter_step(body: StepBody) -> dict[str, Any]:
    counter = _require(counters.set_step(body.id, body.step))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/style")
async def counter_style(body: StyleBody) -> dict[str, Any]:
    counter = _require(counters.set_style(body.id, body.style, merge=body.merge))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/position")
async def counter_position(body: PositionBody) -> dict[str, Any]:
    counter = _require(counters.set_position(body.id, body.x, body.y))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/lock")
async def counter_lock(body: LockBody) -> dict[str, Any]:
    counter = _require(counters.set_lock(body.id, body.locked))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/duplicate")
async def counter_duplicate(body: IdBody) -> dict[str, Any]:
    counter = _require(counters.duplicate(body.id))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/visibility")
async def counter_visibility(body: VisibilityBody) -> dict[str, Any]:
    if body.visible is None:
        counter = _require(counters.toggle_visibility(body.id))
    else:
        counter = _require(counters.set_visibility(body.id, body.visible))
    await push_counters()
    return {"ok": True, "counter": counter, "counters": counters.list()}


@app.post("/counter/move")
async def counter_move(body: MoveBody) -> dict[str, Any]:
    if body.direction not in ("up", "down"):
        raise HTTPException(status_code=400, detail="direction deve ser 'up' ou 'down'")
    result = counters.move(body.id, body.direction)
    await push_counters()
    return {"ok": True, "counters": result}


@app.post("/counter/reorder")
async def counter_reorder(body: ReorderBody) -> dict[str, Any]:
    result = counters.reorder(body.order)
    await push_counters()
    return {"ok": True, "counters": result}


# ---------------------------------------------------------------------------
# Rotas POST (tema)
# ---------------------------------------------------------------------------
@app.post("/theme")
async def theme_update(values: dict[str, Any]) -> dict[str, Any]:
    data = themes.update(values)
    await push_theme()
    return {"ok": True, "theme": data}


@app.post("/theme/reset")
async def theme_reset() -> dict[str, Any]:
    data = themes.reset()
    await push_theme()
    return {"ok": True, "theme": data}


# ---------------------------------------------------------------------------
# Presets de tema do usuário (Fase 3)
# ---------------------------------------------------------------------------
async def push_theme_presets() -> None:
    await ws_manager.broadcast({"type": "theme_presets", "data": theme_presets.list()})


@app.get("/theme/presets")
async def get_theme_presets() -> dict[str, Any]:
    return {"presets": theme_presets.list()}


@app.post("/theme/presets/save")
async def theme_presets_save(body: PresetSaveBody) -> dict[str, Any]:
    """Salva o TEMA ATUAL do perfil como preset nomeado (global)."""
    try:
        entry = theme_presets.upsert(body.name, themes.get(), preset_id=body.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await push_theme_presets()
    return {"ok": True, "preset": entry, "presets": theme_presets.list()}


@app.post("/theme/presets/delete")
async def theme_presets_delete(body: PresetIdBody) -> dict[str, Any]:
    if not theme_presets.delete(body.id):
        raise HTTPException(status_code=404, detail="Preset não encontrado")
    await push_theme_presets()
    return {"ok": True, "presets": theme_presets.list()}


# ---------------------------------------------------------------------------
# Rotas de Hotkeys (Fase 2)
# ---------------------------------------------------------------------------
@app.get("/hotkeys")
async def get_hotkeys() -> dict[str, Any]:
    return hotkeys.status()


@app.post("/hotkeys")
async def hotkeys_update(body: HotkeysBody) -> dict[str, Any]:
    from backend import logger
    logger.log("route /hotkeys: enabled={} bindings={} entries", body.enabled, len(body.bindings or {}))
    hotkeys.set_all(enabled=body.enabled, bindings=body.bindings)
    await push_hotkeys()
    return {"ok": True, **hotkeys.status()}


@app.post("/hotkeys/binding")
async def hotkeys_binding(body: HotkeyBindingBody) -> dict[str, Any]:
    from backend import logger
    logger.log("route /hotkeys/binding: id={} action={} keys={}", body.id, body.action, body.keys)
    if body.action not in ("inc", "dec", "reset"):
        raise HTTPException(status_code=400, detail="action inválida")
    hotkeys.set_binding(body.id, body.action, body.keys)
    await push_hotkeys()
    return {"ok": True, **hotkeys.status()}


@app.post("/hotkeys/monitor")
async def hotkeys_monitor(body: MonitorBody) -> dict[str, Any]:
    """Liga/desliga a detecção de teclas (ajuda a configurar no Wayland)."""
    from backend import logger
    logger.log("route /hotkeys/monitor: on={}", body.on)
    return {"ok": True, **hotkeys.set_monitor(body.on)}


@app.post("/hotkeys/devices")
async def hotkeys_devices(body: HotkeysDevicesBody) -> dict[str, Any]:
    from backend import logger
    logger.log("route /hotkeys/devices: devices={}", body.devices)
    result = hotkeys.set_devices(body.devices)
    await push_hotkeys()
    return {"ok": True, **result}


@app.post("/hotkeys/fix-permissions")
async def hotkeys_fix_permissions(body: FixPermsBody) -> dict[str, Any]:
    """Corrige a permissão de leitura de /dev/input.

    Adiciona o usuário ao grupo 'input' (persistente) e tenta um setfacl para
    liberar a leitura já nesta sessão. password=None usa pkexec (diálogo do
    sistema); com senha, usa sudo -S. Roda em threadpool (subprocess bloqueante).
    """
    result = await run_in_threadpool(sysperms.fix_input_permissions, body.password)
    if result.get("ok"):
        hotkeys.reload()
    await push_hotkeys()
    return {"fix": result, **hotkeys.status()}


# ---------------------------------------------------------------------------
# Rotas de Perfis (Fase 2)
# ---------------------------------------------------------------------------
@app.get("/profiles")
async def get_profiles() -> dict[str, Any]:
    return _profiles_payload()


@app.get("/profiles/templates")
async def get_profile_templates() -> dict[str, Any]:
    """Templates prontos de jogos (Overwatch, Dark Souls, ...)."""
    from backend.profiles import templates_payload
    return {"templates": templates_payload()}


@app.post("/profiles/create")
async def profiles_create(body: ProfileBody) -> dict[str, Any]:
    """Cria um perfil: cópia do ativo, ou de um template de jogo."""
    try:
        slug = profiles.create(body.name, template=body.template)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await push_profiles()
    return {"ok": True, "profile": slug, **_profiles_payload()}


@app.post("/profiles/switch")
async def profiles_switch(body: ProfileBody) -> dict[str, Any]:
    """Troca o perfil ativo: recarrega contadores, tema e hotkeys e notifica todos."""
    try:
        profiles.switch(body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    config.set("active_profile", profiles.current())
    _apply_profile_paths()
    await push_counters()
    await push_theme()
    await push_hotkeys()
    await push_profiles()
    return {"ok": True, **_profiles_payload()}


@app.post("/profiles/delete")
async def profiles_delete(body: ProfileBody) -> dict[str, Any]:
    try:
        profiles.delete(body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await push_profiles()
    return {"ok": True, **_profiles_payload()}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # Mesmo guarda de origem do HTTP: impede que páginas de terceiros abram o
    # WebSocket e recebam eventos (ex.: hotkey_detected).
    if not _origin_allowed(websocket.headers.get("origin"), websocket.url.hostname):
        await websocket.close(code=4403)
        return
    await ws_manager.connect(websocket)
    # Snapshot inicial: cliente já desenha tudo sem esperar nenhum evento.
    await ws_manager.send_personal(
        {
            "type": "init",
            "counters": counters.list(),
            "theme": themes.get(),
            "hotkeys": hotkeys.status(),
            "profiles": _profiles_payload(),
            "effects": effects.list(),
            "theme_presets": theme_presets.list(),
        },
        websocket,
    )
    try:
        while True:
            # Mantém a conexão viva e detecta desconexão.
            # Aceita um "ping" opcional do cliente e responde "pong".
            msg = await websocket.receive_text()
            if msg == "ping":
                await ws_manager.send_personal({"type": "pong"}, websocket)
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception:
        await ws_manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Páginas e arquivos estáticos
# ---------------------------------------------------------------------------
@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/admin/")


@app.get("/favicon.ico")
async def favicon():
    icon = ASSETS_DIR / "icons" / "favicon.ico"
    if icon.exists():
        return FileResponse(icon)
    return RedirectResponse(url="/admin/")


# Monta as pastas do painel, do overlay e dos assets como arquivos estáticos.
# html=True faz "/admin/" servir automaticamente o index.html.
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.mount("/overlay", StaticFiles(directory=str(OVERLAY_DIR), html=True), name="overlay")
app.mount("/admin", StaticFiles(directory=str(ADMIN_DIR), html=True), name="admin")


# ---------------------------------------------------------------------------
# Inicialização
# ---------------------------------------------------------------------------
async def _startup() -> None:
    import asyncio
    counters.ensure_example()          # primeira execução: cria "Mortes"
    await push_counters()

    if config.get("first_run", True):
        config.set("first_run", False)

    # Se o perfil salvo não existia mais, sincroniza o fallback no config.json.
    if config.get("active_profile") != profiles.current():
        config.set("active_profile", profiles.current())

    # Backup automático: snapshot no startup e a cada 30 min (mantém os 10 últimos).
    backups.start()

    # Action Manager precisa do event loop para notificar o WebSocket a partir
    # da thread do listener de hotkeys.
    actions.set_loop(asyncio.get_running_loop())

    # Liga o listener global de hotkeys (se habilitado e o SO permitir).
    loop = asyncio.get_running_loop()

    def _hotkey_dispatch(action: str, counter_id: str) -> None:
        actions.dispatch(action, counter_id)   # notify=True -> agenda broadcast

    def _hotkey_detected(combo: str) -> None:
        try:
            asyncio.run_coroutine_threadsafe(
                ws_manager.broadcast({"type": "hotkey_detected", "combo": combo}), loop)
        except Exception:
            pass

    hotkeys.set_monitor_cb(_hotkey_detected)
    hotkeys.start(_hotkey_dispatch)

    # --debug: liga o modo teste desde já (loga cada tecla detectada).
    if DEBUG:
        from backend import logger
        logger.log("MODO DEBUG ativo — monitor de teclas LIGADO (loga toda tecla detectada).")
        hotkeys.set_monitor(True)

    host, port = config.host, config.port
    _print_banner(host, port)
    _print_hotkeys_status()
    _maybe_fix_hotkey_permissions()

    if config.get("auto_open_browser", True):
        _open_browser_soon(host, port)


def _print_hotkeys_status() -> None:
    be = hotkeys.backend or "—"
    if not hotkeys.available:
        print(f"   Hotkeys globais: indisponíveis ({hotkeys.last_error}).")
    elif hotkeys.get().get("enabled") and hotkeys.active:
        print(f"   Hotkeys globais: ATIVAS ✓ (backend: {be})")
    elif hotkeys.get().get("enabled") and not hotkeys.active:
        print(f"   Hotkeys globais: habilitadas, mas inativas ({hotkeys.last_error or 'verifique permissões'})")
    else:
        print(f"   Hotkeys globais: desligadas (backend disponível: {be}). Ative no painel em ⌨ Hotkeys.")


def _maybe_fix_hotkey_permissions() -> None:
    perm = hotkeys.status().get("perm") or {}
    if not perm.get("linux") or perm.get("is_root") or not perm.get("needs_fix"):
        return
    print("   Hotkeys globais: falta permissão para ler /dev/input.")
    print("   Corrija pelo painel (⌨ Hotkeys → Corrigir permissões) ou rode:")
    print("   sudo usermod -aG input $USER   (e refaça login)")


def _print_banner(host: str, port: int) -> None:
    url_admin = f"http://{host}:{port}/admin"
    url_overlay = f"http://{host}:{port}/overlay"
    line = "═" * 54
    print(f"""
╔{line}╗
   TallyUp  v{__version__}
   Painel  : {url_admin}
   Overlay : {url_overlay}
   (adicione o Overlay como Fonte de Navegador no OBS)
   Pressione CTRL+C para encerrar.
╚{line}╝
""")
    if DEBUG:
        print("   ⚠ MODO DEBUG: o monitor de teclas está LIGADO — o hotkeys.log")
        print("     registra TODA tecla digitada no sistema. Use só para depurar.\n")


def _open_browser_soon(host: str, port: int, delay: float = 1.0) -> None:
    url = f"http://{host}:{port}/admin"

    def _open() -> None:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Timer(delay, _open).start()


# ---------------------------------------------------------------------------
# Entrada principal
# ---------------------------------------------------------------------------
def main() -> None:
    global DEBUG
    parser = argparse.ArgumentParser(
        prog="server.py",
        description="TallyUp — overlay de contagem ao vivo para OBS.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="modo diagnóstico: liga o monitor de teclas e grava toda tecla "
             "detectada em hotkeys.log (útil para depurar atalhos). Use só para depurar.",
    )
    args = parser.parse_args()
    if args.debug:
        DEBUG = True

    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level="debug" if DEBUG else "info",
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )


if __name__ == "__main__":
    main()
