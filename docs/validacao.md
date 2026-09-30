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

Chromium com viewports móveis não substitui aparelhos físicos, Safari/Firefox ou teste auditivo humano. Há sinal PCM real, mas a qualidade/performance precisa de avaliação pelo usuário no seu equipamento. O núcleo upstream fixado é uma revisão de desenvolvimento; não há matriz completa de cartuchos, EEPROM, RTC, sensores ou acessórios validada. Não há BIOS proprietária, save state, importação/exportação, múltiplos slots ou administração de saves.

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
