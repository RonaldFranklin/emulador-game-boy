# Validação das entregas locais

Histórico iniciado em 29/09/2026. Ambiente: Ubuntu 24.04/WSL2, daemon local Docker Desktop, Engine 29.5.3 e Compose 5.1.4. Resultados locais por etapa; não comprovam uma implantação remota nem alterações posteriores.

As seções iniciais preservam evidências históricas. A entrega do player está em [Emulação GB/GBA e save nativo](#emulação-gbgba-e-save-nativo--29092026). A nova alteração de bootstrap tem registro separado em [Bootstrap e documentação pública](#bootstrap-e-documentação-pública--30092026).

## Ambiente e preservação

- Pasta vigente e documentos lidos antes da implementação.
- Git encontrado em `main`, sem commits, com documentação ainda não rastreada; configuração e histórico preservados.
- Daemon identificado por `docker context show`, `docker version` e `docker info` como Docker Desktop local. Containers/volumes preexistentes de outros projetos listados antes da operação e preservados.
- Porta 5173 conferida no WSL e no Windows antes de usar; aplicação publicada apenas em `127.0.0.1:5173`.
- Novo volume exclusivo: `emulador-game-boy-dev_postgres_data`. Nenhum volume anterior foi apagado. Bancos/containers efêmeros criados pelos testes são os únicos removidos pelos próprios testes.
- Segredos aleatórios em `.local/secrets/` e `.env` ignorados pelo Git. Não foram adicionadas contas padrão, seeds ou senhas a arquivos versionáveis.

## Comandos e resultados

| Verificação | Resultado |
| --- | --- |
| `npm ci` | Instalação a partir do lockfile concluída |
| `npm run build` | Backend TypeScript e frontend TypeScript/Vite aprovados |
| `npm run typecheck` | Ambos os workspaces aprovados |
| `npm audit --audit-level=low` | Zero vulnerabilidades reportadas nesta execução |
| `npm run setup` repetido | Credenciais existentes e `.env` preservados |
| `docker compose config --quiet` | Configuração válida |
| `docker compose build` / `docker compose up -d` | API/banco saudáveis; migração concluída; frontend iniciado |
| `docker compose run --rm migrate` | Reexecução sem reaplicar a migração existente |
| `docker compose stop` / `docker compose start` | Serviços retomados; volume e banco preservados |
| `curl --fail http://127.0.0.1:5173/api/health` | HTTP 200, `{"status":"ok"}` |
| `docker compose run --rm test` | **18 testes aprovados**, zero falhas; última rodada 12,86 s |
| `docker compose build test-browser` / `npm run test:browser` | **1 cenário completo aprovado**, 6,6 s, Chromium em container, desktop e celular |
| `npm run test:operations` | Bootstrap oculto, reinício real, backup populado e recuperação aprovados |
| `npm run backup` | Dump do banco de desenvolvimento e SHA-256 criados |
| `npm run restore:verify -- <dump>` | Restauração isolada aprovada, banco ativo preservado |

Capturas geradas em `.local/screenshots/` e inspecionadas: login desktop e biblioteca em 390 × 844, sem transbordamento horizontal. O cenário de navegador cobre login, criação, troca obrigatória, reinício da API com cookie preservado, redefinição, bloqueio, desbloqueio, revogação, 401/403 e logout. Não usa credenciais reais nem expõe portas do container de navegador.

## Segurança e persistência exercitadas

A suíte de integração usa banco novo de nome aleatório, PostgreSQL real e HTTP real. Verifica:

- Recursos protegidos retornando 401 sem sessão ou com cookie forjado/expirado.
- Origem incorreta/ausente, ausência do cabeçalho AJAX e CSRF ausente, incorreto ou de outra sessão rejeitados.
- Regressão HTTP dedicada: CSRF não ASCII com mesmo comprimento JavaScript do token válido e tamanho UTF-8 diferente retorna 403; a sessão original continua válida (GET da própria sessão retorna 200).
- Validação de nomes, senhas, tipos, campos extras, duplicatas e tentativa de criar perfil master pela API.
- Senha temporária limitada a consulta da própria sessão, troca e logout.
- Jogador sem acesso a listagem/administração e sem poder alterar senha de outra conta; master com biblioteca e administração.
- Logout revogando a sessão atual; troca de senha, redefinição e bloqueio revogando sessões de vários aparelhos.
- Desbloqueio sem reativação de cookies antigos; master protegido e ausência de exclusão.
- Hash Argon2id com parâmetros esperados e somente hash do token de sessão no banco.
- Reinício da aplicação mantendo contas e sessões; vencimento de sessão rejeitado.
- Limitação por nome e IP persistida, janela de expiração e rejeição de IP forjado por cabeçalhos de proxy.
- Login concorrente a bloqueio/redefinição usando travas reais PostgreSQL: credencial antiga não cria sessão após a revogação.

O teste operacional cria duas contas fictícias, usa o bootstrap real via PTY sem eco de senha, cria duas sessões e reinicia **o container PostgreSQL e a API de teste**. Os cookies anteriores continuam funcionando, a lista de contas permanece igual e as contagens/conteúdo conferem. A base ativa de desenvolvimento não recebe essas contas. Não sobraram bases efêmeras após o ensaio.

O dump populado de teste foi restaurado em outro container PostgreSQL, sem rede, porta publicada ou volume persistente. Foram comparados dois usuários, duas sessões, histórico de migração e uma assinatura do conteúdo completo das linhas de usuário. A recuperação operacional criou outro banco, manteve as duas contas, revogou as sessões e conferiu dono `emulador` no banco e tabelas. O backend real usando esse papel de aplicação confirmou cookie anterior recusado (401), login com a senha original (200), listagem administrativa e logout (204). Bases de teste/recuperação e API efêmera foram removidas; o dump e checksum de evidência permanecem em `.local/backups/`, ignorados pelo Git.

## Inicialização limpa e imagens

A inicialização PostgreSQL final também foi validada em container novo, sem rede e com armazenamento temporário: papel `emulador` pode autenticar por senha e criar/escrever tabelas no próprio esquema, mas não é superusuário, não cria papéis nem bancos. Dono do banco/esquema correto e `CREATE` revogado de `PUBLIC`. O container foi removido após a verificação; nenhum volume existente foi usado.

Tags e digests obtidos nesta execução (tags de versão fixadas no código; digests registrados para auditoria):

| Imagem | Digest |
| --- | --- |
| `node:24.21.0-bookworm-slim` | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` |
| `postgres:18.6-bookworm` | `sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650` |
| `mcr.microsoft.com/playwright:v1.63.0-noble` | `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` |

## Achados corrigidos e limitações

- Revisão CSRF do coordenador: a validação do formato ASCII/base64url já rejeitava Unicode. A comparação foi reforçada com buffers UTF-8 e verificação explícita dos tamanhos em bytes antes de `timingSafeEqual`, sem depender de comprimento de string. Build e tipos do backend, 17 testes de API e cenário de navegador reaprovados após essa revisão.

- Arquivo secreto inicialmente `0600` não era legível pelo UID PostgreSQL. Pasta privada `0700` e arquivos montados `0644` resolvem a leitura; o volume parcialmente inicializado foi preservado e completado. O ensaio limpo posterior passou.
- Rede Docker marcada como interna em todos os serviços não publicou a porta no daemon local. Uma segunda rede foi atribuída ao frontend, mantendo backend/banco privados e publicação somente em loopback.
- O teste inicial de hash presumia ordem fixa dos parâmetros Argon2; corrigido para conferir valores independentemente da ordem, sem divulgar hashes em falhas.
- `pg_isready` usa TCP em loopback para não considerar pronto o servidor temporário de inicialização PostgreSQL.
- Senha atual incorreta devolve 400 e preserva a sessão; 401 permanece para sessão/credenciais de login inválidas.
- Chromium no host não iniciou por bibliotecas Linux ausentes; sudo exigiu senha indisponível. Nenhum controle administrativo foi contornado. A suíte visual foi transferida para imagem oficial Playwright, usando os containers locais autorizados.

Permanecem fora desta entrega: emulador, ROMs, catálogo administrável, saves, conflitos/continuidade de progresso, implantação remota/HTTPS, recuperação de senha de master, paginação/escala e trilha completa de auditoria. Backup externo criptografado, retenção automática, RPO/RTO e restauração em outra máquina ainda precisam ser definidos e exercitados antes de uso real. A política local é manual e não substitui essa etapa.


## Compatibilidade de credenciais legadas — 29/09/2026

Separadas as validações de autenticação e novas senhas. Login e senha atual aceitam credenciais existentes não vazias de até 128 caracteres; criação, reset, bootstrap e nova senha continuam exigindo 12–128. A regressão usa uma senha curta aleatória exclusivamente em base isolada: login funciona, senha atual curta permite definir uma nova forte, sessões anteriores são revogadas, entradas vazias/longas e criação/reset/nova senha curta são recusados. Suíte final dessa etapa: 18 testes aprovados, zero falhas (12,86 s). Build do backend e tipos de ambos os workspaces aprovados.

Os campos do frontend foram conferidos: login/senha atual usam `required` e `maxLength=128`; novas senhas mantêm `minLength=12`. Verificações com Chromium e API real confirmaram 200 para listagem administrativa por MASTER, 403 para JOGADOR e encerramento de sessões pelo logout. Nenhuma credencial foi incluída na documentação distribuída.

## Tema claro/escuro — 29/09/2026

Etapa autorizada somente para o frontend após o usuário aprovar o login. Pasta e contexto `default` conferidos, daemon `docker-desktop | Docker Desktop`; porta 5173 já pertencia ao frontend deste projeto em loopback. Contas reais, autenticação, migrações, banco e volumes não receberam alterações nesta etapa.

| Comando/verificação | Resultado desta etapa |
| --- | --- |
| `npm run typecheck --workspace frontend` | Aprovado |
| `npm run build --workspace frontend` | TypeScript/Vite aprovados; 22 módulos transformados |
| `npm run test:theme` | **32 cenários aprovados**, zero falhas, 15,1 s |
| `docker build --target frontend --tag emulador-game-boy-frontend:dev .` | Imagem somente do frontend construída |
| `docker compose up -d --no-deps frontend` | Somente frontend recriado |
| `curl --fail http://127.0.0.1:5173/api/health` | HTTP 200 após atualização |
| Inspeção dos containers backend/database | IDs e horários de início idênticos antes/depois; nenhum reinício |

A suíte `tests/browser/theme.spec.mjs` usa Chromium, Vite e interceptação de **todas** as rotas `/api`, com usuários fictícios em memória. O runner reutilizou a imagem de navegador existente, montou os fontes somente para leitura e executou com `--network none`, sem secrets, portas publicadas, banco ou volumes de dados. Apenas o container aleatório da própria execução foi removido. As suítes de backend/backup não foram repetidas, pois não houve alteração dessas áreas.

Cobertura efetivamente exercitada:

- Preferência clara/escura do sistema; mudanças do sistema até escolha explícita; precedência do valor salvo; valor inválido; fallback claro sem `matchMedia`.
- HTML com módulo React bloqueado: `data-theme=dark`, `color-scheme: dark` e fundo escuro já presentes enquanto o root ainda está vazio.
- Botão com nome estável, estado `aria-pressed`, Espaço/Enter e foco visível. O rótulo visível foi mantido como **Escuro** nos dois estados para também constar no nome acessível **Tema escuro**.
- Escolha clara e escura persistindo em login, recarregamento autenticado, logout e recarregamento sem sessão, para MASTER e JOGADOR simulados. Só a chave de tema aparece em localStorage; sessionStorage vazio. Sincronização entre duas abas.
- Exceções no getter de localStorage, `getItem` e `setItem`: aplicação e seletor continuam utilizáveis; recarga volta ao sistema quando não é possível recuperar a escolha.
- Login nos dois temas em 1280 × 900 e 390 × 844; biblioteca, administração e senha em 1280, 390 e 320 px para ambos os perfis. Sem transbordamento horizontal; seletor dentro da largura visível.
- Contraste texto/fundo de pelo menos 4,5:1 nas superfícies verificadas automaticamente: campos, cartões, diálogos e alertas de erro/sucesso. Modais de redefinição foram abertos/cancelados sem enviar alteração de senha.

Capturas `.local/screenshots/theme-*.png` geradas e revisadas visualmente nos dois temas, incluindo login desktop/mobile, biblioteca do jogador, administração e diálogos em telas estreitas. A paleta verde e a arte do console foram preservadas. Trata-se de Chromium com viewports móveis, não de validação em aparelhos físicos, todos os navegadores ou uma auditoria completa com leitores de tela.

A tentativa inicial `docker compose build frontend` anunciou também dependências no planejamento do Compose; foi interrompida e substituída pelo target Docker explícito acima. A imagem do backend manteve sua data anterior, e seus containers permaneceram em execução. Nenhum acesso ao servidor, commit, push ou publicação.


## Catálogo — 29/09/2026

Usuário aprovou o tema verde escuro e autorizou somente a primeira etapa do catálogo. Conferidos novamente pasta Linux, contexto `default` e daemon `docker-desktop | Docker Desktop`. Implementação não acessou o servidor e não fez commit/push/publicação.

### Preservação e migração

Antes de alterar o banco ativo, `npm run backup` gerou o dump legado `emulador-2026-09-30T00-57-26.807Z.dump`, e `restore:verify` confirmou restauração isolada com duas contas e duas sessões. O novo produtor de backup também foi validado contra o backend legado, gerando a pasta `emulador-2026-09-30T01-08-45.607Z-d33cbbfd`, restaurada com sucesso antes da migração.

A migração `002-catalog.sql` foi aplicada com `docker compose run --rm --no-deps migrate`. Backend e frontend foram reconstruídos com seus targets Docker e atualizados por `docker compose up -d --no-deps backend frontend`. PostgreSQL manteve seu container e horário de início. O volume de dados anterior foi preservado; criado somente o novo volume ativo privado `emulador-game-boy-dev_catalog_data`, com diretórios `0700`, sem publicação de arquivos/portas.

Após a atualização, o banco ativo tinha **duas contas, duas sessões, zero jogos e duas migrações**. A assinatura de todas as linhas de usuários permaneceu idêntica antes/depois, sem imprimir hashes de senha ou tokens. As pastas de ROMs/capas ativas estavam vazias. Nenhuma fixture sintética foi inserida nessa biblioteca. A única porta publicada continua `127.0.0.1:5173`.

### Comandos e resultados da etapa

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` / `npm run build` | Backend e frontend aprovados |
| `npm audit --audit-level=low` | Zero vulnerabilidades reportadas |
| `docker compose config --quiet` | Configuração válida |
| `docker build --target backend --tag emulador-game-boy-backend:dev .` | Imagem construída |
| `docker build --target frontend --tag emulador-game-boy-frontend:dev .` | Imagem construída |
| `docker compose run --rm --no-deps test` | **34 testes aprovados**, zero falhas, 16,59 s: 18 de autenticação + 16 de catálogo |
| `docker build --target browser --tag emulador-game-boy-browser:dev .` / `npm run test:browser` | **35 cenários aprovados**, 25,9 s: fluxo anterior de contas, dois fluxos reais de catálogo e 32 cenários de temas |
| `npm run test:catalog-operations` | Upload/edição, reinício real da API, backup, corrupção detectada, restauração isolada e recuperação com API aprovados |
| `curl --fail http://127.0.0.1:5173/api/health` | 200 após atualização |
| `npm run backup` após migração | Pasta completa `emulador-2026-09-30T01-17-33.504Z-310130d2`, zero jogos/arquivos ativos |
| `npm run restore:verify -- .local/backups/emulador-2026-09-30T01-17-33.504Z-310130d2` | Duas contas, duas sessões e duas migrações restauradas; catálogo vazio coerente |

Todos os nomes de backup acima são relativos a `.local/backups/`, ignorada pelo Git. Nenhum segredo ou jogo real foi adicionado ao repositório.

### API e arquivos

Testes de catálogo usam PostgreSQL real em base aleatória, diretório temporário próprio e ROMs/capas geradas em memória. Cobertura: 401/403 antes de interpretar multipart malformado; origem, AJAX e CSRF no multipart; troca obrigatória; validação de campos, extensões, logo, checksum do cabeçalho, flags CGB e tamanho exato; ROM mínima/máxima e dual-mode; limite de capa, conteúdo PNG/JPEG, imagens truncadas/SVG/animação/dimensões; SHA-256 duplicado em requisições concorrentes; UUID e ROM preservados após edição/ativação/desativação; filtro de jogadores e capa inativa 404; reprocessamento JPEG→PNG; ausência de substituição/download/exclusão de ROM; trigger de imutabilidade; falha de gravação e rollback SQL sem metadados/arquivos novos; capa adulterada 503 sem servir os bytes; persistência após reiniciar a aplicação.

Dois uploads HTTP mantidos abertos ocupam as duas vagas; o terceiro recebe 429. Abortar os dois libera recursos e permite novo cadastro 201. As falhas de disco/SQL injetadas geraram os erros genéricos esperados no log, sem vazamento de conteúdo sensível.

### Navegador e inspeção visual

Chromium exercitou upload multipart pela UI real, cadastro, listagem, edição do nome/capa, desativação, jogador sem item/capa inativa, reativação com mesmo UUID e biblioteca com Jogar desabilitado. Os fluxos foram repetidos nos temas claro/escuro, em desktop e larguras móveis de 390/320 px. Administração de usuários e seletor de tema permaneceram funcionais; o restante da suíte de temas também passou.

Capturas `catalogue-*.png` em `.local/screenshots/` revisadas: catálogo desktop, formulário/lista móvel, diálogo de edição e biblioteca do jogador. Capas usadas são blocos de cor sintéticos. Não houve transbordamento horizontal. Controles nativos de escolha de arquivo acompanham o idioma do navegador. A evidência cobre Chromium com viewports móveis, não aparelhos físicos/todos os navegadores ou auditoria completa de acessibilidade.

### Backup e restauração com arquivos

O teste operacional criou banco e volume próprios, dois jogos sintéticos (um ativo e outro inativo), duas ROMs e duas versões de capa. Reiniciou de fato somente seu container de API e comparou UUIDs, metadados e conteúdo da capa. Também introduziu no volume de teste um arquivo vazio sem referência, simulando resíduo de interrupção: o backup preserva esse resíduo sem publicá-lo ou confundi-lo com jogo.

A pasta de evidência `catalogue-operational-6b7b54faf4217ac8f458` contém dois jogos e **cinco arquivos**, incluindo capa anterior e resíduo vazio. A verificação restaurou SQL e arquivos em container sem rede/portas/volume persistente, comparou referências e SHA-256 dos bytes copiados. Alterar um arquivo dessa cópia de teste foi recusado pelo checksum; o conteúdo original sintético foi recomposto e revalidado.

A recuperação criou outro banco e outro volume, revogou as sessões restauradas e iniciou uma API real com papel PostgreSQL `emulador`. Login, catálogo e capa retornaram o mesmo conteúdo. A origem de teste continuou íntegra. Containers, bases e volumes criados por esse ensaio foram removidos exclusivamente por ele; os volumes preexistentes foram preservados. O backup sintético ficou como evidência local.

A revisão corrigiu dois pontos operacionais: produtor compatível com backend legado antes da migração e permissões `0700` das pastas sem depender de `mkdir` sobre diretórios já existentes. Corrigida também a aceitação de órfão vazio no manifesto: arquivos não referenciados de zero bytes podem ser preservados/verificados; dump vazio continua proibido, e arquivos referenciados continuam sujeitos a tamanho/hash do banco.

### Limites e pendências

Emulação, saves e substituição/exclusão de ROM não foram implementados. Não foram baixados jogos reais. Admissão estrutural não prova que uma ROM executará em um futuro core. Sem coleta automática de capas antigas/resíduos, quota temporal de upload, paginação além do limite local de 1000 jogos ou verificação recorrente de integridade. Um backup interrompido precisa ser repetido; não usar a pasta incompleta. Backup externo criptografado, retenção, recuperação em outra máquina e matriz real de compatibilidade permanecem para etapas futuras.


## Ampliação do catálogo GB + GBA — 29/09/2026

Autorização explícita substituiu a antiga restrição somente GB; escopo limitado a catálogo/tipos de ROM. Daemon confirmado novamente `default`, `docker-desktop | Docker Desktop`; somente frontend em `127.0.0.1:5173`. Nenhum jogo real baixado, nenhum segredo ou ROM versionado.

### Testes executados

| Comando | Resultado desta ampliação |
| --- | --- |
| `npm run typecheck` e `npm run build` | Backend/frontend aprovados |
| `docker compose config --quiet` | Válido |
| `docker build --target backend --tag emulador-game-boy-backend:dev .` | Construído |
| `docker build --target frontend --tag emulador-game-boy-frontend:dev .` | Construído |
| `docker build --target browser --tag emulador-game-boy-browser:dev .` | Construído |
| `docker compose run --rm --no-deps test` | **41 testes aprovados**, 16,11 s; 18 autenticação, 22 catálogo e 1 migração populada |
| `npm run test:browser` | **35 cenários aprovados**, 28,2 s; dois fluxos reais GB/GBA, fluxo de contas e 32 cenários de temas |
| `npm run test:catalog-operations` | Catálogo misto GB/GBA persistiu após reinício real de sua API; backup, restauração isolada e recuperação com API real aprovados |
| `npm run restore:verify -- .local/backups/catalogue-operational-6b7b54faf4217ac8f458` | Backup v1 anterior, 2 GB e 5 arquivos íntegros, aceito pelos scripts novos |
| `npm run restore:recover -- .local/backups/catalogue-operational-6b7b54faf4217ac8f458` | Recuperação v1 em banco/volume novos, posteriormente migrados e conferidos; recursos exclusivos do ensaio removidos, origem preservada |

Logs desta etapa em `.local/validation/gba-{api,browser,operations,build-backend,build-frontend,build-browser}.log`. Não houve dependência nova; lockfile existente preservado.

### Cobertura específica

GBA mínimo de 192 bytes, tamanho não alinhado de 193 bytes, máximo inclusivo de 32 MiB e excesso de um byte; GB mantém mínimo/máximo e dual-mode. Rejeitados logo, complemento, campos fixos/reservados inválidos, extensões trocadas GB↔GBA, extensão composta e cabeçalho ambíguo. Bits variáveis permitidos do logo GBA testados. Conteúdo é verificado sem confiar no MIME.

Uploads concorrentes da mesma GBA produzem um 201 e um 409, um registro e um arquivo. Testados 401/403, troca obrigatória, edição/disponibilidade/capa privada, jogador sem inativos, ausência de rotas ROM/download/exclusão, recusa de console injetado no formulário e trigger impedindo alterar o console. UUID, console, hash, tamanho e bytes persistem após editar e reiniciar. Casos anteriores de GB, origem/CSRF, falhas de gravação/SQL, abortos e limites continuam passando.

O ensaio `catalog-migration.integration.test.mjs` reconstrói 001+002 com seus checksums, insere dois jogos GB (ativo/inativo, um dual-mode), capa, conta e sessão sintéticas, aplica 003 e compara **todas as colunas anteriores** das três entidades e os arquivos byte a byte. Somente `console=GB` é acrescentado; reaplicar migrações é idempotente.

Chromium realizou upload real dos dois consoles, exibiu console detectado no formulário e conferiu selos vindos da API na lista, biblioteca e edição. Ativou/desativou ambos e verificou que jogadores não recebiam jogo/capa inativos. Identidades permaneceram estáveis. Cenários claros/escuros, desktop 1280 px e mobile 390/320 px; sem transbordamento horizontal. Jogar permaneceu desabilitado. Capturas novas `catalogue-*.png` em `.local/screenshots/`. Viewports simulados não substituem testes em aparelhos físicos ou todos os navegadores.

### Backup, migração antiga e recuperação mista

O backup inicial do ativo `emulador-2026-09-30T01-33-37.392Z-0b5ce038` foi restaurado isoladamente: 2 contas, 2 sessões, 2 migrações e catálogo vazio. Imediatamente antes da migração real, nova inspeção e backup completo `emulador-2026-09-30T01-43-37.447Z-68e14bce` confirmaram zero jogos/arquivos. Ambos ficam em `.local/backups/`.

O backup v1 populado da etapa anterior foi restaurado sem rede e recuperado em banco/volume próprios. Executada a migração 003 apenas nesse destino (`PGDATABASE` específico, sem editar `.env`); comparadas todas as colunas antigas e os cinco arquivos contra o manifesto original. Dois jogos agora identificados GB, sem renomear/converter arquivos. O destino de ensaio foi removido; backup original preservado.

O ensaio operacional novo preservou `.local/backups/catalogue-operational-384ca0b287a270ad1a46`: manifesto v2 com um GB e um GBA, duas ROMs, capas atual/anterior e resíduo vazio (cinco arquivos). Reinício real de API preservou UUIDs, console, metadados e capa. Manifesto com console incoerente, mesmo recalculando seu checksum, foi rejeitado; arquivo adulterado também. Restauração sem rede e recuperação em outro banco/volume compararam os dois tipos, referências e hashes. A API recuperada autenticou usando o papel de aplicação e retornou o mesmo catálogo; sessões recuperadas revogadas. Todos os recursos exclusivos do ensaio foram removidos; banco/volumes ativos preservados.


### Atualização local concluída

Novo backup imediatamente anterior (`emulador-2026-09-30T01-43-37.447Z-68e14bce`) também restaurado isoladamente antes de migrar. Backend parado brevemente para impedir upload pela versão antiga durante a alteração de esquema; executados `docker compose run --rm --no-deps migrate` e `docker compose up -d --no-deps backend frontend`. Migração 003 aplicada com sucesso. PostgreSQL manteve o mesmo container e início `2026-09-30T00:10:34.162161752Z`; volumes e `.env` preservados.

Comparação privada antes/depois confirmou integralmente as linhas das **2 contas e 2 sessões**, sem expor credenciais. Catálogo ativo permaneceu vazio, com 3 migrações; nenhum dado foi limpo e nenhuma fixture foi inserida. `GET /api/health` retornou 200, catálogo sem sessão retornou 401 e fonte servida na porta 5173 confirmou o formulário `.gb ou .gba` atualizado. Novo backup final: `emulador-2026-09-30T01-45-10.308Z-56074eac`, também restaurado isoladamente com 2 contas, 2 sessões, 3 migrações e zero jogos/arquivos.

Inspecionadas visualmente cinco capturas, incluindo biblioteca/administração escuro em 320 px, diálogo escuro em 320 px, administração claro em desktop e diálogo claro em 390 px: selos de ambos os consoles legíveis, sem colisão/transbordamento horizontal, paleta verde preservada. O diálogo estreito usa rolagem vertical para chegar aos controles inferiores; o fluxo foi exercitado no navegador.

Emulação, saves e escolha de core continuam pendentes, assim como a política operacional externa já registrada. Nenhuma conta, autenticação ou tema foi redefinido. Sem servidor, commit, push ou publicação.

## Emulação GB/GBA e save nativo — 29/09/2026

Autorização posterior ao catálogo incluiu execução real e persistência mínima. Inspeção encontrou **2 contas, 2 sessões e 1 GBA ativo com capa** cadastrado pelo usuário. Nenhum dado foi limpo; ROMs próprias dos testes ficaram somente em bases/pastas/volumes efêmeros. Daemon `default`, Docker Desktop local, publicação somente `127.0.0.1:5173`.

### Motor e spike anterior à interface

Avaliado EmulatorJS e escolhido adaptador direto mGBA-wasm com mGBA fixado, sem SDK de persistência automática. Fontes, hashes públicos, licença MPL-2.0 e compilador fixo estão em [fontes do motor](fontes-emulador.md). `npm run prepare:emulator` compilou fontes verificadas; estágio de compilação sem rede. Assets e fontes correspondentes auto-hospedados, sem CDN em runtime ou BIOS externa.

O primeiro spike detectou falha real de restauração GBA na função original do wrapper: retorno de sucesso com SRAM não restaurada durante autodetecção. O patch local usa `loadSave` em memória antes do primeiro frame. Não foi anunciado funcionamento com base apenas no retorno da API.

Spike final real GB SRAM 8 KiB, GBA SRAM 32 KiB e GBA Flash 128 KiB: instruções executadas, pixels mudaram com A/B, save extraído, motor descartado, nova instância restaurou **todos os bytes antes do primeiro quadro** e voltou à cor correspondente. Flash incluiu sentinelas nos dois bancos. Pausa, entradas ignoradas enquanto pausado, mudo/ativação e descarte repetido exercitados. Zero erros de página ou requisições externas. Evidência: `.local/spike/adapter-evidence.json` e `adapter-own-*.png`.

Smoke-test adicional autorizado de um cartucho GBA existente: volume montado **somente leitura**, container com rootfs somente leitura e `--network none`, sem backend/API, entradas de jogo ou exportação/gravação de save. Abertura animada em 240×160, 13 imagens distintas em 14 s, áudio PCM não nulo após gesto e AudioContext fechado ao descartar. Nenhuma ROM/save pessoal copiada, transmitida ou versionada. Evidência local sem bytes/identificador de arquivo: `.local/spike/existing-cartridge-evidence.json`. Não equivale a jogar uma partida completa ou testar um save pessoal.

### Comandos e resultados

| Comando | Resultado |
| --- | --- |
| `npm run prepare:emulator` | Fontes fixadas compiladas e assets locais extraídos |
| `npm run typecheck` / `npm run build` | Backend e frontend aprovados após as correções finais |
| `docker compose config --quiet` | Válido |
| `docker compose build backend` | Imagem construída |
| `docker compose build frontend test-browser` e builds finais dos dois targets | Runtime/fontes auto-hospedados incluídos |
| `docker compose run --rm --no-deps test` | **57 testes aprovados**, 27,65 s; 16 novos de play/saves, mais auth/catálogo/migração |
| `npm run test:browser` | **49 cenários aprovados**, 1,6 min; 14 do player real, 3 de contas/catálogo e 32 de temas |
| `npm run test:catalog-operations` | Reinício real da API de ensaio preservou catálogo e saves; restauração e recuperação v3 aprovadas |
| `npm run restore:verify -- .local/backups/catalogue-operational-6b7b54faf4217ac8f458` | Backup v1 anterior: 2 GB, 5 arquivos e zero saves, aceito |
| `npm run restore:verify -- .local/backups/emulador-2026-09-30T02-00-34.550Z-09b6e5c3` | Backup v2 anterior: 1 GBA, 2 arquivos e zero saves, aceito |

Logs: `.local/validation/player-api.log`, `player-final-browser.log`, `player-operations.log`, `player-{legacy-v1,legacy-v2}.log`, `player-final-build-{frontend,browser}.log`. Nenhuma dependência npm nova; lockfile existente preservado.

Testes HTTP com PostgreSQL real cobrem 401/403/404, origem/CSRF antes do parser, conta bloqueada, jogo inativo inclusive MASTER, limite de save, base64/checksum, quota global, integridade/symlink da ROM e limite de leitores com aborto. Reserva exclusiva, expiração, propriedade, versão, repetição idempotente, concorrência e revogação por logout/reset/bloqueio exercitados. Ensaio da migração populada aplica 003+004 sem alterar colunas anteriores de contas/sessões/jogos ou arquivos.

Os 14 cenários de player usam API, PostgreSQL e WASM **reais**, com ROMs próprias executáveis; não é um mock de emulação. Cobrem GB/GBA, SRAM/Flash128, sair/reabrir em outro contexto de navegador, isolamento entre usuários, duas abas, teclado/toque, L/R visível em GBA, fullscreen, áudio/mudo, temas claro/escuro e mobile 390/320 px. Inspecionadas capturas `player-*.png`: proporções corretas, controles e textos legíveis, sem transbordamento horizontal. Tema/API simulada só nos 32 testes específicos de tema. Falhas HTTP, áudio e fullscreen são injetadas para exercitar suas respostas, sem substituir o core.

Correções da revisão: aviso não fatal para áudio/fullscreen com dispensa e nova tentativa; keyup libera tecla mesmo depois de mudar foco para botão; heartbeat funciona ainda carregando ROM; timers param na saída; pausa durante PUT lento captura o snapshot sucessor. Commit confirmado com resposta perdida preserva original e sucessor no IndexedDB, tanto no retry como em saída local/reabertura, sem 409 indevido ou perda de B. Resposta de save corrompida não apaga recuperação íntegra. Jogo desativado após save confirmado permite sair mesmo com release 404. Testes focados foram repetidos durante o diagnóstico; a rodada completa final passou sem retries automáticos.

Uma falha inicial do teste de teclado após Retomar dependia de enviar/liberar a tecla antes da retomada assíncrona/frame. O teste agora aguarda o estado executando e a resposta visual do core; nenhuma asserção de persistência foi removida. A fixture de recuperação também passou a incluir a revisão local exigida pelo CAS. Isso distingue ajustes no teste das correções funcionais acima.

### Backup, migração local e preservação

Antes de alterar o banco, backup v2 `emulador-2026-09-30T02-00-34.550Z-09b6e5c3` e, novamente, v3 `emulador-2026-09-30T02-27-19.760Z-2cafd3be` foram restaurados isoladamente, com 2 contas, 2 sessões, 3 migrações, 1 GBA, capa e ROM conferidas por tamanho/SHA-256. O produtor v3 aceita o esquema anterior sem tabela de saves.

O ensaio operacional preservou `.local/backups/catalogue-operational-9512c29c67958c81fe8e`: GB+GBA, 2 saves nativos e 5 arquivos (incluindo capa anterior/resíduo vazio). Reiniciou a API de ensaio, verificou bytes/versões/checksums; fez backup sob trava comum; restaurou sem rede; recuperou em banco/volume novos com o papel de aplicação; leu os mesmos saves pela API. Manifesto de console incoerente e arquivo adulterado foram recusados. Sessões recuperadas revogadas e origem preservada. Somente recursos pertencentes ao ensaio foram removidos.

Migração local `004-play-saves.sql` aplicada com backend brevemente parado, seguida de `docker compose up -d --no-deps backend frontend`. PostgreSQL manteve o mesmo container e horário de início. Comparação privada de todas as colunas confirmou **2 contas, 2 sessões e 1 jogo integralmente iguais** ao começo, incluindo UUID/hash/chaves/capa. Nenhuma fixture na biblioteca ativa, nenhum save pessoal criado pelo smoke; 4 migrações, 0 saves e 0 reservas na inspeção final. Volumes e `.env` preservados.

Health, JS/WASM e página de licenças locais responderam 200; ROM sem sessão respondeu 401. Fonte servida em 5173 confirmou player/avisos atualizados. Backup final: `emulador-2026-09-30T02-34-38.567Z-32f870e7`, com banco e os mesmos arquivos privados; restauração isolada aprovada com 2 contas, 2 sessões, 4 migrações, 1 GBA, 2 arquivos íntegros e zero saves, em `player-final-restore.log`.

### Limites reais

Chromium com viewports móveis não substitui aparelhos físicos, Safari/Firefox ou teste auditivo humano. Há sinal PCM real, mas a qualidade/performance precisa de avaliação pelo usuário no seu equipamento. O núcleo upstream fixado é uma revisão de desenvolvimento; não há matriz completa de cartuchos, EEPROM, RTC, sensores ou acessórios validada. Na entrega original não havia save state/slots/administração; essa restrição foi substituída na ampliação registrada abaixo. BIOS proprietária e importação/exportação continuam fora.

Sincronização a cada 2 s e na pausa/saída reduz risco; interrupção abrupta, storage/rede indisponível ou saída durante a gravação interna do jogo ainda podem perder progresso. Recuperação local só entra no backup depois de sincronizada. Bytes da ROM chegam ao navegador autorizado; não há promessa de DRM. Permanecem pendentes backup externo criptografado, retenção automática, restauração em outra máquina, testes físicos. Sem acesso ao servidor, commit, push ou publicação.

## Bootstrap e documentação pública — 30/09/2026

Escopo autorizado: criação automática do primeiro MASTER pela `.env`, documentação reproduzível e primeiro commit local do baseline funcional. Sem push, publicação, servidor ou novas funções do player. Não houve migração nova nem alteração das quatro migrações existentes.

### Preservação e ambiente

Daemon local conferido: contexto `default`, Docker Desktop/Engine 29.5.3, Compose 5.1.4. Host Node 24.16.0/npm 11.13.0; imagens Node 24.21.0/npm 11.19.0. A inspeção encontrou 2 contas, 2 sessões, 1 GBA com capa, nenhum save nativo e 1 reserva preexistente. Inventário privado de todas as colunas e montagens preservado fora do Git.

Backup conjunto anterior à alteração: `emulador-2026-09-30T20-45-53.898Z-adf29516`. Restauração isolada aprovada: 2 usuários, 2 sessões, 4 migrações, 1 GBA, 2 arquivos íntegros e zero saves. A primeira tentativa ocorreu antes de o PostgreSQL ficar pronto; a pasta incompleta foi preservada e não utilizada. Nenhuma fixture entrou no catálogo ativo.

### Testes desta alteração

- `npm run typecheck` e `npm run build`: backend/frontend aprovados.
- `docker compose build backend frontend test-browser`: imagens compiladas; assets do motor reproduzidos pelo build existente.
- `npm audit --audit-level=low`: zero vulnerabilidades reportadas nessa execução.
- `docker compose run --rm --no-deps test`: **65 testes aprovados**, incluindo os 8 novos casos de bootstrap e as regressões de autenticação, catálogo, migração e saves.
- `docker compose run --rm --no-deps test-browser npx playwright test tests/browser/application.spec.mjs`: **1 cenário integrado aprovado**, cobrindo CLI real em TTY sem eco, desktop/celular, login, administração, troca de senha, perfis, revogação e sessão após reinício. Os demais cenários Chromium da entrega anterior não foram repetidos nesta mudança sem alteração de frontend/player.

A suíte nova usa PostgreSQL real em banco próprio e credenciais aleatórias. Verifica Argon2id 64 MiB/3/1, login MASTER, espaços e `$` literais, ausência/configuração parcial/fraca/inválida, arquivo limitado/UTF-8/sem symlink, duplicatas/aspas ambíguas, jogador homônimo preservado, arquivo ignorado quando já existe master e concorrência de seis inicializadores. Os dois caminhos de bootstrap também disputam simultaneamente a mesma trava transacional. O teste da CLI interativa cobre seu terminal; o ensaio concorrente chama a função transacional compartilhada pela CLI.

Na primeira rodada, uma fixture tentou bloquear MASTER e foi corretamente recusada pelo CHECK SQL existente. A fixture passou a alterar apenas `must_change_password`; a proteção do aplicativo não foi afrouxada. A rodada final passou sem falhas.

### Instalação reproduzível e atualização local

`npm run test:first-boot` e `npm run test:first-boot -- --configured-first` passaram. Cada execução fez `npm ci` e setup reais numa cópia nova, com banco/volumes próprios e porta aleatória em loopback; usou as imagens compiladas acima. O modo padrão comprovou bloqueio sem credenciais antes de criar o primeiro master. O segundo seguiu o roteiro principal com credenciais válidas desde o primeiro `up`, sem comando de criação manual. Ambos verificaram quatro migrações, health, login MASTER, administração autorizada, reinício real de banco/backend, preservação da conta/sessão, credenciais alteradas sem reset e ausência total da `.env` com fallback público vazio.

Senhas aleatórias com `$HOME`, `${KEEP_LITERAL}` e `#` foram autenticadas literalmente. A inspeção de config JSON, logs, Docker inspect, ambiente, configuração de build, metadados das imagens e 49 arquivos reais do frontend não encontrou as credenciais de ensaio. `.env` em `0600`; somente bootstrap monta esse arquivo. Evidências: `.local/firstboot-8c85351e9c8005173baf/evidence.json` e `.local/firstboot-e69bf8475e603062a73f/evidence.json`. Recursos e segredos criados pelos ensaios foram removidos; evidências resumidas foram preservadas.

O ensaio encontrou uma limitação real do Docker Desktop/WSL: editar `.env` por substituição atômica após uma tentativa deixa o container parado ligado ao inode anterior. O roteiro de correção agora recria somente `bootstrap` antes do novo `up`; esse caminho também foi validado. Alterar o caminho do secret provoca recriação via label não secreto. Formatos de aspas ambíguos entre Node/Compose são recusados antes de gravar um hash; a CLI cobre senhas com apóstrofo/barra invertida final.

A atualização ativa executou verificação idempotente de migrações, bootstrap sem credenciais de administrador preenchidas e recriação de backend/frontend. O serviço respondeu que o master existente foi preservado. PostgreSQL manteve container/horário de início; os outros containers preexistentes mantiveram IDs, estado, início e montagens. A porta publicada continua exclusivamente `127.0.0.1:5173`. Health, entrada HTML, licença e WASM real responderam 200; `/api/auth/me` sem sessão respondeu 401.

Comparação privada de **todas as linhas e colunas das sete tabelas** após a atualização foi idêntica à inicial: contas, sessões, tentativas, jogo, reserva, migrações e ausência de saves preservados. Manifestos anterior/final confirmaram UUID/console/metadados e ambos os arquivos com caminhos/tamanhos/checksums iguais. Não houve login de teste nem gravação de progresso no banco ativo.

Backup final `emulador-2026-09-30T21-04-18.443Z-53165940` restaurado isoladamente com sucesso: 2 usuários, 2 sessões, 4 migrações, 1 GBA, 2 arquivos íntegros e zero saves. Logs privados em `.local/validation/admin-env-*`; senhas, hashes de contas, tokens, nomes/identidades pessoais e arquivos de catálogo não acompanham esta documentação.

### Revisão para o primeiro commit

Revisados todos os 127 arquivos elegíveis: fontes, testes, scripts, configuração, lockfile e documentos. Somente texto; fixtures são programas sintéticos gerados pelo teste. `.env`, `.local`, ROMs, saves, backups, dependências instaladas e assets gerados permanecem ignorados. Contexto administrativo anterior foi preservado em arquivo privado ignorado antes da generalização. Lockfile confere com os manifests e usa o registro oficial npm e workspaces locais; configuração/autor Git existentes preservados. Autorização abrange somente commit local, sem push, publicação ou acesso a servidor.

Permanecem as limitações de emulação/operação da etapa anterior; esta tarefa não acrescenta funções ao player nem repete toda a matriz de cartuchos/navegadores.

## Segurança de login, IP e SQL — 30/09/2026

Revisão e implementação locais autorizadas, com reutilização de `login_attempts` e consultas parametrizadas existentes. Nenhuma concatenação vulnerável de entrada HTTP foi identificada na revisão; os testes abaixo são evidência de regressão, não alegação de vulnerabilidade anterior.

- `npm run typecheck` e `npm run build`: aprovados nos dois workspaces.
- `docker compose config --quiet`: aprovado; somente frontend publicado em loopback, banco/backend privados.
- `docker compose build backend frontend test-browser`: imagens locais compiladas; sem mudança de core/dependências.
- `docker compose run --rm --no-deps test`: **71 testes aprovados**, zero falhas. Bases/pastas aleatórias próprias, removidas pelo ensaio.
- Novos cenários HTTP: terceira falha/7200 segundos, nomes distintos no mesmo IP, acertos sem apagar falhas, IPs independentes, prazo imutável, janela móvel, expiração por datas SQL na base isolada, reinício de API, vinte requisições concorrentes distribuídas entre duas instâncias. Com duas falhas prévias, a rajada verifica somente **uma** senha adicional; todas as respostas da rajada são 429 e o histórico termina com três falhas.
- Limites de conta, rajada e geral testados independentemente, incluindo URLs de login com maiúsculas aceitas pelo Express, expiração e `Retry-After`. Nenhum ajuste do relógio real ou espera de duas horas.
- Spoofing direto ignorado; endereço de proxy reconhecido exige um único IP válido. IPv4 mapeado/IPv6 normalizados; listas e zona de interface recusadas.
- Payloads SQL: credenciais/UUIDs inválidos recusados pelo contrato; nome de jogo e bytes de save com sintaxe SQL persistem literalmente. Listagens não usam parâmetros desconhecidos como SQL. Sessão, entrega de ROM, renovação de reserva e gravação de save continuam disponíveis durante bloqueio de login; bytes/versão e tabela de usuários conferidos.
- `npm run test:browser`: **50 cenários Chromium aprovados**, incluindo UI 429 real, sanitização pelo Vite, distinção de sockets clientes, sessão já autenticada preservada e regressão completa de catálogo/player GB/GBA/saves/temas. Repetido após a revisão final de casos de borda.
- `node scripts/test-security-proxy.mjs`: aprovado em rede Docker interna própria, com API/Vite e dois clientes separados, sem portas publicadas. Endereços observados no banco correspondem aos clientes, não ao proxy nem aos cabeçalhos forjados. Terceira falha retorna 429/7200; reinício do container da API preserva o prazo; health funciona antes de existir o frontend. Aplicação/migração do ensaio usam papel `emulador`, sem superusuário/criação de bancos. Recursos próprios removidos.

Limitações: clientes que chegam ao Vite atrás do mesmo NAT/Docker Desktop podem compartilhar IP e bloqueio; bots com múltiplos IPs não são impedidos. Limites gerais são compartilhados por IP, inclusive entre sessões válidas, e não substituem dimensionamento para exposição pública. A aplicação continua exclusivamente local. Evidências não comprovam outros navegadores ou aparelhos físicos. O teste de persistência reinicia a API, sem reiniciar o PostgreSQL ativo.


Operação local concluída após validação: backup conjunto anterior restaurado com sucesso em container sem rede/portas/volume persistente; aplicada somente a migração 005 e recriados backend/frontend. PostgreSQL e volumes mantidos, sem reinício do banco. Health retornou 200 e `/api/auth/me` sem cookie retornou 401 pela cadeia Vite/backend. Nenhuma tentativa de login ou teste de bloqueio foi executado contra contas do banco ativo.

Snapshot privado de contagens e SHA-256 de linhas confirmou contas, sessões, catálogo, saves e reservas idênticos antes/depois. Manifestos dos backups confirmaram ROMs/capas com mesmos arquivos, tamanhos e checksums. Backup final também restaurado e verificado em isolamento. Os caminhos e logs locais ficam em `.local/security-maintenance/`, ignorado; dados administrativos e inventário pessoal não integram este documento. `git diff --check` aprovado. Nenhum commit, push ou implantação remota; `AGENTS.md` preservado.


## Experiência do player — validação proporcional — 30/09/2026

Alteração exclusivamente de frontend: tamanho/controles/modal/preferências locais. Selecionados testes dos fluxos afetados, sem repetir as suítes de autenticação, segurança, catálogo, migrações, backup/restauração ou a matriz inteira do motor. As 71 verificações de API/migração e 50 cenários Chromium da etapa de segurança acima são **evidência anterior**, não resultados novos desta etapa. Core, adaptador e contratos de save permanecem intactos. A única mudança em App é uma classe de largura ativa durante o player; a volta à biblioteca é coberta pelo smoke, sem alterar outros fluxos.

Comandos executados:

```bash
npm run typecheck --workspace frontend
npm run build --workspace frontend
node scripts/test-player-ux.mjs
docker compose build frontend
docker compose up -d --no-deps frontend
curl --fail http://127.0.0.1:5173/api/health
git diff --check
```

Tipos/build frontend aprovados. **Sete cenários Chromium focados aprovados**, sem erros JavaScript não tratados:

| Cobertura atual | Evidência |
| --- | --- |
| GB e GBA | Quatro tamanhos, Ajustar padrão, proporções 160/144 e 240/160, renderização pixelated, desktop 1440×1080 e telas 390×844, 320×640 e 844×390 |
| Layout/tema/tela cheia | Tema claro/escuro, tela cheia real em desktop e horizontal, canvas contido na área, sem rolagem horizontal; botões ≥44 px e sem sobreposição entre alvos; configurações/saída continuam acessíveis com botões ocultos |
| Entrada | Multitouch via CDP com direção+A simultâneos; fontes teclado/toque e dois Shift mantêm a mesma ação até liberar a última fonte; cancelamento, foco, ocultação e saída liberam entradas |
| Configurações | Todos os dez vínculos exercitados no core GBA; conflito sem mudança silenciosa, troca explícita, Escape/cancelamento e reset; captura não avança quadros nem envia entradas ao jogo |
| Pausa/segurança da entrada | Pausa anterior preservada, retomada quando apropriada, perda de foco ou erro na renovação impede retorno automático; campos editáveis e atalho Ctrl não alimentam o jogo; tecla capturada mantida pressionada não reentra por repetição |
| Preferências | Reabertura/reload, isolamento e retorno entre dois UUIDs de usuário no mesmo contexto, JSON/versão/vínculos inválidos ou duplicados/tecla reservada e storage indisponível |
| Smoke de player | Core real executa ROM sintética; tecla remapeada altera byte do cartucho; fluxo existente confirma save na API simulada e sai à biblioteca; erro de renovação mantém pausa |

O roteiro reutiliza a imagem local `emulador-game-boy-browser:dev`, com core já compilado e inalterado. Monta fontes atuais do frontend e o teste como somente leitura, roda com `--network none`, sem secrets, banco, volumes de dados ou portas publicadas. Todas as respostas de API são simuladas por contexto de navegador; nenhum login, fixture, bloqueio ou progresso é gravado nas contas/jogos pessoais. A instrumentação apenas observa chamadas de entrada/quadro do WASM real. Não se trata de nova validação do backend ou da restauração de cartucho; essas áreas usam suas evidências anteriores. Dependências alteradas futuramente exigem reconstruir a imagem de teste.

Capturas revisadas em `.local/screenshots/player-ux-*`: celular, tela cheia horizontal e conflito de vínculos. Logs locais em `.local/player-ux/`, ignorados. Frontend local atualizado após aprovação; health retornou 200. Comparação dos IDs e timestamps de início confirmou que backend/PostgreSQL não foram recriados nem reiniciados. Sem manutenção de dados, não houve migração nem backup completo nesta etapa, conforme a política expressamente aprovada e registrada em AGENTS.md.

Comparação SHA-256 confirmou preservação integral dos arquivos pendentes de segurança; decisões/histórico/evidências compartilhados apenas receberam novos registros. AGENTS.md recebeu somente a política de validação proporcional, mantendo suas instruções anteriores. Nenhum commit, push ou acesso remoto.

Limitações: validação em Chromium/Docker, sem aparelhos físicos/Safari/Firefox. Tela cheia depende do suporte do navegador. Em alturas muito pequenas pode haver rolagem vertical da interface; presets convergem quando falta espaço. Escalas fracionárias usam amostragem sem suavização. Preferências não sincronizam entre navegadores/abas em tempo real; falha do storage mantém somente a escolha em memória enquanto o player está aberto.

## 30/09/2026 — salvar/retomar e volume (validação proporcional)

Escopo atual: contrato de metadados do player, confirmação de saída/ACK e áudio/preferências. Não foram repetidas suítes de autenticação, segurança, catálogo, migrações, backup/restauração ou matriz completa do motor; evidências anteriores dessas áreas permanecem históricas.

- Tipos e build dos workspaces frontend/backend: passaram. Backend afetado somente pela consulta parametrizada de metadados individuais no manifesto; sem migração.
- **9 cenários únicos Chromium com backend, PostgreSQL e core mGBA reais**, em banco/contas/catálogo temporários próprios: GB entre sessões/usuários; Flash128 de 131.072 bytes com sentinelas na segunda bancada, sair/reabrir e restaurar antes da execução; PUT lento com snapshot sucessor; falha de envio/retry/recarga; resposta perdida recuperada por retry e por reabertura; saída sem save; ACK inválido mantendo IndexedDB e impedindo saída; áudio real/preferências.
- Primeira execução: 8 passaram e o caso sem save falhou porque a fixture SRAM inicializava dados no boot. Corrigido o ensaio com cartucho real que executa loop sem escrever SRAM; nova execução dos três casos novos passou. Após acrescentar verificação de beforeunload sem falso aviso, toque e fullscreen, os dois casos afetados passaram novamente.
- Áudio: GainNode observado no AudioContext real em 0/35/36/70%, mute/desmute, pausa, fechamento de todos os contextos ao sair, reabertura silenciada, preferências v1 antigas e isolamento por conta. Slider por teclado e evento de toque real Chromium; 375px sem rolagem horizontal e tela cheia. Não houve avaliação auditiva humana.
- **2 cenários de geometria GB/GBA** reaproveitados do player: tamanhos/proporções, responsividade e tela cheia. Usam API simulada e core real; comprovam layout da barra alterada, não persistência. O helper de saída foi atualizado para a confirmação explícita.
- `git diff --check`: passou. Logs privados em `.local/save-volume/`: `tests.log`, `focused-final.log`, `audio-exit-final.log`, `layout.log`, builds e atualização. O primeiro log contém a falha de fixture descrita, não deve ser citado como execução integralmente aprovada.

Reprodução: preparar `docker compose build test-browser`; executar `docker compose run --rm --no-deps test-browser npx playwright test player.spec.mjs --grep 'GB: motor real|Flash1M|PUT lento|falha ao salvar|resposta perdida|saída sem save|ACK inválido|volume real'`. A preparação/criação da base é exclusiva do ensaio, sem fixtures ou logins no banco ativo. Para geometria, executar somente `player-ux.spec.mjs --grep 'tamanhos, proporção'` na imagem de navegador com rede desabilitada.

Diagnóstico: o código já aguardava flush e restaurava bytes antes do primeiro frame. Identificadas comunicação insuficiente na saída sem gravação e validação incompleta de versão/data do ACK; não foi comprovada perda de progresso no relato. Consulta local somente de leitura encontrou zero registros em `game_saves`, sem exposição de conteúdo/identidades. Isso não permite reconstruir o ocorrido nem saber se houve SAVE no jogo. O IndexedDB do navegador pessoal não estava acessível; somente recuperação sintética foi inspecionada/testada. Bytes remotos não certificam uma partida válida.

Atualização local limitada a frontend/backend, sem migração ou manutenção de dados. Comparação privada antes/depois confirmou contas, sessões, catálogo e saves idênticos; container PostgreSQL preservado (mesmos ID e horário de início). A comparação estrita incluindo reservas falhou: a única reserva ativa mudou durante o intervalo, compatível com heartbeat do navegador em uso, sem comprovação de quais campos mudaram pelo snapshot agregado. Não se afirma identidade das reservas. Health local respondeu `{"status":"ok"}`. Nenhum commit/push/servidor remoto.

## 30/09/2026 — reserva após Ctrl+R (validação focada)

Causa reproduzida: reload real destrói o emulador, mas a liberação assíncrona não é garantida; a reserva persistida ainda válida rejeita outra aquisição. Isso não demonstra perda de save. Mantidos TTL de 120 s/heartbeat de 30 s; transferência agora exige confirmação e geração observada. A alteração não requer migração PostgreSQL/IndexedDB, limpeza de reservas ativas ou manutenção de dados pessoais.

Resultados atuais:

- **6 testes API/PostgreSQL reais passaram**: aquisição concorrente exclusiva, isolamento de saves por usuário/jogo, expiração com rejeição de dono antigo e preservação do save, reinício da aplicação, duas transferências da mesma geração com um vencedor, e save/renew/DELETE antigos já em voo enquanto a transferência aguardava trava real do PostgreSQL. Os novos testes também verificam CSRF, jogo inativo, geração de outra conta/jogo e token antigo incapaz de renovar/liberar a reserva vencedora. Sem mocks para essas garantias.
- **8 cenários únicos Chromium com API/PostgreSQL/core reais passaram**. Primeira execução: sete passaram (duas abas sem transferência automática; snapshot corrompido preservando IndexedDB; resposta perdida com sucessor por retry e reabertura; reload real Flash128 com takeover/restauração; fechamento e expiração com Tentar novamente; duas abas com pendência antiga isolada sem apagar a nova). Execução complementar: três passaram, cobrindo novamente reload com resposta perdida da transferência, pendências/pageshow e acrescentando aquisição atrasada que não toma a recuperação da nova aba. Expiração simulada avançando apenas a data no banco exclusivo do ensaio, sem espera real de dois minutos.
- O retorno `pageshow.persisted` foi exercitado por evento no navegador com backend real; não se afirma cobertura de todos os critérios internos de bfcache dos navegadores. Reload e fechamento foram reais. Flash128 sintético restaurou progresso/checksum confirmado antes da execução; nenhum teste utilizou FireRed ou dados pessoais.
- Tipos/build de frontend e backend passaram; imagens locais de ambos construídas. `git diff --check` passou. Não repetidas suítes completas de autenticação/segurança/catálogo/temas/áudio/backup ou matriz do motor. Foram selecionados regressões de respostas perdidas e integridade porque o armazenamento de recuperação passou a verificar proprietário, além da revisão. Evidências anteriores das demais áreas permanecem históricas.

Comandos de seleção (após `docker compose build test-browser`):

```sh
docker compose run --rm --no-deps test-browser node --test --test-name-pattern='takeover|lease exclusiva|lease expirada|save e lease persistem|isola saves por' tests/play.integration.test.mjs
docker compose run --rm --no-deps test-browser npx playwright test player.spec.mjs --grep 'lease:|duas abas do mesmo|resposta perdida|save corrompido'
```

Ensaios criam e removem somente bancos/arquivos próprios; não inserem fixtures nem fazem login/bloqueio no banco ativo. Logs privados: `.local/lease-recovery/api.log`, `browser.log`, `browser-final.log`, builds e atualização. Os casos finais usaram bind mounts somente de leitura do frontend/teste atualizado na imagem de navegador já preparada.

Limites: a aba remota detecta revogação na próxima operação ou heartbeat; rede ausente/suspensão pode atrasar a pausa visual, sem permitir escrita com token antigo. Fechamento abrupto não garante captura final. Pendência isolada nunca é mesclada automaticamente, e storage indisponível não permite alegar recuperação durável. Abas com código anterior à atualização precisam recarregar para receber a nova interface. Nenhum commit/push ou acesso remoto.

Aplicação local concluída com `docker compose up -d --no-deps backend frontend`. Health retornou `{"status":"ok"}`. Comparação privada antes/depois confirmou contas, sessões, catálogo, saves e identidade das reservas idênticos (somente `expires_at` das reservas foi excluído por ser renovável pelo navegador ativo). Container PostgreSQL manteve ID e horário de início. Não houve migração, reset de reserva, escrita de progresso pessoal ou alteração dos arquivos de ROM/capa; arquivos de segurança, volume e AGENTS.md fora do escopo permaneceram iguais ao baseline desta tarefa.

## 30/09/2026 — velocidade de emulação (validação proporcional)

Mudança somente de frontend: seletor/preferências e agendador/áudio do adaptador TypeScript. Core, backend, HTTP, saves, recuperação e banco não foram alterados. Não havia pendência conhecida na entrega anterior de recuperação de reserva. Evidências anteriores de autenticação, segurança, catálogo, temas, volume e takeover permanecem históricas, sem repetição das suítes por rotina.

**9 cenários únicos aprovados**, selecionados pelo impacto direto:

- **2 cenários core GB/GBA** com WASM real e ROMs próprias, controlando timestamps RAF e custo sintético medido pelo orçamento do agendador. Cada cenário verificou os cinco multiplicadores em 60/120/144 Hz (30 combinações no total), comparando contador real de frames com frequência nativa × tempo × velocidade, sem benchmark do PC. Cobriram limite de 12 frames, orçamento de 8 ms com frame sintético de custo 9 ms, descarte de dívida, pausa, troca enquanto pausado/em execução, retorno 1×, suspensão longa, documento oculto, inputs alterando SRAM, uma cadeia RAF e encerramento.
- **1 cenário de áudio** com AudioContext/GainNode/AudioWorklet reais: ativação por gesto CDP no botão, ganho 36%/22%/0, suspensão e nenhum PCM enviado em 10×, limpeza ao retornar, mute/pausa preservados, um contexto fechado no destroy. Uma execução adicional aprovou trocas de velocidade concorrentes e rápidas, retornando a contexto ativo e uma única cadeia RAF. A lógica do processador existente também recebeu PCM sintético não silencioso em teste controlado e produziu zeros após clear. Não houve avaliação auditiva humana; fixtures de jogo silenciosas não comprovam qualidade sonora.
- **4 cenários de interface**: dois de geometria GB/GBA reaproveitados porque o seletor/aviso alteram a barra (proporção, mobile e fullscreen); um de preferência v1 antiga sem velocidade preservando teclas/tamanho/botões/volume, persistência, isolamento, velocidade inválida e storage indisponível; um de pausa/modal/perda de reserva impedindo avanço mesmo ao alterar velocidade. Instrumentação confirmou somente os timers do player de **2.000/30.000 ms**, sem novos registros após trocas rápidas. API simulada nesses testes é evidência de UI/agendamento, não prova de persistência.
- **2 smokes com PostgreSQL/API/core reais**, em banco/contas/arquivos isolados: GB e Flash128 em 10×/3×, input, captura mais recente ao pausar/sair, checksum/versão, token de reserva inalterado ao ajustar velocidade, reabertura com progresso e preferência restaurados, retorno 1×. Nenhuma ROM/save/conta pessoal foi usada.

Tipos/build do frontend e `git diff --check` passaram. A imagem de testes existente forneceu o mesmo core já compilado; fontes do frontend/testes foram montadas somente para leitura. Testes de core/UI rodaram com `--network none`; os dois smokes criaram/removeram somente banco e arquivos próprios. Não houve migração, build/testes do backend, backup completo ou reinício de banco/backend.

A primeira execução de UI teve 3 aprovados e 1 falha no ensaio: a contagem incluía o timer geral de sessão de 30 s. A medição passou a começar antes de iniciar o player, depois do timer da aplicação, e o caso passou. Na revisão do teste de áudio, o clique CDP usava coordenadas fixas fora do botão; corrigido para seu retângulo real, o gesto confiável e a limpeza de fila passaram. Não foram encontradas falhas funcionais nesses dois ajustes de teste.

Logs privados em `.local/speed/`: `core-tests.log`, `ui-tests.log`, `persistence-tests.log`, `final-tests.log`, `audio-final.log`, `audio-gesture-final.log`, `audio-rapid.log` e `frontend-build.log`. Os logs intermediários contêm as falhas de ensaio descritas e não devem ser apresentados como execuções integralmente aprovadas.

Seleção reproduzível na imagem `emulador-game-boy-browser:dev`, com frontend/testes atuais montados:

```sh
npx playwright test player-speed.spec.mjs
npx playwright test player-ux.spec.mjs --grep 'velocidade:|tamanhos, proporção'
# Em docker compose run --rm --no-deps test-browser, com banco isolado criado pelo próprio spec:
npx playwright test player.spec.mjs --grep 'velocidade:'
```

Limites: 10× é alvo, condicionado ao hardware. O orçamento é verificado entre frames, não preempta um frame individual. Acima de 1× o áudio fica temporariamente silenciado; retornar respeita mute/volume e exigências de gesto. Captura nativa/sincronização continuam sujeitas às limitações já documentadas de fechamento abrupto e escrita interna do jogo, sem save state.

Atualização concluída somente com `docker compose up -d --no-deps frontend`. Health local respondeu `{"status":"ok"}`. IDs e horários de início de backend/PostgreSQL antes/depois foram idênticos (`.local/speed/services-before.txt` e `services-after.txt`). Comparação de arquivos com o baseline privado confirmou preservação das alterações anteriores de backend/segurança/recuperação de sessão e AGENTS.md; sem commit/push ou acesso remoto.


## 30/09/2026 — estados e administração de saves

Validação focada na ampliação nova e impactos diretos. Nenhuma suíte completa de login, catálogo, temas, áudio ou matriz de cartuchos foi repetida. Evidências anteriores dessas áreas permanecem históricas. O uso de PostgreSQL/core reais e backup foi necessário porque esta entrega adiciona persistência e exclusão administrativa. Dados de ensaio ficaram em bases/arquivos exclusivos, nunca em jogos/contas pessoais.

Resultados executados:

- `states-core.spec.mjs`: **3 passaram**, ABI real GB/GBA SRAM/GBA Flash128, captura no frame 30, alteração até frame 50 e retorno exato ao frame 30, cartucho íntegro e execução seguinte. Medidas: 71.680/397.312/397.312 bytes de state e 8.192/32.768/131.072 bytes de cartucho. Nenhum shim/core alterado.
- `node --test --test-name-pattern='states:' tests/play.integration.test.mjs`: **2 passaram**, com PostgreSQL isolado. Slots/CAS/retry idempotente, escrita concorrente com um único vencedor, limites de tamanho e quotas de usuário/global, CSRF, isolamento, MASTER sem load alheio, geração de lease/takeover, reset nativo e API reiniciada. Payloads deste teste de contrato são sintéticos; a validade de CPU/RAM é comprovada nos testes reais separados.
- Após revisão de concorrência administrativa, repetido somente `states: slots`: **1 passou**, incluindo dono com trava de usuário em andamento e resposta 409 imediata. Confirmação de exclusão antiga também não apaga novo nativo com versão 1 após reset.
- `playwright test player.spec.mjs --grep 'states:'`: dois cenários de estado GB/Flash128 **passaram**. Save rápido/manual, cancelar substituição, load real, frame exato, cartucho restaurado, payload com checksum incorreto e cabeçalho inválido com checksum correto recusados sem destruir instância anterior, ACK de nativo perdido após commit, retry, saída/reabertura, preferências de velocidade/volume preservadas e exclusão de slot sem alterar nativo.
- Acrescentado e executado separadamente `--grep 'states: toque'`: **1 passou**, Chromium com toque/viewport 390×844 e fullscreen, sem overflow horizontal, quick save, Meus saves separado da administração MASTER, dono identificado na confirmação, recusa de excluir nativo com reserva ativa, exclusão após saída e pendência antiga bloqueada/preservada ao reabrir.
- `node scripts/test-states-backup.mjs`: **passou**, core real GB/Flash128 + API/PostgreSQL próprios; quatro states e dois nativos persistem após reinício da API e carregam frame 30 antes de avançar a 31. Backup v4 restaurado em PostgreSQL temporário sem rede, payloads/metadados/checksums conferidos. A primeira execução teve apenas uma assertion de texto do relatório incorreta; corrigida e ensaio repetido com sucesso, sem falha de restauração.
- Tipos e build de backend/frontend passaram. Após ajuste de navegação, tipos frontend e build da imagem frontend passaram; após ajuste de concorrência, build/tipos backend e teste específico passaram. `git diff --check` sem problemas.

Logs privados em `.local/states/`: `spike.log`, `api.log`, `api-final.log`, `browser.log`, `management-ui.log`, `backup-test.log`, `types.log`, `build.log` e logs das imagens. Baseline de hashes separa as mudanças desta tarefa das anteriores pendentes. Ajustada somente a expectativa de seis migrações no teste histórico de migração; sua suíte não foi repetida por rotina.

Limites: snapshot depende de ROM e WASM exatos; há maior uso transitório de memória durante validação do core candidato. Sem importação/exportação nem histórico de revisões substituídas. State sem memória nativa ainda identificada é recusado se já existir cartucho confirmado mais novo, evitando mistura. Fechar abruptamente antes de confirmar upload não garante o novo state. Áudio antigo é descartado e preferências preservadas, mas não houve avaliação auditiva humana. Chromium com toque não substitui aparelhos físicos ou outros navegadores. Contrato completo em [saves](saves.md).

Aplicação local concluída: backup anterior v4 sem states, restauração isolada com cinco migrações; aplicada somente a migração 006; recriados somente backend/frontend. PostgreSQL/volume permaneceram os mesmos. Comparação de contagens/fingerprints de contas, catálogo e saves nativos antes/depois foi idêntica. Backup final v4 restaurado com seis migrações, arquivos/checksums preservados e nenhum state pessoal criado pelo ensaio. Health via frontend retornou `status: ok`; somente `127.0.0.1:5173` publicado. Logs privados `pre-backup.log`, `pre-restore.log`, `migrate-active.log`, `update-services.log`, `before.json`, `after.json`, `final-backup.log` e `final-restore.log`. Sem commit/push; alterações anteriores preservadas.

## 30/09/2026 — fechamento documental e revisão para commit

Revisados guia passo a passo, contratos, README, operação e continuidade contra a implementação atual: um nativo e quatro states, exclusão/administração, reserva após refresh, recuperação pendente e preferências. Removidas contradições vigentes e duplicações de procedimentos; registros de etapas anteriores permanecem históricos. Comandos/variáveis conferidos em package.json, Dockerfile, Compose, exemplo público de configuração e scripts, sem executar manutenção.

Validação desta etapa: links locais e âncoras conferidos, revisão de versões/comandos/coerência, conteúdo elegível e staged inspecionado e `git diff --check`. Nenhum build ou teste da aplicação foi repetido; resultados das entregas anteriores foram reutilizados com seu escopo original. Não houve alteração funcional nem operação de banco/serviços. Arquivos privados, assets gerados, dependências e dados pessoais ficam fora do commit.

## 01/10/2026 — volume, mobile e D-pad

Resultados das implementações anteriores a este fechamento, conferidos nos logs locais; não são execuções novas da revisão documental:

| Etapa | Evidência executada |
| --- | --- |
| Volume | 1 cenário Chromium: 0/50/100%, mouse/teclado/toque, temas claro/escuro, ganho real, mute e preferência. Inspeção visual dos extremos; tipos/build frontend passaram |
| Mobile/fullscreen | 6 cenários focados de `player-ux.spec.mjs` passaram: proporções GB/GBA, tamanhos, fullscreen, fallback indisponível/recusado, Escape/Voltar, orientação simulada, controles ocultos, multitoque/cancelamento e volume. Verificação adicional de volume no painel fullscreen: 1 passou. Tipos/build frontend passaram |
| Refinamento D-pad | 3 cenários selecionados passaram: layout/fullscreen GBA, fallback/orientação/centro neutro/diagonal+A e liberação por cancelamento/foco/saída. Inspeção visual portrait/landscape e temas. Build frontend, incluindo tipos, passou |

Ensaios usaram React/mGBA reais, ROMs próprias sintéticas e API simulada em container sem rede/banco. Viewports incluíram 390×844, 844×390, 667×320 e 568×256, além de desktop. Não equivalem a aparelho físico, notch real ou navegador móvel; não houve ensaio de qualidade auditiva humana. Contratos de backend/saves não mudaram e suas evidências anteriores não foram repetidas. Somente frontend foi atualizado nas implementações; identidade/início de backend e banco permaneceram iguais. Usuário aprovou volume e D-pad.

Logs/capturas ignorados pelo Git: `.local/volume/`, `.local/mobile-player/` e `.local/dpad-refine/`. Seleção documentada nos logs `check.log`, com `volume-fullscreen.log` na etapa mobile; contagens se sobrepõem e não representam uma suíte completa adicional.

Neste fechamento: revisão dos arquivos pendentes e staged, links/âncoras locais, comandos/variáveis contra Compose/scripts e `git diff --check`. Inspeção somente leitura dos arquivos de migração dos containers confirmou a [pendência operacional](operacao.md#pendência-local-de-init-antigo--01102026); não consultou progresso pessoal nem executou migrações. Nenhum build/teste de aplicação novo, operação de dados/serviços ou implantação remota.

## 01/10/2026 — segurança em quatro etapas

Baseline `5a771c8`; código/configuração preparados, **sem migração ou atualização do ambiente pessoal e sem operação remota**. PostgreSQL 18.6, APIs e redes de ensaio próprios, sem portas públicas/volumes pessoais; contas e ROMs sintéticas. Relatório privado conferido como evidência, não autorização de servidor. Matrículas MFA exclusivamente sintéticas.

| Verificação atual | Resultado |
| --- | --- |
| `security.integration.test.mjs` | **10 passaram**: três falhas/IP, janela/expiração sem esperar duas horas, duas APIs concorrentes, IPs/spoofing, desafio por nome/replay/conta inexistente, troca de senha sob pressão, cardinalidade/admissão e sessão/ROM/heartbeat/save preservados. Desconectar cliente não libera vaga antes de acabar o hash; limpeza periódica observada após aproximadamente 60 s sem login, mantendo bloqueio ativo. |
| Casos afetados de `auth.integration.test.mjs` | **2 passaram**: pressão por nome persiste após restart sem lock de conta e bloqueio IP ignora cabeçalho forjado. Sem executar a suíte completa. |
| Casos states/SEC-07/SEC-06 de `play.integration.test.mjs` | **4 passaram**: slots/permissões, orçamentos/retry idempotente/expiração/restart, auditoria sem senhas/cookies/CSRF e retenção/anel; 24 transações de orçamento concorrentes resultaram em exatamente 10 sucessos e 14 respostas 429. |
| `mfa.integration.test.mjs` | **4 passaram**: matrícula confirmada/cifra, sessão restrita, recuperação concorrente de uso único, senha+MFA recente, CSRF/revogação, inatividade/TTL, anti-replay após restart, jogador recusado, limite por ator e segredo adulterado recusado. |
| `runtime.integration.test.mjs` | **2 passaram**: instalação nova e upgrade 001–006→010 preservam bytes/versões de nativos/states; API real com papel runtime lê/grava. DDL, TRUNCATE, TEMP, escrita em migrações, SET ROLE e criação de papéis recusados. Migrações repetidas permanecem idempotentes; 001–006 inalteradas. |
| Chromium `security-ui.spec.mjs` | **4 passaram**: prova em worker, cadastro MFA/códigos efêmeros e execução real GB/GBA com CSP no HTML, WASM e worklet sem violações no fluxo ensaiado. API simulada somente nesses cenários de interface. |
| Chromium `csp-build.spec.mjs` | **2 passaram** com build real: tema inicial, player GB/GBA e áudio/worklet sem violações. Script inline de controle produziu evento com disposição `report`, comprovando Report-Only; não é enforcement. |
| Smoke `player.spec.mjs`, `states: GB slots reais…` | **1 passou**, core + API + PostgreSQL reais: slots, retorno exato, cartucho e ACK perdido. Fixture master deste teste prepara somente autorização sintética; MFA real é exercitado separadamente. |
| Backup/restauração do impacto runtime/schema | Bundle v4 lido via runtime e restaurado em outro banco isolado; um nativo e um state GB gerados pelo core, metadados e coluna MFA preservados. Grants reaplicados após dump sem ACL; runtime leu o estado, core restaurou frame 30, avançou a 31 e preservou cartucho. Não foi um ensaio de perda da chave MFA nem restauração integral em outra máquina. |
| Containers/redes preparados | PostgreSQL novo com restrições iniciou/provisionou; API readonly/sem capabilities e frontend sem root/readonly iniciaram. Frontend com 512 MiB: HTML/CSP e proxy/health 200; DNS e TCP direto ao banco recusados. Reexecução do provisionamento isolado preservou papel/senha. |
| Estático | Builds de backend/frontend passaram durante a implementação; o último build backend teve um erro de tipo, corrigido e verificado no fechamento abaixo; `docker compose --env-file .env.example config --quiet`, links locais e `git diff --check` conferidos. |

A seleção cobre os achados e os caminhos compartilhados alterados. A concorrência ampliada revelou e corrigiu inversão de travas entre cadastro de contadores e orçamento: criação de chaves ocorre antes da transação de save; débito permanece atômico com a gravação. A admissão foi corrigida para manter vagas de requisições abortadas enquanto o trabalho termina. O teste do build justificou externalizar o worklet antes embutido como `data:`, sem ampliar permissão de scripts. Esses ajustes foram revalidados nos respectivos casos; falhas intermediárias não são contabilizadas como aprovação.

Não foram repetidas suítes completas de catálogo/temas/motor nem testes físicos de celular ou escuta subjetiva de áudio. Evidências anteriores de saves/core/layout permanecem históricas; o smoke acima é a execução nova. Logs privados do ensaio ficam em `.local/security-2026-10/`, sem integrar Git. Recursos descartáveis foram removidos ao concluir; backup sintético/evidências locais permanecem ignorados.

Limites: prova de trabalho não impede botnet; admissão em memória é por instância; auditoria é amostrada e pode perder eventos; CSP permanece Report-Only. Aplicação em dados pessoais/servidor, guarda externa da chave, inscrição humana de MFA, proxy/túnel/IP público, enforcement CSP e backup externo continuam na [matriz SEC/OPS](seguranca.md#matriz-de-entrega-e-aceite-pendente).

### Fechamento para commit local

Revisados os 68 arquivos da etapa, scripts de instalação/upgrade/recuperação, links locais/âncoras, conteúdo elegível/staged e `git diff --check`. Os 29 casos e builds anteriores não foram repetidos. A conferência dos logs identificou TS2532 no último build backend: o prazo opcional da consulta passou a usar `?? 0` antes da comparação, preservando a decisão anterior quando não há linha. `npm run typecheck --workspace backend` passou após esse ajuste pontual; nenhum build completo ou teste comportamental foi reexecutado. Evidências intermediárias com falha não são aprovação final. Sem operação de serviços/dados, aplicação das migrações ou cadastro MFA pessoal neste fechamento.
