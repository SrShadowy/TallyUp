# TODO — Roadmap detalhado

> Estado em 2026-08-13. Legenda: `[x]` feito · `[ ]` pendente

## Fase 2 — CONCLUÍDA ✅

- [x] Action Manager (ponto único de mutação)
- [x] Hotkeys globais Windows / X11 / Wayland (pynput + evdev)
- [x] Perfis: contadores/tema/hotkeys por perfil (`config/profiles/<slug>/`), seletor no painel, troca em tempo real
- [x] Templates de perfis de jogos (Overwatch, Dark Souls, Valorant, LoL, Minecraft, Speedrun) com contadores prontos + tema; modal de "Novo perfil"
- [x] +5 presets de tema no editor inspirados em jogos
- [x] Backup automático: zip de `config/` em `config/backups/` no startup e a cada 30 min (mantém 10)

### Correções de segurança/robustez (2026-08-13)

- [x] Privacidade: log de hotkeys não registra mais toda tecla digitada (só combos vinculados)
- [x] CORS `*` removido; POSTs e WebSocket rejeitam `Origin` que não seja local
- [x] Save com debounce para mudanças de valor (menos I/O) + `flush()` no shutdown
- [x] Thread-safety no `CounterManager` (RLock — hotkeys × HTTP)
- [x] `lifespan` no lugar do deprecated `on_event`; shutdown limpo (hotkeys, backups, saves)
- [x] Rota `/hotkeys/fix-permissions` religada ao `sysperms` (grupo `input` + setfacl via pkexec/sudo) — sem exigir root
- [x] `hotkeys.log` no `.gitignore`; imports mortos removidos

## Fase 3 — Temas, fontes e ícones

- [x] **Presets do usuário** (2026-08-13): salvar o tema atual como preset nomeado (💾 ao lado do seletor de Preset no Editor); aparecem no grupo "💾 Meus presets" do seletor; excluir pelo 🗑; global entre perfis em `config/theme_presets.json` (chaves de perfil como canvas/winrate ficam de fora); rotas `/theme/presets` (+save/+delete) e testes em `tests/test_theme_presets.py`
- [ ] **Fontes**: upload de `.ttf`/`.woff2` para `assets/fonts/` + `@font-face` dinâmico no overlay e no editor; opcional: integração Google Fonts
- [ ] **Ícones por contador**: emoji ou imagem ao lado do rótulo (campo `icon` no style); upload para `assets/icons/`
- [ ] **Exportar/importar perfil completo** (zip com counters + theme + hotkeys), não só o tema
- [ ] Restaurar backup pelo painel (listar zips de `config/backups/` e aplicar)

## Fase 4 — Theme Editor visual — CONCLUÍDA ✅

- [x] Mover seleção com as setas do teclado (Shift = 10px)
- [x] Multi-seleção (Shift+clique no canvas e na árvore), arrastar em grupo, Delete em grupo
- [x] Alinhar (esquerda/centro/direita/topo/meio/base) e distribuir (h/v) — 1 selecionado alinha ao canvas
- [x] Guias inteligentes entre elementos e com o canvas durante o arrasto
- [x] Alças laterais redimensionam a largura real do card (`card_width`)
- [x] Novas opções de estilo: gradiente de fundo, opacidade, rotação, largura do card, contorno de texto, posição do rótulo (cima/baixo/lados) e alinhamento interno
- [x] Temas do próprio painel: 6 variações (verde/roxo/vermelho × dark/light), seletor no topbar, persistente
- [x] Tamanho do canvas configurável por perfil (presets 1080p/720p/QHD/4K/vertical/quadrado + W×H livre)
- [x] Novos tipos de elemento: **texto livre** (conteúdo editável nas propriedades), **imagem** (URL ou upload para assets/uploads, largura pelas alças) e **timer/cronômetro** (estado no servidor, play/pause/zerar no Controle e no Editor, hotkey de inc vira play/pause)
- [x] Conversão de tipo pelo seletor "Tipo" nas propriedades (rota /counter/type) + tabs por tipo na Estrutura com contagem e filtro

## Fase 5 — Plugins e integrações

