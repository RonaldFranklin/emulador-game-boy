# Histórico técnico

As entradas descrevem cada etapa no momento em que foi executada; limitações antigas podem ter sido resolvidas em etapas posteriores. Identidades locais e procedimentos administrativos particulares ficam fora deste histórico público.

## 29/09/2026 — Definição inicial

Consolidados o backend NestJS modular, React/Vite/TypeScript, PostgreSQL, Docker Compose local, perfis MASTER/JOGADOR e save único por usuário/jogo. O escopo inicial somente GB foi ampliado posteriormente para GB/GBA. A documentação passou a ser critério de conclusão de cada entrega.

## 29/09/2026 — Primeira entrega de aplicação e autenticação

Após autorização expressa, implementados backend NestJS modular, frontend React/Vite em TypeScript, PostgreSQL e Compose exclusivamente local `emulador-game-boy-dev`. Versões estáveis consultadas em fontes oficiais e fixadas no lockfile. Login por usuário/senha, Argon2id, sessões persistidas, cookie HttpOnly, proteção de origem/CSRF, limitação persistida de tentativas, validação e autorização no backend. Master cria/lista/bloqueia jogadores e redefine senha temporária; usuários trocam a própria senha; revogações são transacionais. Bootstrap master interativo sem eco ou senha padrão. Catálogo vazio explícito, sem emulador, jogos ou saves.

Criados scripts de setup, backup, restauração isolada e recuperação em banco novo com sessões revogadas. README substituído pelo guia reproduzível; decisões, regras, desenvolvimento, índice e estado do AGENTS atualizados. Adicionados docs/autenticacao.md e docs/validacao.md com contrato, fontes, evidências e pendências. Documentação anterior mantida como histórico.

Validados npm ci, builds, tipos, Compose, bootstrap em TTY, 16 testes de API, 1 cenário Chromium desktop/celular, persistência de 2 contas/2 sessões após reinício real de PostgreSQL/API, backup populado e restauração em container isolado. Recuperação em novo banco preservou contas, revogou sessões e autenticou com o papel de aplicação. Auditoria npm: zero vulnerabilidades reportadas. Corrigidos permissões de secrets montados, prontidão inicial do PostgreSQL, publicação de loopback via rede própria e verificação do formato Argon2. Detalhes em docs/validacao.md.

Bibliotecas do Chromium ausentes no host e sudo indisponível impediram sua execução direta. Teste visual concluído na imagem oficial Playwright em container autorizado, sem alterar controles do host. A aplicação permanece em http://127.0.0.1:5173; o operador precisa criar seu master real pelo comando seguro documentado. Contas fictícias ficaram somente em bases efêmeras e foram removidas por seus testes. Dados/volumes existentes e Git preservados; sem commit, push, publicação ou acesso ao servidor.


## 29/09/2026 — Revisão de segurança da comparação CSRF

Atendida a revisão do coordenador sobre comprimentos de string versus bytes em `timingSafeEqual`. A versão inspecionada já recusava tokens não ASCII pelo formato base64url de 43 caracteres. Reforçada `csrfMatches` com buffers UTF-8 e comparação explícita dos seus tamanhos antes da comparação criptográfica; removida a dependência do comprimento JavaScript.

O caso Unicode foi separado em regressão HTTP dedicada: mesmo comprimento JavaScript e tamanho UTF-8 diferente, resposta 403 e sessão original ainda válida (200). Build e tipos do backend passaram; 17 testes de API aprovados (12,49 s) e cenário completo de navegador reaprovado (6,6 s). Imagens reconstruídas, backend local atualizado e documentação de autenticação/evidências/estado revisada. Testes operacionais de backup e persistência anteriores continuam válidos; não houve alteração de esquema, migrações, volumes ou mecanismos de recuperação. Sem commit, push ou acesso ao servidor.


## 29/09/2026 — Compatibilidade de autenticação legada

Separadas as validações de autenticação e criação: login e confirmação da senha atual aceitam credenciais existentes não vazias até 128 caracteres; bootstrap, criação, reset e nova senha continuam exigindo 12–128. A mudança permite verificar hashes legados sem permitir criação de senhas fracas pelos fluxos normais. Build/tipos e 18 testes de API passaram, incluindo revogação após troca. Não foi introduzido seed ou senha padrão.

