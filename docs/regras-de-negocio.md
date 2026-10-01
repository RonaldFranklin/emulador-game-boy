# Regras de negócio

Estado: contas, acesso, temas, catálogo GB/GBA, emulação e save nativo implementados localmente. Resultados e limites em validação.

## Contas e acesso

- Login básico; sem login Google ou outras integrações sociais nesta etapa.
- Perfis MASTER e JOGADOR.
- Master pode jogar, além de administrar a aplicação.
- Jogador acessa jogos disponibilizados e administra somente seus saves.
- Master administra as contas que podem acessar o sistema, incluindo criação e bloqueio.
- Autorização deve ocorrer no backend em cada operação; esconder botões não é proteção suficiente.
- Identificador: 3–32 caracteres, letras minúsculas ASCII, números e sublinhado. Senha nova de 12–128 caracteres, sem remoção de espaços. Login e confirmação da senha atual aceitam credenciais existentes não vazias até 128 caracteres, inclusive hashes de senhas curtas; criação, redefinição, bootstrap e nova senha mantêm o mínimo de 12.
- Três falhas de login do mesmo IP em duas horas bloqueiam novos logins desse IP por duas horas desde a terceira falha, para qualquer nome. Sucesso não limpa falhas; tentativas bloqueadas não estendem o prazo. Sessões existentes continuam válidas. IP compartilhado por NAT pode compartilhar bloqueio; limites adicionais estão em [autenticação](autenticacao.md#limitação-de-tentativas).
- Sem cadastro público. O primeiro master é criado pelo bootstrap local após as migrações, usando credenciais escolhidas no `.env` privado, ou pelo comando interativo com senha oculta e confirmação. Não há senha padrão; master existente nunca é redefinido pelo bootstrap. Credenciais inválidas ou ausentes sem master impedem a inicialização.
- Master cria somente jogadores. Criação e redefinição exigem troca da senha temporária antes de usar biblioteca/administração.
- Jogador e master trocam a própria senha informando a atual. A troca revoga todas as sessões da conta. Logout revoga somente a sessão corrente.
- Bloqueio, desbloqueio e redefinição revogam todas as sessões do jogador. Uma sessão revogada nunca volta a funcionar após desbloqueio.
- A administração não altera masters. Não existem exclusão de contas nem promoção/rebaixamento de papéis nesta entrega; último master e autoexclusão ficam protegidos.
- Recuperação de acesso de jogador ocorre pelo master. Recuperação de senha esquecida do master ainda depende de uma próxima decisão; não há recuperação pública ou por e-mail.

## Catálogo

- Apenas master adiciona jogos e administra suas informações e disponibilidade.
- Master cadastra nome, ROM `.gb` ou `.gba` descompactada, capa PNG/JPEG opcional e disponibilidade. Pode editar nome/capa/disponibilidade.
- Jogador consulta somente jogos ativos; master lista todos. A capa segue a mesma autorização no backend.
- Cada jogo recebe UUID estável e ROM/console (`GB` ou `GBA`) imutáveis. O servidor determina o console pelo cabeçalho e exige extensão coerente. SHA-256 único recusa duplicatas, inclusive concorrentes.
- Não existe exclusão definitiva: desativar oculta o jogo dos jogadores, preservando seus dados.
- Jogar fica habilitado para ativos. Master também só executa jogos ativos.
- Não oferecer download de ROM na interface. O player recebe bytes por rota autenticada, com validação de acesso e integridade; não promete DRM.
- Renomear um jogo não deve romper sua associação com o progresso.
- Alteração/substituição de ROM não é permitida nesta entrega; qualquer política futura precisa preservar associação e compatibilidade dos saves.
- Game Boy original: dual-mode aceito somente pela compatibilidade DMG declarada; CGB exclusivo, arquivos compactados e formatos inválidos são recusados. GBA passa a ser aceito neste projeto com cabeçalho próprio e limite de 32 MiB; GB mantém 8 MiB. Critérios e limites em [catálogo](catalogo.md).
- ROMs/capas são privadas e persistidas em volume Docker; backup e recuperação devem incluir banco e arquivos juntos.

## Saves

- Um único save nativo por usuário/jogo, mais um Save rápido e três slots manuais de state.
- Progresso criado dentro da emulação; sem importação de save externo.
- Os quatro slots de state foram expressamente aprovados; não há slots adicionais nem importação/exportação.
- Cada perfil carrega somente seu próprio progresso no player. MASTER lista/filtra/exclui saves alheios em administração separada, com confirmação de dono/jogo/tipo; essa permissão não dá acesso para jogar usando dados de outra conta.
- Proteger progresso contra sobrescritas silenciosas de outro aparelho e gravações interrompidas.
- Diferenciar confirmação local de confirmação de persistência no servidor.
- Save nativo de cartucho restaurado antes do primeiro frame e sincronizado por alterações; não é save state. Reserva exclusiva, versão esperada e repetição idempotente protegem duas abas/dispositivos.
- Cópia pendente no IndexedDB por usuário/jogo protege erros de rede; sai apenas após confirmação ou descarte explícito por conflito. Commit com resposta perdida mantém também o snapshot sucessor, independentemente dos slots de state. Revisões substituídas de um mesmo slot não têm histórico recuperável.
- Exportação de saves não faz parte do escopo confirmado.
- Exclusão nativa exige digitar EXCLUIR, versão/identidade atuais e ausência de reserva ativa; marcadores persistentes impedem restauração silenciosa por pendências antigas. Excluir slot não exclui nativo, ROM, conta ou outros slots. Contrato em [saves](saves.md).

## Visitante
Possibilidade futura, fora da primeira entrega: testar jogos sem conta e eventualmente com limite de tempo. Não prometer limite inviolável em emulação executada no cliente. Catálogo, duração e persistência do visitante ainda não definidos.

## Validação
Autenticação, isolamento entre contas, acesso administrativo, revogação, concorrência e persistência têm testes nesta entrega; ver [evidências](validacao.md). Validação de uploads, filtros por perfil/disponibilidade, edição, duplicatas concorrentes, falhas, persistência e restauração conjunta também foram exercitadas no catálogo. Execução e restauração reais GB/GBA, conflitos e recuperação de rede são exercitados com ROMs próprias executáveis. Testes com contextos Chromium distintos não substituem validação de celulares físicos ou outros navegadores.
