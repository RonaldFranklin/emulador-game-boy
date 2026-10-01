# Desenvolvimento

A instalação e o primeiro login estão no [README](../README.md). Operação, migrações, backup e testes ficam em [operação](operacao.md). Este documento descreve organização e cuidados de desenvolvimento, sem depender de um computador ou conta específicos.

## Ambiente

O projeto foi validado em Ubuntu 24.04/WSL2 com Docker Desktop, Engine 29.5.3 e Compose 5.1.4. WSL2 é a opção usada no Windows; não é obrigatório no Linux. Host validado: Node 24.16.0/npm 11.13.0. Dockerfile e `.nvmrc` fixam Node 24.21.0; a imagem inclui npm 11.19.0.

Use `npm ci` e preserve `package-lock.json`. Dependências diretas são exatas e frontend/backend usam workspaces. Não são necessários Node, PostgreSQL ou bibliotecas do navegador instalados separadamente dentro dos containers: cada imagem define seu ambiente. Node/npm no host executam os scripts de preparação e operação.

O Chromium do host não foi utilizado por falta de bibliotecas Linux. A suíte visual usa a imagem oficial Playwright, com navegador e bibliotecas incluídos. Não exige `sudo` nem mudanças no sistema do host. Python 3 local é necessário para os ensaios de bootstrap em TTY e operação.

## Organização

```text
backend/    NestJS modular, autenticação, catálogo, saves, CLI e migrações
frontend/   React/Vite, temas, administração, player e recuperação local
docker/     Inicialização do papel PostgreSQL
scripts/    Setup, compilação do motor, backup, recuperação e testes
tests/      API real, bootstrap em TTY, fixtures próprias e Chromium
docs/       Contratos, decisões, guias e evidências
```

O backend permanece único. A interface não substitui autorização no servidor. O motor executa no navegador; consultas de catálogo, entrega da ROM e gravação de progresso são autenticadas. A execução local publica somente a porta de interface em loopback.

## Fluxo de trabalho

1. Leia [decisões](decisoes.md) e o contrato da área que será alterada. Antes de alterar o player, leia [emulação](emulacao.md) e [fontes do motor](fontes-emulador.md).
2. Confira o daemon e as portas locais; preserve dados e serviços que não pertencem à tarefa.
3. Faça mudanças pequenas. Distinga proposta, implementação e teste nos registros.
4. Siga a validação proporcional de [AGENTS.md](../AGENTS.md): tipos/build dos workspaces alterados e testes de impacto direto; documentação isolada exige apenas revisão de links/comandos/coerência e diff. Atualize contrato, guia e [histórico](historico.md) quando o comportamento mudar.
5. Antes de migrar ou manter uma instalação com dados, faça backup e valide sua restauração. Nunca use limpeza de volumes para solucionar falhas de configuração.

Fontes não são montados nos serviços normais do Compose; alterações exigem novo build. `prepare:emulator` gera os arquivos locais do motor para build fora do container. Mudança de core exige novos testes reais de restauração antes do primeiro quadro, além da suíte do player.

Migrações aplicadas são imutáveis e verificadas por checksum. Adicione uma migração incremental; não remova tabelas, dados ou checksums para contornar uma falha. Bases e arquivos sintéticos dos testes devem permanecer isolados da biblioteca usada pelo operador.

## Dados e documentação

Não versionar `.env`, segredos, ROMs, BIOS, saves pessoais, dumps, capturas privadas ou backups. Diretórios locais ignorados podem conter dados sensíveis e não devem ser enviados junto ao código. Documentos públicos não devem incluir nomes de contas, credenciais, endereços de rede privada, caminhos pessoais ou inventário de infraestrutura.

Configurações administrativas particulares e procedimentos de servidores pertencem a registros privados do operador. Este repositório não configura acesso remoto nem documenta uma infraestrutura pessoal. Confirme autorização e referências vigentes antes de qualquer futura implantação.

A aplicação não cria contas de demonstração nem seeds. Instalações que já tenham contas temporárias devem manter sua revisão e eventual remoção em registro privado, sem redefinir ou excluir usuários por suposição. Não existe interface de exclusão de contas nesta entrega.

O histórico técnico anterior à preparação pública foi preservado de forma resumida em [histórico](historico.md); comandos e resultados estão em [validação](validacao.md). Identidades locais e registros administrativos não fazem parte da documentação distribuída.

## Validação por impacto

Selecione somente os fluxos alterados. Os comandos abaixo são opções, não uma sequência obrigatória; resultados históricos ficam em [validação](validacao.md). Builds de imagens de teste preparam código atualizado, sem implantar serviços.

| Área | Comando disponível |
| --- | --- |
| Tipos/build | `npm run typecheck --workspace frontend` / `npm run build --workspace frontend` (troque por backend quando afetado) |
| Teste HTTP específico | `docker compose build backend` e `docker compose run --rm --no-deps test node --test --test-name-pattern='PADRAO' tests/ARQUIVO.test.mjs` |
| Navegador específico | `docker compose build test-browser` e `docker compose run --rm --no-deps test-browser npx playwright test ARQUIVO.spec.mjs --grep 'PADRAO'` |
| Proxy/IP | `node scripts/test-security-proxy.mjs` (imagens backend/frontend previamente atualizadas) |
| Player/controles | `node scripts/test-player-ux.mjs` (imagem test-browser preparada) |
| Backup com states reais | `node scripts/test-states-backup.mjs` (imagem test-browser preparada) |
| Bootstrap isolado | `npm run test:first-boot` ou `npm run test:first-boot -- --configured-first` |

Para builds no host, `npm run prepare:emulator` prepara os assets locais usando Docker. Use bancos/arquivos sintéticos isolados; suítes HTTP/navegador removem apenas seus próprios recursos. O ensaio de states reinicia somente sua API de teste e restaura backup em PostgreSQL temporário sem rede. **O roteiro legado `npm run test:operations` reinicia o PostgreSQL do projeto**: não o use como validação rotineira.

## Continuidade — fechamento de 30/09/2026

Concluídos e aplicados localmente: proteção de login/IP, player responsivo com remapeamento, save nativo/volume, recuperação explícita de reserva, velocidade e Save rápido + três slots com administração. Migrações 001–006; backup v4 com estados e leitura de formatos anteriores. Usuário relatou testes bem-sucedidos de login/velocidade/save e avaliou states como um bom começo. Evidências técnicas por etapa em [validação](validacao.md).

Não há nova funcionalidade aprovada pendente para a próxima sessão. Limitações conhecidas: state anterior à identificação do cartucho pode ser recusado quando já existe nativo confirmado; fechamento abrupto não garante a última gravação; compatibilidade de states depende do core/ROM. Aparelhos físicos, navegadores além de Chromium e qualidade auditiva humana não foram validados. Consulte [saves](saves.md) antes de alterar persistência/core. Ambiente continua exclusivamente local; próxima tarefa depende do escopo que o usuário escolher.
