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
- Um save nativo de cartucho por usuário/jogo, separado de um Save rápido e três slots manuais de save state, expressamente autorizados em 30/09/2026. Meus saves gerencia dados próprios; MASTER pode listar/excluir dados alheios em área separada, nunca carregá-los para jogar. Exclusão nativa exige ausência de reserva e bloqueia pendências antigas. Sem importação/exportação. Estados dependem da ROM e compilação exata do core; ver docs/saves.md.
- UUID, console e ROM imutáveis; disponibilidade editável e sem exclusão definitiva. Jogar somente jogos ativos, inclusive MASTER.
- Sem botão de download de ROM. Bytes chegam ao navegador autorizado; não prometer DRM.
- Autorização no backend em cada operação; ocultar controles não substitui segurança.

## Forma de trabalhar

O desenvolvimento ocorre **diretamente no chat do Codex dentro do VS Code conectado ao WSL, nunca no GitHub Copilot Chat**, sem depender de chat coordenador externo ou encaminhamento entre interfaces. O próprio Codex lê a documentação, alinha o escopo com o usuário, implementa, revisa, valida e documenta as tarefas autorizadas. Um chat novo deve seguir a ordem de leitura acima e conferir o estado atual do repositório e do ambiente, sem depender do histórico de conversas anteriores. Agentes internos podem colaborar dentro do mesmo escopo; essa colaboração é opcional.

Trabalhe em etapas verificáveis. Distinga proposta, decisão, implementação e teste; atualize documentação e histórico sem transformar sugestões em requisitos. Não acesse servidor, publique ou faça push por inferência. Commit local depende de autorização: em 30/09/2026 foi autorizado o primeiro commit com baseline funcional, bootstrap pela .env e documentação revisada, após validação. Essa autorização não abrange push/publicação. Em 30/09/2026 também foi autorizado o fechamento com commit local das melhorias acumuladas e documentação na branch atual; isso não autoriza commits futuros por inferência.

Não versione credenciais, `.env` real, ROMs, saves pessoais, backups, `.local`, dependências instaladas ou assets gerados. Preserve o autor/configuração Git existente. Revise todo o conteúdo elegível e staged antes de commits, sem imprimir segredos.

## Validação proporcional

Testar somente o que foi desenvolvido e os fluxos diretamente afetados. Inspecione o impacto e justifique a seleção; não repita por rotina a suíte inteira da aplicação, autenticação, segurança, catálogo, migrações, backup/restauração ou toda a matriz do motor. Reaproveite evidências anteriores das áreas intactas, distinguindo-as dos resultados atuais. Não crie testes redundantes.

Para alterações de experiência do player, priorize tamanhos/proporções GB/GBA, responsividade/tela cheia, tema e controles alterados, multitouch, remapeamento/conflitos/reset, captura/pausa/liberação de teclas, persistência/isolamento das preferências e smoke pertinente. Execute tipos/build do frontend quando afetado. Amplie a validação somente diante de alteração compartilhada, falha ou risco concreto, explicando o motivo.

Uma mudança exclusivamente de frontend não exige recriar banco/backend nem backup completo por padrão. Atualize somente o frontend local necessário após validar. As regras de backup/restauração e preservação continuam obrigatórias se houver manutenção real de dados; testes nunca usam contas, jogos ou progresso pessoais.

## Ambiente e contexto privado

Este Compose é exclusivamente local: nome `emulador-game-boy-dev`, somente `127.0.0.1:5173` publicado. Banco e backend sem portas públicas. Confira daemon/contexto, containers, volumes e portas antes de operar; nunca altere projetos vizinhos.

Referências específicas do operador — caminhos locais anteriores, inventário, origem Git e documentação administrativa — pertencem a **`.local/private-context/README.md`**, ignorado pelo Git. Os documentos anteriores à revisão pública foram preservados ali em arquivo privado. Se o contexto estiver ausente neste checkout, não invente acessos/caminhos; solicite a referência ao operador quando a tarefa depender dela.

Qualquer tarefa futura de servidor exige autorização específica e leitura das instruções administrativas externas indicadas pelo contexto privado. Não copie esses guias para este repositório nem os publique.

## Estado e preservação

Implementados autenticação/sessões persistentes, administração de usuários, temas, catálogo GB/GBA, player mGBA e save nativo com reserva exclusiva, versão, checksum e recuperação pendente no IndexedDB por usuário/jogo. Fontes/compilador fixos, licença e fontes correspondentes auto-hospedadas; sem CDN em runtime ou BIOS externa. Atualizar core exige repetir execução real e restauração antes do primeiro frame.

Segurança, player, volume, recuperação de reserva, velocidade e states/administração têm evidências por etapa em docs/validacao.md. Segurança 007–010 (limites/auditoria/MFA/CSP/runtime) foi preparada em 01/10/2026 e validada isoladamente; não presumir migrações/grants ou MFA pessoal aplicados. Leia docs/seguranca.md e o upgrade em docs/operacao.md antes de manutenção. A chave MFA externa precisa de recuperação protegida junto do plano de backup; não cadastrar nem remover fatores pessoais por inferência. Estado de continuidade em docs/desenvolvimento.md; contagens históricas não substituem testes de alterações novas.

Em 30/09/2026 foi autorizado o primeiro master pela `.env`, somente quando nenhum MASTER existe. Configuração inválida deve impedir o primeiro boot; em banco provisionado, não redefinir senha/perfil, não promover homônimos e não exigir credenciais de bootstrap. Preservar a alternativa CLI com a mesma transação/trava. A `.env` real é privada (`0600`); nunca passar senha ao frontend, build, logs ou saída de diagnóstico.

O banco local pode conter jogos, capas, contas, sessões e saves pessoais criados depois dos últimos testes. Inspecione e faça backup conjunto verificado antes de migrações/manutenção. Nunca limpar catálogo ativo ou inserir fixtures nele. Use bases/volumes próprios para testes e remova somente os recursos criados pelo ensaio. Contas temporárias antigas, se existentes, exigem autorização específica para remoção, sem afetar outras contas/progresso.

Backup v4 contém banco, ROMs/capas e manifesto; nativos, states, revisões de slots e marcadores de reinício ficam no dump. v1/v2/v3 anteriores permanecem aceitos. Recuperação sempre em banco/volume novos, preserva a origem e revoga sessões recuperadas. Seguir docs/operacao.md; nunca remover volumes/arquivos manualmente sem reconciliação.

## Documentação como critério de conclusão

README é a entrada curta e reproduzível: ideia da aplicação, requisitos do PC versus containers, versões reais, configurar/subir/health/login e links para operação/testes/backup. Detalhes ficam em docs. Não invente comandos, versões, evidências ou funções ainda ausentes. Atualize decisão, contrato, histórico e limitações pertinentes. Documentação pública deve ser genérica; informações pessoais e administrativas ficam somente no contexto privado ignorado.

Preferência duradoura: documentação útil, objetiva e orientada a uso, decisões, contratos e manutenção. Concentre passos no guia de uso, garantias nos contratos e procedimentos em operação; use links em vez de duplicar conteúdo. Não transcreva conversas/comandos nem registre cada detalhe interno. Remova orientações vigentes contraditórias, preserve evidências com sua data/escopo e mantenha um resumo curto de continuidade com apenas pendências reais. Em fechamento exclusivamente documental, confira links, comandos, coerência e `git diff --check`, sem repetir builds/testes de código inalterado ou operar serviços por rotina.
