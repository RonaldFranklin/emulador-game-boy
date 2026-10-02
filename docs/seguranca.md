# Segurança: contrato e aplicação operacional

Revisão de 01/10/2026 sobre o baseline `5a771c8`. As mudanças abaixo foram desenvolvidas e testadas **em ambientes descartáveis**. Não foram aplicadas ao banco pessoal nem ao servidor. Relatórios e inventários privados continuam fora do repositório.

## Resistência a abuso

O bloqueio persistente permanece: **três falhas de login por IP em duas horas bloqueiam login por duas horas desde a terceira falha**, para qualquer nome. Acerto não limpa falhas; tentativa bloqueada não estende o prazo; expiração reinicia a contagem. PostgreSQL serializa a decisão antes do hash, inclusive entre processos. Respostas são genéricas, com HTTP 429 e `Retry-After`; sessões já autenticadas continuam válidas. NAT pode compartilhar bloqueio; IP não impede bots distribuídos.

Foi removida a cota de username que permitia a um anônimo bloquear também a troca de senha. Após dez tentativas por nome em 15 minutos, a API exige uma prova de trabalho SHA-256, resolvida automaticamente em worker no navegador. Vale igualmente para nomes existentes/inexistentes: HTTP 428 fornece token aleatório, vinculado a IP/nome, válido por 120 segundos e consumido uma vez. Dificuldade: quatro zeros hexadecimais; a partir de 30 tentativas, cinco. O worker tem prazo de 90 segundos e limite de iterações. Isso acrescenta custo ao abuso distribuído, **não é MFA, CAPTCHA nem garantia contra botnet/GPU**. O login legítimo pode demorar sob ataque; não há bloqueio global da conta por essa pressão. Falha de verificação pode ser repetida pela tela de login.

| Camada | Limite por instância, salvo indicação contrária |
| --- | --- |
| Admissão antes do banco | 6000 requisições/min global; login 120/min; 1200/min/IP; login 30/min/IP |
| Trabalho simultâneo | 32 requisições; no máximo duas de login; Argon2 mantém teto de quatro operações; sem fila de hashes |
| Servidor HTTP | 64 conexões, 100 requisições/socket, timeout de headers 15 s e de requisição 65 s |
| Memória do limitador | Até 4096 chaves em janelas fixas; cheio recusa novas identidades, não expulsa bloqueios ativos |
| Troca de senha | PostgreSQL: cinco tentativas/15 min por **ator autenticado**, independente do login/IP/username |
| MFA | PostgreSQL: dez operações/15 min por ator |
| Persistência dos limites | Novas admissões limitadas a 9000 identidades anônimas e 1000 registros de atores; namespaces e chaves SHA-256; admissão transacional |
| Limpeza independente de login | Na inicialização e a cada 60 s: até 1000 limites vencidos e 1000 sessões expiradas por lote; índice de expiração; bloqueios ativos preservados |

Um legado já acima do teto expira por lotes, sem apagar bloqueios ativos para abrir vagas. Limites HTTP reiniciam com o processo; bloqueios, quotas autenticadas e pressão por nome sobrevivem. Limites globais em memória não são distribuídos entre réplicas. O pool possui 12 conexões, aquisição limitada a 5 s e SQL a 15 s; limitadores dentro de transações reutilizam a conexão. A admissão limita pedidos aguardando banco. Limites gerais comportam catálogo, ROMs, heartbeat e saves; **não se aplica a regra de três falhas à API inteira**. Saturação ainda pode recusar temporariamente tráfego legítimo: proteção de borda e capacidade precisam de validação na topologia escolhida.

## Orçamento de states

Além de tamanho/quota em [saves](saves.md), existem janelas fixas de um minuto persistidas no PostgreSQL:

| Operação | Por jogador | Global |
| --- | --- | --- |
| Metadados de slots | 60 leituras | Admissão HTTP geral |
| Recepção de upload, antes do parser grande | 20 pedidos | 120 pedidos |
| Gravações confirmadas | 10 operações / 8 MiB | 120 operações / 64 MiB |
| Leitura de conteúdo para carregar | 20 operações / 32 MiB | 240 operações / 128 MiB |

Admissão de ingresso é conjunta: após preparar chaves sob o teto de cardinalidade, uma transação curta trava global → ator, confere ambas as janelas e só debita se ambas admitirem. Rejeição individual não consome global e vice-versa. Chaves removidas pela limpeza entre preparo e trava recusam com 429/`Retry-After: 1`; não são recriadas sob as travas. Falha de banco impede admissão. O commit termina antes de ler o corpo: pedido admitido inválido ou abandonado continua cobrado, sem reembolso. O prazo de recusa atende à maior espera entre as quotas esgotadas.

Bytes contabilizados são estado + memória nativa, sem base64. O corpo de upload tem teto de 2.100.000 bytes; assim a entrada também fica limitada a 42 MB/jogador e 252 MB/global por minuto, incluindo tentativas inválidas. No máximo dois parsers de states simultâneos, timeout 30 s, após autorização/CSRF. Falhas retornam 429 e prazo; repetição idêntica já confirmada não gasta outra gravação, mas ainda passa pela admissão de entrada. Versão, checksum, reserva/geração, quota total e trava de backup continuam obrigatórios. Não ampliar cadência do autosave nativo nem remover travas para superar o orçamento.

