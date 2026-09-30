# Guia de uso

Comece pelo [README](../README.md) para instalar e criar o primeiro master. Este guia descreve os fluxos disponíveis na interface.

## Contas e administração

Entre na interface com a conta criada. Em **Administração**, o master cria jogadores e define uma senha temporária, que deve entregar por um canal privado escolhido por ele. O jogador precisa trocá-la antes de acessar a biblioteca. Também é possível bloquear/desbloquear jogadores e redefinir sua senha temporária. Essas operações revogam as sessões do jogador. A troca da própria senha encerra todas as sessões; **Sair** encerra a sessão atual.

Não há exclusão de contas, promoção de jogador ou bloqueio de master. O último master fica protegido. Recuperação de senha esquecida do master ainda não tem fluxo implementado; guarde sua senha com segurança. A API e as regras completas estão em [autenticação](autenticacao.md).

## Cadastrar e consultar jogos

O master acessa a aba **Catálogo** para cadastrar **nome, ROM `.gb` ou `.gba` descompactada, capa opcional e disponibilidade**. Em **Editar**, pode renomear, trocar/remover a capa e marcar/desmarcar **Disponível para jogadores**. O console, a ROM e o UUID do jogo permanecem os mesmos. Não há exclusão definitiva nem substituição da ROM; desative o jogo para ocultá-lo dos jogadores.

- Nome: 1–120 caracteres após remover espaços nas extremidades.
- GB: 32 KiB a 8 MiB, tamanho e cabeçalho coerentes, extensão `.gb`. ZIP, `.gbc` e cartuchos exclusivos de Game Boy Color são recusados. Dual-mode com flag `0x80` é aceito pela compatibilidade declarada com Game Boy original, sem implementar modo Color.
- GBA: cabeçalho completo de pelo menos 192 bytes e até 32 MiB, extensão `.gba`, logo, valores fixos/reservados e checksum válidos. Não precisa ter tamanho potência de dois. Arquivos ELF, BIOS e multiboot sem cabeçalho de cartucho não são aceitos.
- Capa: PNG/JPEG estático, até 2 MiB, até 2048 px por lado e 4 milhões de pixels. O servidor decodifica e grava uma nova imagem PNG de até 2 MiB, sem metadados. SVG, GIF, WebP e imagens animadas não são aceitos.
- A mesma ROM não pode ser cadastrada novamente, inclusive com outro nome ou em uploads simultâneos. O servidor confere SHA-256.

Ao selecionar o arquivo, o formulário mostra o console detectado pelo cabeçalho e o limite correspondente. O servidor valida novamente o conteúdo e exige extensão coerente; renomear `.gb` para `.gba` não converte uma ROM. Após o cadastro, a lista, o diálogo de edição e a biblioteca mostram o selo **GB** ou **GBA** confirmado pela API.

Na aba **Jogar**, o master vê todos os jogos, com status. O jogador vê somente ativos. **Jogar** está habilitado para ativos, inclusive para o master. Capas e ROMs usam rotas autenticadas; não há diretório público nem botão de download. Bytes já recebidos não podem ser recolhidos do navegador após desativar o jogo; novas consultas são recusadas.

Limites locais: 1000 jogos, 8 GiB e 10.000 arquivos armazenados, contando capas anteriores retidas; dois uploads simultâneos, até 60 segundos para receber cada envio. A validação estrutural não garante funcionamento de todo cartucho no motor. Veja [contrato e critérios completos](catalogo.md).

## Jogar e guardar progresso

Na biblioteca, escolha **Jogar → Iniciar jogo**. O player restaura o save antes de executar e inicia sem som. **Ativar áudio** depende de um clique/toque; há controles de pausa/retomada, tela cheia e **Salvar e voltar**. O seletor de tema continua no cabeçalho. Em celular, use os botões na tela, incluindo L/R para GBA.

| Controle | Teclado |
| --- | --- |
| Direcional | Setas |
| A / B | X / Z |
| Start / Select | Enter / Shift |
| L / R (GBA) | Q / W |

Salve pela opção **do próprio jogo** e aguarde ele terminar a gravação antes de usar **Salvar e voltar**. A aplicação guarda a memória de cartucho (SRAM/EEPROM/Flash), e **não um save state** do ponto exato da tela. A cada dois segundos compara alterações; na pausa e em **Salvar e voltar**, captura novamente e aguarda confirmação. Observe **Salvando**, **Salvo no servidor** ou **Pendente**. Jogos sem memória persistente não terão progresso salvo.

Uma reserva exclusiva impede duas abas/dispositivos de gravarem o mesmo usuário/jogo. Ao voltar à biblioteca ela é liberada; se uma aba fechar abruptamente ou a liberação falhar por falta de rede, pode ser necessário aguardar até 120 segundos. Use o mesmo usuário em outro aparelho somente depois de **Salvar e voltar**. Conflito não substitui silenciosamente o save remoto.

Se a rede falhar, o jogo pausa. **Tentar sincronizar** reenvia com segurança; depois use **Retomar**. Uma cópia pendente fica no IndexedDB, segregada por usuário/jogo, e é reconciliada ao iniciar novamente com essa conta. **Voltar mantendo cópia local** só aparece quando há cópia local confirmada: ela ainda não está no backup do servidor. Preserve esse navegador/origem e não limpe seus dados enquanto houver pendência. Se outra versão remota conflitar, o início fica bloqueado; descartar a cópia local exige confirmação explícita. Nenhum outro login recebe o progresso dessa conta pela aplicação. Em aparelho compartilhado, dados locais ainda podem ser inspecionados pelo dono do perfil do navegador.

Não dependa de fechar a aba para salvar. Falha de energia, storage cheio, encerramento abrupto ou restrições de segundo plano podem perder a última alteração. Não há importação/exportação de saves, slots adicionais, save states ou painel administrativo de saves.

O motor mGBA é compilado de fontes fixadas e servido pelo próprio frontend, sem CDN em runtime ou BIOS proprietária. A licença e as fontes ficam em **Motor e licenças de terceiros** no player. GB dual-mode roda em modo Game Boy original. Veja [motor, fontes e build](fontes-emulador.md) e [contrato de emulação/saves](emulacao.md). Os bytes da ROM necessariamente chegam ao navegador autorizado: isso **não é DRM**.

## Tema claro e escuro

O botão **Escuro**, com ícone de sol/lua, fica junto à marca no login e no cabeçalho após entrar, tanto para master como para jogador. Liga/desliga o tema escuro por clique, toque, Enter ou Espaço e informa o estado pressionado para leitores de tela. O nome permanece estável nos dois temas, e o ícone indica o tema atual. Continua disponível em telas pequenas.

Na primeira visita, a interface acompanha a preferência do sistema (`prefers-color-scheme`); sem esse recurso, começa clara. Uma escolha no botão tem prioridade e salva apenas `emulador-theme=light` ou `dark` no `localStorage` deste navegador/origem. Ela permanece ao recarregar e sair da conta e se sincroniza entre abas. Não são armazenadas credenciais ou sessões nesse storage. Para voltar a seguir o sistema, remova essa chave nas ferramentas do navegador e recarregue.

O tema inicial e a cor de fundo são aplicados no início do HTML, antes de carregar React e os estilos da aplicação. Valores inválidos são ignorados. Se o armazenamento estiver bloqueado ou cheio, o botão continua funcionando durante a navegação e o logout; a escolha pode não sobreviver a um recarregamento. A paleta mantém os verdes Game Boy nos dois temas.
