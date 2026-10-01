# Documentação do Emulador

Aplicação local de GB/GBA com autenticação, usuários, temas, catálogo, emulação no navegador e saves nativos/estados. Nenhum jogo ou credencial acompanha o projeto.

## Começar e operar

- [README da raiz](../README.md): requisitos, instalação e primeiro login.
- [Guia de uso](guia-de-uso.md): contas, catálogo, controles, progresso, conflitos e temas.
- [Operação local](operacao.md): configuração, bootstrap alternativo, migrações, testes, persistência, backup e restauração.
- [Desenvolvimento](desenvolvimento.md): ambiente, organização e fluxo de trabalho.

## Contratos e referências

- [Decisões e arquitetura](decisoes.md): tecnologias, motivos, escopo e pendências.
- [Regras de negócio](regras-de-negocio.md): perfis, catálogo e progresso individual.
- [Autenticação e API](autenticacao.md): sessões, segurança, bootstrap e administração.
- [Catálogo](catalogo.md): uploads, admissão GB/GBA, capas, disponibilidade e limites.
- [Emulação e saves](emulacao.md): player, autorização, concorrência e recuperação.
- [Saves nativos, states e administração](saves.md): slots, propriedade, exclusão, compatibilidade e limites.
- [Motor e fontes](fontes-emulador.md): versões, licença, adaptação e build.
- [Validação](validacao.md): comandos executados, resultados e limitações por etapa.
- [Histórico técnico](historico.md): evolução da implementação e das decisões.

## Manutenção

Atualize o contrato e o guia correspondentes quando o comportamento mudar, registrando a decisão no histórico. Diferencie proposta, implementação e teste; não anuncie um resultado que ainda não foi obtido. Evidências anteriores não comprovam automaticamente alterações posteriores.

Exemplos devem funcionar sem depender de contas, caminhos ou infraestrutura pessoais. `.env`, segredos, ROMs, saves e backups ficam fora do Git. Configurações administrativas privadas pertencem aos registros do operador, não a esta documentação. Publicação futura exige revisão dos arquivos e do histórico do repositório.
