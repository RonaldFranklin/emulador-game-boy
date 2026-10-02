# Decisões e arquitetura

Atualizado em 30/09/2026. Estado: segurança, catálogo GB/GBA, player, saves nativos/estados, administração e bootstrap pela `.env` implementados; resultados em [validação](validacao.md).

## Objetivo
Site para jogar Game Boy e Game Boy Advance no navegador, com acesso por conta, catálogo administrado pelo master e progresso individual. A execução atual é local; exposição externa exige planejamento e configuração próprios.

## Tecnologias aprovadas
| Responsabilidade | Tecnologia |
| --- | --- |
| Runtime do backend | Node.js |
| Linguagem | TypeScript no frontend e backend |
| Backend | NestJS |
| Frontend | React com Vite |
| Banco | PostgreSQL |
| Execução | Docker Compose |
| Organização | Um repositório, frontend e backend separados; backend modular único |

NestJS foi escolhido pela organização e convenções para autenticação, usuários, jogos e saves, considerando a preferência do usuário. React/Vite atende à interface interativa. Next.js e Fastify como framework principal foram alternativas discutidas e substituídas pela escolha acima. A primeira entrega usa o adaptador Express 5 do Nest.

O servidor entrega a aplicação e os dados autorizados; a execução do emulador ocorre no aparelho cliente. A interface não oferece download de ROM. Tecnicamente o navegador precisa receber os dados do jogo para executá-lo; isso não garante impedir sua extração pelo cliente.

## Escopo
- Game Boy (GB) e Game Boy Advance (GBA); master e jogadores; catálogo; um nativo, um Save rápido e três slots manuais por usuário/jogo.
- Futuro possível: visitante para demonstração com tempo limitado, ainda sem regras aprovadas para implementação.
- Por autorização expressa posterior, GB e GBA fazem parte deste mesmo projeto. Essa decisão substitui a restrição anterior somente GB; GBC exclusivo e demais consoles continuam fora. Nome do repositório/pasta preservado.
- Streaming no servidor não faz parte da arquitetura escolhida.

## Decisões da primeira entrega

| Item | Versão/decisão | Motivo |
| --- | --- | --- |
| Node.js | 24.21.0 no Docker; local validado 24.16.0 | Linha 24 LTS, compatível com Nest/Vite |
| npm | 11; host 11.13.0, imagem 11.19.0 | Workspaces simples e lockfile único |
| NestJS | 12.1.1, Express 5.2.1 | Backend único com módulos e guards globais |
| React / React DOM | 19.3.0 | Versão estável consultada no projeto oficial e npm |
| Vite / plugin React | 8.3.1 / 6.1.1 | Build e servidor local com proxy de mesma origem |
| TypeScript | 6.0.3 | Linha estável compatível com os decorators de Nest; atualização para 7 adiada |
| PostgreSQL | 18.6, imagem bookworm | Linha suportada; volume em `/var/lib/postgresql` conforme imagem 18 |
| Acesso ao banco | pg 8.23.0, SQL parametrizado, sem ORM | Esquema pequeno; migrações SQL explícitas, transacionais e verificadas por checksum |
| Senhas | argon2 0.45.1, Argon2id 64 MiB/3/1 | Hash adaptativo, salt próprio da biblioteca, sem senha padrão |
| Testes | Node test runner + Playwright 1.63.0 | API real com PostgreSQL e navegador Chromium em container local |

Repositório organizado em `backend/`, `frontend/`, `scripts/`, `tests/`, `docker/` e `docs/`. Dependências diretas exatas, `package-lock.json` único, instalação com `npm ci`. Sem Redis, JWT, autenticação social ou microserviços.

Sessão opaca persistida no PostgreSQL, cookie HttpOnly/SameSite=Strict e token CSRF derivado por sessão. Origem exata e cabeçalho AJAX obrigatórios nas mutações, inclusive login. Guards e revalidação transacional protegem operações administrativas. Autenticação e confirmação de senha atual aceitam valores existentes não vazios até 128 caracteres; bootstrap, criação, redefinição e nova senha mantêm a política de 12–128. Essa separação permite verificar credenciais curtas existentes sem permitir sua criação pelos fluxos normais. Detalhes e contratos em [autenticação](autenticacao.md).

Compose exclusivamente local, nome explícito `emulador-game-boy-dev`, interface em `127.0.0.1:5173`. Rede privada interna para banco/backend; uma segunda rede permite a publicação da interface em loopback. PostgreSQL não publica porta. O papel da aplicação não é superusuário nem cria bancos; migrações pertencem a esse papel. Credenciais geradas em arquivos ignorados pelo Git e montadas como secrets. Backend e frontend executam sem root; a exceção temporária de bootstrap está descrita abaixo.

