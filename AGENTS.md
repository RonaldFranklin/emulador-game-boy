# EMULADOR — instruções para agentes

## Projeto e leitura

Aplicação web para jogar Game Boy (GB) e Game Boy Advance (GBA), com contas, catálogo administrado e progresso individual. Trabalhe na raiz deste checkout; preserve arquivos, dados, configuração e histórico Git existentes. A ampliação GB/GBA foi expressamente autorizada e não implica autorização para outros consoles ou renomear o projeto.

Leia nesta ordem:
1. docs/README.md
2. docs/decisoes.md
3. docs/regras-de-negocio.md
4. docs/desenvolvimento.md
5. README.md e os contratos relevantes à tarefa.

Antes de alterar o player, leia também docs/emulacao.md e docs/fontes-emulador.md.

## Decisões obrigatórias

- Node.js e TypeScript; backend NestJS único, organizado em módulos; frontend React/Vite separado; PostgreSQL e Docker Compose.
- Emulação no navegador; servidor cuida de autenticação, autorização, catálogo e saves.
- Perfis MASTER e JOGADOR. Master joga e administra contas/catálogo; cada usuário acessa apenas seu próprio progresso no player.
- GB e GBA neste projeto. GBC exclusivo e outros consoles estão fora. GB dual-mode roda como DMG.
- Um save nativo de cartucho por usuário/jogo; não confundir com save state. Sem importação/exportação, slots adicionais ou painel de administração/exclusão de saves.
- UUID, console e ROM imutáveis; disponibilidade editável e sem exclusão definitiva. Jogar somente jogos ativos, inclusive MASTER.
- Sem botão de download de ROM. Bytes chegam ao navegador autorizado; não prometer DRM.
- Autorização no backend em cada operação; ocultar controles não substitui segurança.

## Forma de trabalhar

O chat coordenador define escopo e revisa. A implementação deve ocorrer **no Codex dentro do VS Code conectado ao WSL, nunca no GitHub Copilot Chat**. Nesta sessão implementadora, execute as tarefas expressamente autorizadas. Se precisar encaminhar trabalho entre interfaces, confirme a extensão e sessão corretas; abrir o VS Code não comprova operação do Codex. Agentes internos desta execução podem colaborar dentro do mesmo escopo.

Trabalhe em etapas verificáveis. Distinga proposta, decisão, implementação e teste; atualize documentação e histórico sem transformar sugestões em requisitos. Não acesse servidor, publique ou faça push por inferência. Commit local depende de autorização: em 30/09/2026 foi autorizado o primeiro commit com baseline funcional, bootstrap pela .env e documentação revisada, após validação. Essa autorização não abrange push/publicação.

Não versione credenciais, `.env` real, ROMs, saves pessoais, backups, `.local`, dependências instaladas ou assets gerados. Preserve o autor/configuração Git existente. Revise todo o conteúdo elegível e staged antes de commits, sem imprimir segredos.

## Ambiente e contexto privado

Este Compose é exclusivamente local: nome `emulador-game-boy-dev`, somente `127.0.0.1:5173` publicado. Banco e backend sem portas públicas. Confira daemon/contexto, containers, volumes e portas antes de operar; nunca altere projetos vizinhos.

Referências específicas do operador — caminhos locais anteriores, inventário, origem Git e documentação administrativa — pertencem a **`.local/private-context/README.md`**, ignorado pelo Git. Os documentos anteriores à revisão pública foram preservados ali em arquivo privado. Se o contexto estiver ausente neste checkout, não invente acessos/caminhos; solicite a referência ao operador quando a tarefa depender dela.

Qualquer tarefa futura de servidor exige autorização específica e leitura das instruções administrativas externas indicadas pelo contexto privado. Não copie esses guias para este repositório nem os publique.

## Estado e preservação

Implementados autenticação/sessões persistentes, administração de usuários, temas, catálogo GB/GBA, player mGBA e save nativo com reserva exclusiva, versão, checksum e recuperação pendente no IndexedDB por usuário/jogo. Fontes/compilador fixos, licença e fontes correspondentes auto-hospedadas; sem CDN em runtime ou BIOS externa. Atualizar core exige repetir execução real e restauração antes do primeiro frame.

A entrega de emulação passou em build/tipos, 57 testes API/migração, 49 cenários Chromium e recuperação de saves sintéticos. A melhoria de bootstrap em 30/09 passou em build/tipos, 65 testes API, regressão integrada Chromium e dois roteiros de instalação isolados. Backup anterior/final restaurados e dados ativos integralmente preservados. Detalhes em docs/validacao.md; contagens históricas não substituem testes de alterações novas.

Em 30/09/2026 foi autorizado o primeiro master pela `.env`, somente quando nenhum MASTER existe. Configuração inválida deve impedir o primeiro boot; em banco provisionado, não redefinir senha/perfil, não promover homônimos e não exigir credenciais de bootstrap. Preservar a alternativa CLI com a mesma transação/trava. A `.env` real é privada (`0600`); nunca passar senha ao frontend, build, logs ou saída de diagnóstico.

O banco local pode conter jogos, capas, contas, sessões e saves pessoais criados depois dos últimos testes. Inspecione e faça backup conjunto verificado antes de migrações/manutenção. Nunca limpar catálogo ativo ou inserir fixtures nele. Use bases/volumes próprios para testes e remova somente os recursos criados pelo ensaio. Contas temporárias antigas, se existentes, exigem autorização específica para remoção, sem afetar outras contas/progresso.

Backup v3 contém banco, ROMs/capas e manifesto; saves ficam no dump. v1/v2 anteriores permanecem aceitos. Recuperação sempre em banco/volume novos, preserva a origem e revoga sessões recuperadas. Seguir docs/operacao.md; nunca remover volumes/arquivos manualmente sem reconciliação.

## Documentação como critério de conclusão

README é a entrada curta e reproduzível: ideia da aplicação, requisitos do PC versus containers, versões reais, configurar/subir/health/login e links para operação/testes/backup. Detalhes ficam em docs. Não invente comandos, versões, evidências ou funções ainda ausentes. Atualize decisão, contrato, histórico e limitações pertinentes. Documentação pública deve ser genérica; informações pessoais e administrativas ficam somente no contexto privado ignorado.