## 29/09/2026 — Tema claro e escuro

Usuário aprovou o login e autorizou exclusivamente tema claro/escuro antes do catálogo/emulação. Adicionado botão **Escuro** junto à marca no login e no cabeçalho autenticado MASTER/JOGADOR, disponível por teclado/toque em desktop/mobile. Nome estável e `aria-pressed`; paleta verde com cartões, campos, texto, alertas, modais, hover e foco adaptados. Preferência explícita `light`/`dark` salva apenas em localStorage; sem escolha válida segue o sistema, com fallback claro e tolerância a storage indisponível. Script e fundo crítico no início do HTML evitam flash claro antes de carregar React.

Build e tipos do frontend aprovados. Suíte específica com 32 cenários Chromium e API simulada passou em 15,1 s, cobrindo seleção inicial, pré-pintura, falhas de storage, teclado, abas, persistência após reload/logout nos dois perfis/temas, contraste e telas de 320/390/1280 px. Capturas locais inspecionadas. Sem dependências novas ou alteração do lockfile. Atualizados README, decisões, desenvolvimento, validação, índice e estado.

Reconstruído somente target frontend e recriado serviço com `--no-deps`; acesso local mantido em `http://127.0.0.1:5173`. Backend e PostgreSQL com IDs/horários de início preservados. Nenhuma alteração em auth, contas ou banco, nenhum reinício desses serviços e nenhum teste backend adicional. Volumes e Git preservados, sem servidor/commit/push. A ampliação funcional seguinte foi tratada em uma etapa separada.


## 29/09/2026 — Primeira etapa do catálogo

Após aprovar o tema verde escuro, usuário autorizou exclusivamente catálogo. Implementados cadastro MASTER com nome/ROM .gb/capa opcional/disponibilidade, edição de nome/capa/disponibilidade, UUID estável, ROM imutável e SHA-256 único. Jogador recebe somente ativos; capa tem rota autorizada respeitando disponibilidade. Sem exclusão, download de ROM, emulação ou saves; Jogar desabilitado com explicação. Temas e administração de usuários preservados.

Validação estrutural baseada em Pan Docs; limites explícitos de ROM, capa, multipart, concorrência e armazenamento. Multer 2.4.0, Sharp 0.35.5 e tipos fixados no lockfile. Arquivos privados em volume dedicado, nomes gerados, PNG reprocessado, autorização antes do parser, trava PostgreSQL e tratamento de rollback/commit ambíguo. Capas antigas/resíduos retidos com quota e política documentada.

Backup e restauração ampliados para banco+arquivos+manifesto, com trava comum e recuperação em banco/volume novos. Backup anterior à migração restaurado com duas contas/duas sessões. Migração 002 aplicada sem alterar essas contas/sessões; assinatura dos usuários conferida. Backend/frontend atualizados localmente, PostgreSQL não reiniciado, somente loopback5173. Catálogo ativo terminou vazio, sem fixtures. Volumes existentes preservados.

Build/tipos aprovados, auditoria npm sem vulnerabilidades, 34 testes de API e 35 cenários Chromium aprovados. Ensaio sintético validou reinício real da API, persistência em volume, backup conjunto, arquivo adulterado recusado, restauração isolada e recuperação com API/role de aplicação. Incluído caso de resíduo vazio após interrupção. Evidências em docs/validacao.md; README, contrato catálogo, decisões, regras, autenticação, desenvolvimento, índice e AGENTS atualizados. Sem servidor, commit, push ou publicação. Próxima etapa funcional depende de nova autorização.


## 29/09/2026 — Catálogo ampliado para GB + GBA

Usuário autorizou expressamente incluir Game Boy Advance neste projeto, substituindo a restrição anterior somente GB. Implementado console `GB|GBA` persistido/retornado pela API e imutável junto da ROM. Migração 003 atribui GB aos registros antigos sem alterar bytes, UUIDs ou hashes. GBA até 32 MiB com validação de cabeçalho/fixos/reservados/complemento baseada em GBATEK/mGBA e gbafix; GB mantém critérios anteriores e GBC exclusivo continua fora. Multipart/memória e armazenamento `.gba` ajustados sem ampliar quota global.

UI mostra console detectado no cadastro e selos na lista/biblioteca/edição; temas, usuários e edição de nome/capa/status preservados. Jogar continua desabilitado, nenhum core, emulador ou save implementado. Documento vigente separa console persistido da futura escolha de core e mantém nomes do repositório/pasta/Compose.