Backup manual via `pg_dump`, checksum SHA-256 e restauração verificável em container sem rede/volume. Recuperação efetiva cria um banco novo, sem sobrescrever o ativo, com sessões restauradas revogadas. Política local e operação estão no [guia de operação](operacao.md). Retenção externa, criptografia e objetivos de recuperação não foram definidos para uma eventual implantação externa.

### Fontes oficiais consultadas

- [Node.js — ciclo de versões](https://nodejs.org/en/about/previous-releases) e [releases do Node](https://github.com/nodejs/node/releases).
- [NestJS — migração para 12 e compatibilidade](https://docs.nestjs.com/migration-guide).
- [React — versões](https://react.dev/versions).
- [Vite — requisitos](https://vite.dev/guide/) e [Vite 8](https://vite.dev/blog/announcing-vite8).
- [TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).
- [PostgreSQL — versões suportadas](https://www.postgresql.org/support/versioning/) e [imagem oficial](https://hub.docker.com/_/postgres).
- [OWASP — armazenamento de senhas](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Versões exatas conferidas também com `npm view` no registro público, além de build/testes reais. Tags Docker de versão são fixas; digests obtidos nesta validação estão em `validacao.md`. Atualizações precisam de revisão e nova execução dos testes.

## Tema da interface — 29/09/2026

Etapa autorizada após aprovação do login pelo usuário, restrita ao frontend. Dois temas com identidade verde Game Boy, selecionados pelo mesmo botão acessível no login e no cabeçalho MASTER/JOGADOR. Tokens CSS controlam superfícies, texto, bordas, campos, alertas, foco, hover e diálogos. `color-scheme` acompanha o tema para controles nativos.

Preferência explícita local por origem/navegador na chave `emulador-theme`, com os únicos valores válidos `light`/`dark`; nenhuma preferência é gravada no banco. Sem escolha válida, acompanha `prefers-color-scheme`, inclusive suas mudanças, com fallback claro. Escolha manual prevalece e é compartilhada entre abas. Leitura/gravação protegidas contra exceções; se storage falhar, o controle mantém a escolha em memória enquanto a página estiver aberta. Credenciais e sessão continuam fora do localStorage.

Script síncrono e fundo crítico no início de `index.html` definem `data-theme` antes dos módulos React e CSS para evitar flash claro. O módulo React compartilha o estado com `useSyncExternalStore`, sem dependências novas. A lógica inicial de seleção no HTML deve continuar equivalente à do módulo e é exercitada com carregamento React bloqueado no teste de navegador.

Suíte específica com API simulada e container sem rede externa/banco verifica a interface, sem expandir ou repetir testes de autenticação. Atualização local por `docker build --target frontend --tag emulador-game-boy-frontend:dev .` e `docker compose up -d --no-deps frontend`, preservando os serviços e dados existentes.

## Primeira etapa de catálogo — 29/09/2026 (histórico)

Usuário aprovou o tema verde escuro e autorizou somente catálogo, sem emulação/saves. MASTER cadastra nome/ROM/capa/disponibilidade e edita nome/capa/disponibilidade. JOGADOR recebe apenas jogos ativos; capa usa rota autenticada com o mesmo filtro. UUID estável, ROM imutável protegida também por trigger e SHA-256 único no PostgreSQL. Sem exclusão definitiva nem rota de leitura/download da ROM; Jogar desabilitado na biblioteca.

ROM `.gb` estruturalmente válida, 32 KiB–8 MiB; capas PNG/JPEG estáticas até 2 MiB e 4 milhões de pixels. Aceitação DMG e dual-mode `0x80` não promete emulação de CGB ou compatibilidade futura de core. Critérios, fontes primárias e contrato em [catálogo](catalogo.md).

Adicionados Multer **2.4.0**, Sharp **0.35.5** e tipos Multer **2.3.0**, versões estáveis conferidas no registro oficial npm e documentação dos projetos, compatíveis com Node 24. Versões diretas exatas e árvore fixada no lockfile. Multer interpreta multipart só depois dos guards; Sharp decodifica e recodifica capas. Limites de bytes/campos/pixels/prazo e duas operações concorrentes contêm recursos.

Arquivos fora da raiz pública, em volume Docker privado montado somente no backend. Escrita exclusiva com UUID, fsync antes do commit e trava PostgreSQL comum ao catálogo/backup. Rollback conhecido limpa somente arquivos próprios; commit ambíguo ou queda pode reter resíduos, contabilizados na quota (8 GiB/10.000 arquivos/1000 jogos). Capas antigas permanecem privadas. Coleta automática adiada; não excluir manualmente sem reconciliação.

Backup passou de dump isolado para pasta com dump, arquivos e manifesto/checksums sob a mesma trava. Restauração verifica referências e bytes em ambiente sem rede; recuperação cria banco **e** volume novos e revoga sessões restauradas, sem trocar `.env` automaticamente. Dumps anteriores sem jogos continuam verificáveis. Testes usam ROMs/capas sintéticas geradas, banco e volumes próprios, sem fixtures na biblioteca ativa.

## Ainda a definir
- Retenção de cópias internas, exclusão recuperável, backup externo e objetivos de recuperação.
- Quantidade de usuários/aparelhos de validação e eventual revisão dos limites locais de catálogo.
- Ambiente remoto, portas, domínio e mecanismo de acesso externo.

Não incluir Redis, microserviços ou storage de objetos por suposição. Qualquer ampliação deve ter necessidade e decisão registradas.


## Ampliação expressa para GB + GBA — 29/09/2026 (histórico)

O usuário substituiu a restrição somente GB: este mesmo projeto passa a aceitar Game Boy e Game Boy Advance. GBC exclusivo e demais consoles continuam fora. Repositório, pasta, Compose e identidade verde permanecem com seus nomes existentes. A autorização é apenas para tipos de ROM e catálogo, sem emulação ou saves.

Console `GB|GBA` persistido junto da ROM, imutável e retornado pela API. Nova migração incremental identifica os jogos anteriores como GB sem converter ou renomear arquivos. Extensão precisa corresponder ao cabeçalho validado. GB preserva sua política; GBA admite 192 bytes–32 MiB com logo, campos fixos/reservados e complemento, conforme fontes do contrato. Essa admissão não demonstra compatibilidade de execução.

Multipart cresce para 32 MiB + 2 MiB + 64 KiB, mantendo duas operações simultâneas e quota global de 8 GiB. Não há dependências novas nesta ampliação. Manifesto v2 registra console e aceita ambos os tipos; v1 continua válido como GB. Recuperação confere tipo/extensão/tamanho e hashes, preservando banco/volume ativos.

O formato persistido não fixa core: o player futuro fará o mapeamento em código após integração/testes. Projetos como mGBA suportam mais de um console, mas nenhuma biblioteca/core foi escolhida ou carregada nesta entrega. Interface apenas informa console e mantém Jogar desabilitado.


## Emulação e save nativo — base histórica, ampliada por states

Usuário aprovou o catálogo e autorizou player completo GB/GBA com persistência mínima. EmulatorJS foi avaliado; sua integração geral e persistência automática exigiriam conciliar outra camada de filesystem/armazenamento. Escolhido adaptador direto da ABI C de mGBA-wasm, sem SDK/OPFS/IDBFS. Um core fixado atende ambos os consoles, com mapeamento explícito em código a partir do console persistido. GB é forçado a DMG, mesmo dual-mode. Detalhes de fontes, licenças e build em [fontes do motor](fontes-emulador.md).

O spike real revelou que a função SRAM load do wrapper publicado retornava sucesso sem restaurar GBA em autodetecção. Patch mínimo usa loadSave com arquivo em memória antes do primeiro frame. O core upstream não é alterado. Fontes exatas e alteração são servidas junto do runtime, compilado no Docker sem rede após download com hashes fixos. Sem CDN em execução, BIOS proprietária ou jogos distribuídos. Escolha usa commit de desenvolvimento upstream fixado; atualizações exigem repetir a matriz de testes, não acompanhar latest.

Save nativo em PostgreSQL bytea, 1 MiB por usuário/jogo, quota global 1 GiB/10 mil; sem filesystem adicional para saves nem commit dividido entre arquivo e SQL. Migração 004 incremental. Reserva de 120 s renovada a cada 30 s e versão esperada permitem conflito explícito; repetição idempotente evita duplicar commit quando a resposta se perde. Escritas atômicas e checks de integridade no banco. Manifesto v3 inclui saves no dump, mantendo leitura de v1/v2. Contrato e recuperação local no IndexedDB em [emulação](emulacao.md).

Na entrega inicial, a UI sincronizava alterações de cartucho, sem save states. Recuperação local segregada por usuário/jogo confirma a pendência antes de enviá-la, e preserva a sequência original/sucessora sob resposta ambígua. A ampliação posterior adicionou states/administração conforme [contrato vigente](saves.md); importação/exportação continuam fora. O estado remoto só é considerado confirmado pela resposta íntegra do servidor. Interrupções abruptas continuam sujeitas a perda da última mudança.

## Bootstrap automático do primeiro master — 30/09/2026

O fluxo de instalação usa campos locais `ADMIN_USERNAME`/`ADMIN_PASSWORD`, inicialmente vazios em `.env.example`, e um serviço `bootstrap` que termina após executar. Ordem: banco saudável → migrações concluídas → bootstrap concluído → API. O objetivo é permitir instalação e primeiro login sem SQL manual ou comando de criação adicional.

O `.env` real permanece ignorado e com `0600`; somente o bootstrap recebe o arquivo selecionado como secret somente leitura. `BOOTSTRAP_ENV_SOURCE` vale `./.env` no exemplo/setup; seletor ausente ou vazio usa `.env.example`, cujas credenciais são vazias. Configurações legadas recebem o seletor ao executar o setup, sem sobrescrever valores existentes. As credenciais são interpretadas por `node:util.parseEnv`, sem avaliação pelo shell e sem encaminhamento como environment/build/frontend. O serviço temporário usa root apenas no sistema de arquivos do container para ler o secret com qualquer UID de host; mantém o papel PostgreSQL limitado da aplicação. Backend/frontend seguem sem root.

Sem master, campos ausentes, parciais ou inválidos falham antes de liberar a API. Master existente é preservado, inclusive quando o `.env` contém outras credenciais. O parser exige senha em linha única entre aspas simples, sem apóstrofo interno nem barra invertida final, e recusa chaves duplicadas; assim evita diferenças silenciosas de parsing entre Compose e Node. O comando interativo com TTY permanece como alternativa para essas senhas e para quem não deseja gravar a credencial inicial em arquivo. Não há senha padrão, seed, redefinição automática ou promoção de conta. A versão de setup preserva os valores locais existentes. Resultados específicos desta alteração estão registrados em [validação](validacao.md#bootstrap-e-documentação-pública--30092026); resultados anteriores não comprovam o novo fluxo.


## Limites de login e IP confiável — 30/09/2026

Implementado o pedido de três falhas por IP numa janela móvel de duas horas, seguido de bloqueio de login por duas horas desde a terceira falha. Reutilizada `login_attempts` com migração aditiva 005 e trava PostgreSQL por IP antes do hash, compartilhada entre processos. Sucesso não apaga histórico; recusas não estendem o bloqueio. Sessões existentes continuam utilizáveis. Mantidos os limites adicionais por conta/IP, agora sem reset por sucesso; adicionados limites de rajada e geral separados, descritos em [autenticação](autenticacao.md#limitação-de-tentativas).

Vite substitui os cabeçalhos de encaminhamento pelo endereço do socket; backend aceita esse dado somente do peer que corresponde ao nome Docker configurado, com resolução por requisição e normalização IPv4/IPv6. `trust proxy` permanece desligado. Health usa socket direto para evitar dependência circular no primeiro boot. Não há serviço/dependência nova nem exposição externa. NAT pode compartilhar bloqueio e múltiplos IPs podem contorná-lo.

A revisão das consultas HTTP não identificou interpolação vulnerável de entradas: parametrização `pg`, ordenações fixas, papel limitado e erros genéricos foram preservados. Payloads e integridade foram exercitados em bancos/arquivos isolados; resultados em [validação](validacao.md).


## Experiência do player e validação proporcional — 30/09/2026

Escopo aprovado e implementado apenas no frontend: Ajustar como tamanho padrão, presets Compacto/Médio/Grande, canvas proporcional com pixels sem suavização, controles semitransparentes sobrepostos e chave visível Mostrar botões. Engrenagem abre Configurações → Controles, com remapeamento físico, conflitos resolvidos por troca explícita, cancelamento e reset. Configurar preserva pausa anterior e impede entrada no jogo; retorno automático depende de foco, ausência de erro e renovação da reserva. Preferências por UUID de usuário em localStorage, separadas da recuperação de saves, sem credenciais ou alteração de backend/core.

Validação proporcional torna-se instrução em `AGENTS.md`: selecionar testes pelos fluxos afetados, reutilizar evidências anteriores para áreas intactas e ampliar somente por alteração compartilhada/falha/risco concreto justificado. Nesta etapa, tipos/build frontend e suíte específica com React/core reais, ROMs sintéticas e API simulada, sem banco/rede externa. A classe de largura adicionada em App só atua durante o player e a saída à biblioteca integra o smoke. Nenhuma repetição rotineira de autenticação, segurança, catálogo, migrações, backup/restauração ou matriz completa do motor. Atualização somente do frontend local; sem manutenção de dados.

## 30/09/2026 — clareza de save nativo e volume

Mantido um save nativo por usuário/jogo. Entrada distingue presença de memória remota sem certificar partida válida. Saída mostra confirmação ou orientação de SAVE e escolha consciente; nenhuma navegação de sucesso após flush com erro. Corrigida validação incompleta de versão/data do ACK, preservando recuperação idempotente. Slider 0–100 controla ganho real e persiste por usuário, compatível com preferências anteriores. Sem migração, save state, slots ou modificação do core. O relato não comprova perda de dados: a falha de comunicação da interface foi identificada; persistência é validada com cartuchos sintéticos em banco isolado.

## 30/09/2026 — recuperação explícita de reserva após refresh

Identificada reserva persistente sem recuperação imediata após cleanup de aba não entregue; isso não comprova perda de save. Mantidos TTL 120 s, heartbeat 30 s e escritor único. Adicionada transferência explícita por geração observada, autorização por usuário/jogo e troca atômica de token. Sem identificação automática de aba por cookie/sessionStorage, remoção de trava, migração ou liberação global. Interface permite confirmar transferência ou aguardar/tentar novamente. IndexedDB passa a comparar dono/revisão e preservar pendência isolada de instância revogada, com conflito explícito. Pagehide/pageshow auxiliam pausa/revalidação, sem garantia de gravação no fechamento. Validação limitada à reserva, recuperação e persistência diretamente afetadas.

## 30/09/2026 — velocidade alvo no player

Implementado seletor 1×/2×/3×/5×/10× no frontend, com preferência por usuário e fallback 1× compatível com o formato anterior. Aceleração usa a API de frames já disponível no adaptador mGBA, sem mudar/recompilar core. Lotes limitados por quantidade/tempo e descarte de dívida preservam responsividade e impedem compensação de suspensão. Política inicial de áudio: silêncio temporário acima de 1×, sem alterar mute/volume; fila limpa e retorno condicionado à escolha do usuário/gesto do navegador. Heartbeat, HTTP e saves mantêm tempo real e contratos anteriores. Nenhuma pendência conhecida da entrega anterior de reserva; suas evidências são históricas e não foram repetidas por rotina.

## 30/09/2026 — estados e administração expressamente autorizados

Esta ampliação substitui as restrições históricas a states/slots/administração, mantendo um nativo separado. Escolhidos um Save rápido e três manuais; metadados vinculam ROM/core exatos. ABI atual validada com GB/GBA reais antes da UI, sem recompilar upstream. Migração 006 aditiva, quotas por usuário/global, revisão com tombstone, reserva e autorização no backend. Carregamento usa core candidato para rejeitar corrupção sem destruir a sessão atual; restaura também cartucho com confirmação. Exclusão nativa recusa reserva ativa e marca nova identidade de progresso para bloquear pendências/confirmações antigas. Meus saves e administração MASTER são separados. Backup v4 inclui novos dados; detalhes e limites em [saves](saves.md), resultados em [validação](validacao.md).

## 01/10/2026 — resistência a abuso e separação operacional

Removido o bloqueio anônimo por username compartilhado com troca de senha. Mantidas três falhas/IP/duas horas; pressão por nome exige prova temporária em worker, sem eliminar o risco de bots distribuídos. Quotas autenticadas são separadas. Admissão em memória limitada precede banco/hash; contadores persistentes têm teto/TTL e limpeza periódica. States têm orçamento de operações/bytes sem alterar exclusividade, idempotência ou backup. Auditoria é amostrada e limitada, não promessa de registro completo.

MASTER passa a exigir TOTP (otplib), confirmação de cadastro, proteção AES-GCM com chave externa, anti-replay, recuperação única e reautenticação recente por senha+fator. Sessões MASTER têm prazos próprios. Banco runtime deixa de usar proprietário do schema; migrador permanece separado. CSP começa em Report-Only no HTML e gera política por build; worklet permanece em arquivo local. Migrações 007–010 são aditivas, com aplicação real ainda pendente. [Contrato, limites e aceite administrativo](seguranca.md).