## Auditoria

`security_audit` registra login/logout/senha/MFA, administração de usuários/catálogo, gravação/leitura de states, exclusão de saves e takeover explícito. Guarda evento, horário, ator UUID quando conhecido, alvo, jogo/slot quando aplicável, resultado HTTP e correlação gerada no servidor (`X-Request-ID`). IP e nome de login são representados por hashes, não por texto original. Não recebe senha, token, segredo TOTP, código de recuperação, corpo de save, ROM, nome de upload ou SQL.

Expiração após 30 dias, conferida periodicamente enquanto o serviço está ativo, e anel de 50 mil registros; eventos novos podem substituir os mais antigos antes disso. Fila em memória de 128, envio a cada segundo, até 600 eventos autenticados/min e 60 anônimos/min (seis/IP). Excesso é amostrado e resumido em `audit.sampled`; falhas de banco/encerramento abrupto podem perder eventos. É trilha operacional limitada, não registro completo à prova de adulteração. Apenas manutenção autorizada consulta a tabela; não foi criada tela pública nem exportação. Logs dos containers têm rotação de 3 × 10 MB na configuração local.

## MASTER: MFA e sessão

TOTP via **otplib 13.5.0**, seis dígitos, SHA-1, período 30 s; aceita o intervalo atual ou anterior, nunca reutiliza passo já confirmado. Banco e aplicação serializam consumo de TOTP e recuperação. Servidor precisa de relógio correto. Segredos são cifrados com AES-256-GCM, IV aleatório e vínculo ao UUID do usuário; `MFA_ENCRYPTION_KEY_FILE` aponta para arquivo externo de 32 bytes em hexadecimal. Ausência/erro da chave não libera administração.

Senha correta gera sessão de pré-autenticação de cinco minutos, restrita a MFA, identificação e logout. Nenhum master joga/administra antes do segundo fator, inclusive sessões antigas sem MFA. Cadastro pendente é cifrado, vinculado à sessão, vence em até dez minutos (também sujeito à expiração dessa sessão) e só é ativado após código válido. Nunca cadastrar automaticamente uma conta pessoal.

Confirmação gira cookie/CSRF; cadastro e recuperação revogam as outras sessões. Dez códigos aleatórios de recuperação são exibidos uma vez, armazenados somente como SHA-256 e consumidos atomicamente. Cada código substitui o segundo fator **junto da senha**. Substituição do autenticador exige senha + fator atual/recuperação; o fator anterior permanece válido até confirmar o novo.