Backup v2 inclui console e ambos os tipos; v1 GB continua compatível. Backups reais antes da migração restaurados isoladamente; catálogo GB populado migrado sem perda em ensaio, recuperação v1 e recuperação mista v2 aprovadas. Build/tipos, 41 testes e 35 cenários Chromium passaram. Backend/frontend locais atualizados; PostgreSQL não reiniciado, 2 contas/2 sessões integralmente preservadas, catálogo ativo com 0 jogos e sem fixtures. Somente 127.0.0.1:5173, sem servidor/commit/push. README, AGENTS, decisões, regras, contrato, desenvolvimento e evidências atualizados.

## 29/09/2026 — Player GB/GBA e save nativo

Usuário aprovou o catálogo e autorizou emulação completa com persistência mínima, preservando catálogo, contas e volumes preexistentes. Integrado mGBA WebAssembly com adaptador próprio, console mapeado no servidor, fontes/compilador fixados, licença/atribuição e fontes correspondentes servidas localmente. Spike real corrigiu restauração GBA no wrapper antes do primeiro frame; GB SRAM, GBA SRAM e Flash128 validados. Sem CDN em runtime, BIOS externa ou jogos distribuídos.

Jogar habilitado para ativos. Player com proporções GB/GBA, teclado/toque/L/R, pausa/retomada, áudio por gesto, tela cheia com controles, estados de erro e descarte. API de ROM autenticada, integridade e limite de leitores; não há botão de download ou promessa de DRM. Migração 004 cria save nativo bytea único por usuário/jogo e reserva exclusiva por sessão, com versão, checksum, quota e repetição idempotente. Recuperação local segregada, sem save state/importação/exportação/slots/administração de saves.

Corrigidas e testadas revisões de aviso não fatal de áudio/fullscreen, keyup após foco mudar, heartbeat durante carga lenta, captura sucessora antes de retry/saída sob commit ambíguo, pausa durante envio pendente, integridade antes de apagar recuperação e limpeza de timers. Build/tipos, 57 testes API, 49 cenários Chromium e recuperação operacional mista v3 com saves passaram. Compatibilidade de backups v1/v2 mantida. Smoke autorizado de cartucho existente somente leitura confirmou animação/áudio, sem gravar progresso.

Backup conjunto verificado antes de migrar e após atualizar. Backend/frontend locais recriados; PostgreSQL manteve container/início, contas/sessões e todos os metadados/arquivos preexistentes preservados. Nenhuma fixture inserida no ativo. README, contratos, decisões, fontes/licenças, regras, desenvolvimento, evidências e AGENTS atualizados. Acesso somente http://127.0.0.1:5173; sem servidor, commit, push, rename ou publicação. Limitações reais e pendências operacionais registradas; próxima ampliação depende de autorização.

## 30/09/2026 — Documentação pública e bootstrap inicial

README reduzido a instalação e uso essencial, com detalhes preservados em `docs/operacao.md` e `docs/guia-de-uso.md`. Desenvolvimento, índice e histórico foram generalizados para remover identidades, caminhos e infraestrutura pessoais. Contratos antigos foram alinhados às rotas de player/saves já existentes; referências técnicas e resultados anteriores foram preservados.

Implementado o primeiro master por `.env` privado e serviço temporário após migrações, com trava/transação compartilhadas pela alternativa interativa. Sem senha padrão, promoção de jogador ou redefinição de master existente. Senha literal com `$`, validação de aspas e recriação da montagem após edição atômica foram testadas e documentadas. Build/tipos, 65 testes API, regressão integrada Chromium e dois roteiros de primeiro boot isolados passaram. Backups anterior/final restaurados; todas as linhas do banco e arquivos pessoais preservados, sem gravar progresso de teste no ativo.

O usuário autorizou expressamente o **primeiro commit local** do baseline funcional e desta melhoria, após revisão de todos os arquivos elegíveis e staged. Documentação privada original preservada em `.local`; fontes, licenças e reprodução do motor mantidas. Configuração/autor Git existentes preservados. Nenhuma autorização para push/publicação ou servidor. Resultados e limites estão em [validação](validacao.md#bootstrap-e-documentação-pública--30092026).
