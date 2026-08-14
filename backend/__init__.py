"""Pacote backend do TallyUp.

Módulos:
    storage   -> leitura/escrita atômica de JSON + backup
    config    -> configurações gerais do app
    counter   -> gerenciamento dos contadores (CRUD, reordenar, visibilidade)
    themes    -> tema visual do overlay
    websocket -> gerenciador de conexões WebSocket (broadcast)
    profiles  -> (Fase 2) múltiplos perfis de contadores
    hotkeys   -> (Fase 2) atalhos globais
"""

__version__ = "1.0.0"