Sessão verificada: máximo oito horas (`MASTER_SESSION_TTL_HOURS`, 1–8) e inatividade HTTP de 15 minutos (`MASTER_IDLE_MINUTES`, 1–30). Heartbeat conta como atividade; não é detecção de presença física. Administração e troca da própria senha exigem confirmação de senha + MFA nos últimos dez minutos. Reautenticação válida gira sessão/CSRF; senha sozinha não atende. Jogadores mantêm suas regras de sessão/revogação. Passos e recuperação: [guia de uso](guia-de-uso.md#segurança-do-master).

## CSP no documento

Vite serve `Content-Security-Policy-Report-Only` no **HTML**. O build gera `dist/csp-policy.json` com o nome/valor do header correspondente aos hashes do HTML daquela compilação; o preview usa esse arquivo. Um servidor estático externo deve instalar esse header no documento, inclusive fallback da SPA. Copiar apenas o cabeçalho da API não protege a página.

Política: origens locais, hashes dos scripts iniciais, `wasm-unsafe-eval` para WASM, sem `unsafe-eval` JavaScript nem `unsafe-inline` para scripts. Worker é same-origin; worklet de áudio é arquivo local, sem permissão `data:` de script. Imagens usam self/blob/data; estilos por atributo continuam permitidos para dimensões/cores do player. No desenvolvimento há exceção de estilos inline para HMR e WebSocket loopback; **não copiar essas exceções para um servidor estático**. Build usa hashes do estilo inicial e folhas locais. Não há coletor remoto de violações: conferir DevTools/eventos CSP. Report-Only detecta mas não bloqueia; enforcement depende do aceite operacional abaixo.

## Banco e containers

- Migrador/bootstrap: papel `emulador`, proprietário do schema, sem superusuário. API: **`emulador_runtime`**, sem DDL, TRUNCATE, TEMP, gestão de papéis ou escrita em `schema_migrations`; permissões DML explícitas e uso da sequência de auditoria. Credenciais separadas; API não recebe a senha do migrador.
- Migrações novas 007–010: retenção, auditoria/orçamentos, MFA e grants. 001–006 não foram editadas. Provisionamento do LOGIN runtime é tarefa explícita com credencial administrativa, não da API. `grant-runtime` reaplica ACLs após restauração, pois dumps omitem ACL/owner.
- Frontend só nas redes web/API; banco só na rede de dados interna; backend faz a ligação API/dados. Apenas loopback do frontend é publicado. Sem Docker socket ou serviços novos de cache.
- Frontend/backend sem root, filesystem readonly, `/tmp` limitado, todas capabilities removidas, `no-new-privileges`, 128 PIDs; memória 512 MiB/1 GiB respectivamente. Catálogo é a exceção persistente gravável do backend. PostgreSQL: readonly fora dos volumes/tmpfs, 256 PIDs/1 GiB e somente capacidades necessárias ao entrypoint (troca de UID/GID e permissões). Bootstrap temporário conserva apenas a exceção para ler `.env` privado.

Procedimento de upgrade/recuperação e guarda da chave MFA: [operação](operacao.md#upgrade-de-segurança-007010). Esses limites foram ensaiados localmente; não são dimensionamento aprovado de um servidor remoto.

## Matriz de entrega e aceite pendente

| Achado | Código/preparação local | Dependência para segurança aplicada |
| --- | --- | --- |
| SEC-01 | Login desacoplado da troca de senha; pressão por nome exige prova, sem lock global; testes multi-IP/expiração | Aplicar backend+frontend+schema juntos e observar carga legítima |
| SEC-02 | Admissão barata, concorrência/fila/memória limitadas, TTL/índices/limpeza autônoma, cardinalidade transacional | Validar capacidade e limites da borda real; processo único não constitui defesa volumétrica externa |
| SEC-03 | Cadeia Vite local e rejeição de spoofing preservadas; requisitos abaixo | Topologia/proxy/túnel público ainda não definidos nem validados nesta tarefa |
| SEC-04 | CSP Report-Only no HTML e artefato por build; Chromium dev/build GB/GBA sem violações no fluxo ensaiado | Instalar no servidor estático correto, observar fluxos reais e só então decidir enforcement |
| SEC-05 | TOTP, recuperação única, reautenticação e sessões MASTER próprias; testes sintéticos | Guardar chave/backup e **cada dono cadastrar seu MFA** após aplicação; nenhuma conta pessoal inscrita |
| SEC-06 | Auditoria estruturada com amostragem/retenção e sem conteúdo privado | Aplicar schema/serviço; definir acompanhamento do operador e destino protegido se necessário |
| SEC-07 / RECHECK-01 | Orçamentos persistentes e retries idempotentes; ingresso ator/global corrigido atomicamente e revalidado com duas APIs em banco descartável | Aplicar API/schema e observar uso; quotas não substituem capacidade de armazenamento |
| SEC-08 | Papel runtime separado, redes e containers restritos; instalação/upgrade isolados | Aplicar credenciais/grants/configuração sob manutenção autorizada com backup verificado; adaptar overrides externos |
| OPS-01 | Backup v4 preservado; restauração isolada de nativo/state e coluna MFA conferida | Definir destino externo, criptografia/chaves, agenda, retenção, responsáveis, RPO/RTO e ensaio integral fora da origem |

### Requisitos para aplicação operacional

Antes de qualquer ação remota, ler o contexto privado indicado por AGENTS e obter autorização de aplicação. Não inferir domínio, túnel, destino de backup nem janelas a partir deste documento.

Aceite de proxy/IP: desenhar os saltos reais e as redes de acesso; provar que o backend só é alcançável pela borda autorizada; remover cabeçalhos de IP vindos do cliente e encaminhar uma identidade validada; testar dois clientes distintos, IPv4/IPv6, spoofing direto e pelo proxy, NAT, origem/cookie Secure/CSRF e limites reais. Não ativar `trust proxy` irrestrito. Caso haja mais de um salto confiável, adaptar e testar a cadeia explicitamente; o Vite atual aceita somente o endereço do socket como fonte de verdade.

Aceite de implantação: backup conjunto verificado antes de migrar; credenciais runtime/migrador distintas; chave MFA protegida recuperável; imagens/frontend/API/schema compatíveis; inspeção dos privilégios/redes realmente aplicados; CSP no HTML real em Report-Only e posterior decisão de enforcement; matrícula humana de MFA e teste do procedimento de recuperação. Nenhum desses aceites foi realizado remotamente por esta tarefa.

Aceite de backup externo: escolher com o dono destino/RPO/RTO/retenção e responsáveis; incluir banco, catálogo, configuração, credenciais/chave MFA e binário/fontes exatos do core; proteger transporte/armazenamento e acesso às chaves. Demonstrar restauração integral em destino isolado, revogação das sessões, validação dos hashes, login MFA e abertura dos estados compatíveis. Backup no mesmo host e dump sem chave MFA não bastam. Manter essas escolhas e inventários particulares na documentação administrativa privada.

Referências primárias: [otplib](https://otplib.yeojz.dev/), [Node crypto](https://nodejs.org/api/crypto.html), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html), [Vite CSP](https://vite.dev/guide/features.html#content-security-policy-csp), [PostgreSQL GRANT](https://www.postgresql.org/docs/18/sql-grant.html), [Compose services](https://docs.docker.com/reference/compose-file/services/).