- [ ] **Sons**: tocar áudio no overlay ao mudar valor (por contador; upload em `assets/`)
- [ ] **GIFs/animações**: reação visual ao incrementar (ex.: GIF por 2s)
- [x] **VFX**: aba 🎬 com biblioteca de efeitos de mudança de valor — 8 presets embutidos + criação/edição em CSS puro (classe .fx-<id>), preview animado, efeito global e por elemento, rotas /effects
- [x] **Macros de texto no overlay**: %winrate%, %wins%, %losses%, %games% (V/D definidos no Stats, salvos no tema do perfil; fallback por nome)
- [x] **Estatísticas**: modal 📊 Stats no painel — win rate (%) com escolha de contadores V/D (salva por perfil), gráfico da sessão (sparkline por contador), +/− da sessão e sequências de "+" (atual/melhor); rota GET /stats
- [ ] **Webhooks/API de plugins**: disparar/receber HTTP em cada ação (base para qualquer integração)
- [ ] **Stream Deck**: plugin ou perfil de URLs (as rotas REST já bastam — documentar)
- [ ] **Twitch/Kick/YouTube**: incrementar por eventos (sub, follow, bits) ou comando de chat

### Placar por times / grupos — CONCLUÍDO ✅ (2026-08-13)

- [x] **Childs/Groups no placar por times**: novo tipo de elemento **grupo** (`type: "group"`) com campo `parent` em qualquer elemento — estrutura `placar > time_x { wins, losses, draws }` funciona com aninhamento
  - Layout automático dos filhos (coluna/linha + espaçamento + alinhamento) ou **posição livre** (x/y relativos ao grupo) por opção
  - Título opcional (nome do grupo no overlay), mostrar/ocultar o grupo esconde tudo dentro, grupos abrem/fecham na árvore do Editor
  - Mover/excluir/converter grupo: filhos são soltos no canvas (nunca apagados); duplicar grupo copia a subárvore inteira; proteção contra ciclos
  - Atalho pronto **🏆 Placar de partida** no "+ Novo Elemento": cria Placar > Time A / Time B com Vitórias/Derrotas/Empates
  - **CSS personalizado por elemento** (grupos e todos os outros): campo no Editor; declarações soltas valem para o card, seletores (`.value`, `.label`, `&`) para as partes — aplicado no overlay e no canvas com escopo por elemento
  - Rotas novas: `/counter/parent`; `/counter/create` aceita `parent`; +14 testes em `tests/test_groups.py`

### Correções da análise de arquitetura (2026-08-14)

- [x] **Origin na LAN**: `_origin_allowed` agora aceita same-origin dinâmico (host do Origin == host da requisição, HTTP e WS) — servidor em `0.0.0.0` acessado por `http://192.168.x.x:3210` funciona; origens de OUTROS hosts seguem bloqueadas (+2 testes)
- [x] **storage.save_json**: fallback `shutil.move` se `os.replace` der `EXDEV` (defensivo; o `.tmp` nasce na mesma pasta)
- [x] **Broadcast WS concorrente**: `asyncio.gather(..., return_exceptions=True)` — cliente lento/travado não atrasa os demais
- [x] **Prune de backups logado**: falha ao apagar snapshot antigo vai para o log em vez de silêncio
- [x] **Cooldown de hotkeys**: 80ms por combo no disparo (segura auto-repeat/bounce; monitor de teste não é afetado)
- [x] **Ping do cliente**: overlay e painel enviam "ping" a cada 20s (o servidor já respondia "pong") — conexões fantasmas do OBS caem no reconnect
- [ ] **Regra udev persistente** (`/etc/udev/rules.d/99-tallyup-input.rules`) para permissão de leitura do teclado sobreviver a replug — pendente (mexe em arquivo de sistema; avaliar no fluxo do "Corrigir permissões")
- [ ] `content-visibility`/`contain` no overlay — avaliado e adiado: com grupos aninhados e poucos elementos o ganho é marginal e há risco de glitch de renderização no CEF do OBS

## Técnicas / manutenção

- [x] Testes automatizados (pytest + TestClient) — 53 testes em `tests/`; rodar com `pytest`
  - Já pegaram 2 bugs reais: `reorder` era no-op (drag & drop não persistia) e `slugify` gerava hífens duplicados
- [ ] Empacotar executável (PyInstaller) para quem não tem Python
- [x] Unificar versão — fonte única em `backend/__init__.__version__`; configs antigos com "version" são migrados automaticamente
- [ ] Segurar tecla para repetir ação (evdev ignora auto-repeat hoje — decidir se é desejado)
