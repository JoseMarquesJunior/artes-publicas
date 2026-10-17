# Artes Públicas

Buscador de oportunidades públicas na área de **artes visuais**: contratações de serviço do [PNCP](https://pncp.gov.br) e editais de fomento, prêmios e chamamentos das instâncias do **Mapas Culturais** da Grande BH. Página estática no GitHub Pages, atualizada todo dia por um GitHub Action, com filtro por palavras-chave e classificação por IA. Custo zero de infraestrutura, sem backend, sem dependências além do Node 20.

Página: https://josemarquesjunior.github.io/artes-publicas/

## Como funciona

A página **não consulta nenhuma API ao vivo**. Todo dia às 06:00 UTC o workflow [`atualizar.yml`](.github/workflows/atualizar.yml) roda `node scripts/fetch.mjs`, que:

1. percorre as **fontes** listadas em [`scripts/fontes.json`](scripts/fontes.json), uma a uma (a falha de uma nunca derruba as outras: fica registrada em `meta.json`, campo `erros`);
2. filtra cada item pelas **palavras-chave** de [`scripts/keywords.json`](scripts/keywords.json);
3. **mescla** com a base existente em [`docs/data/oportunidades.json`](docs/data/oportunidades.json) (dedup por fonte + id, registros com mais de 365 dias saem);
4. manda os itens novos para a **classificação por IA** (`claude-haiku-5-5`), que decide S/N/D e uma categoria;
5. **deduplica entre fontes** (o mesmo edital no PNCP e num Mapa Cultural vira um registro só);
6. grava `oportunidades.json` e `meta.json`; o Action commita se algo mudou.

A página em [`docs/`](docs/) lê só esses JSON e faz busca, filtros e ordenação no navegador.

```
scripts/fontes/pncp.mjs  ─┐
scripts/fontes/mapas.mjs ─┤→ scripts/fetch.mjs → classificar.mjs → docs/data/*.json → GitHub Pages
(Fase B: querido-diario) ─┘
```

## Fontes

| Fonte (`fontes.json`) | O que é | Estado |
| --- | --- | --- |
| `pncp` | API pública do PNCP, `GET /v1/contratacoes/publicacao`, modalidades Concurso, Dispensa, Inexigibilidade, Credenciamento e Pregão eletrônico | ativa |
| `mapas:nova-lima`, `mapas:santa-luzia`, `mapas:ribeirao-das-neves` | Instâncias municipais do Mapas Culturais na Grande BH | ativas, coletadas pelo Action |
| `mapas:bh` | Mapa Cultural BH (Fundação Municipal de Cultura) | ativa, mas **bloqueada no CI**: o WAF (GoCache) devolve 403 a IPs de datacenter, inclusive do GitHub Actions, com qualquer cabeçalho. Só é coletada quando `fetch.mjs` roda numa máquina comum (`bloqueadoNoCI: true` em `fontes.json`) |
| `mapas:lagoa-santa` | Mapa Cultural Lagoa Santa | ativa, **bloqueada no CI** (desafio JavaScript do Cloudflare para datacenters); mesma regra acima |
| `mapas:nacional` | Mapa da Cultura (MinC) | **desligada**: desafio JavaScript do Cloudflare para qualquer cliente que não seja navegador, inclusive de casa (verificado em 2026-10-17) |

Fontes com `bloqueadoNoCI` são puladas quando a variável `GITHUB_ACTIONS` existe e coletadas normalmente num computador pessoal: rode `node scripts/fetch.mjs --fontes mapas:bh,mapas:lagoa-santa` e commite `docs/data`; os itens entram como "pendente" e o próximo Action os classifica. Os editais da Prefeitura de BH também saem no Diário Oficial do Município, que a Fase B (Querido Diário) passa a cobrir.

Não existe instância estadual de Minas Gerais: a Secult-MG usa a plataforma Descentra Cultura, que não expõe essa API. Contagem, Betim, Sabará, Ibirité, Vespasiano, Brumadinho, Ouro Preto, Mariana, Itabirito e Congonhas não têm instância do Mapas Culturais (verificado em 2026-10-17).

### Adicionar uma instância do Mapas Culturais

1. Confirme que a API responde JSON (algumas bloqueiam robôs; o coletor envia um User-Agent de navegador):
   ```bash
   curl -A "Mozilla/5.0" "https://ENDERECO/api/opportunity/find?@select=id,name&@limit=1"
   ```
2. Copie um bloco em `scripts/fontes.json`:
   ```json
   { "fonte": "mapas:contagem", "tipo": "mapas", "ativo": true, "nome": "Mapa Cultural Contagem",
     "base": "https://ENDERECO", "uf": "MG", "municipio": "Contagem" }
   ```
3. Commite. Na próxima execução a fonte entra; a página passa a listá-la no rodapé automaticamente.

O adaptador busca oportunidades com fim das inscrições a partir de 7 dias atrás (para não perder nada por atraso de coleta), pagina de 50 em 50 com 500 ms entre requisições, ignora fases de outras oportunidades (recurso, documentação complementar) e aplica as palavras-chave sobre título + resumo. Como `cultura` e `cultural` estão na lista, editais amplos de cultura passam para a IA decidir; oportunidades cuja área informada pela fonte é artes visuais passam sempre (tag `área: artes visuais`).

## Esquema unificado (`docs/data/oportunidades.json`)

Um registro por linha:

| Campo | Conteúdo |
| --- | --- |
| `id` | sha1 curto de `fonte:idNaFonte` |
| `fonte` | `pncp`, `mapas:bh`, `mapas:nova-lima`… |
| `idNaFonte` | `numeroControlePNCP` ou id da oportunidade no Mapa |
| `tipo` | `contratacao`, `fomento`, `premio`, `residencia`, `chamamento`, `outro` |
| `titulo` | objeto da compra (160 caracteres) ou nome do edital |
| `resumo` | 1–2 frases (Mapas) ou `null` (PNCP) |
| `orgao`, `uf`, `municipio` | órgão e local; `uf: null` = abrangência nacional |
| `abertura`, `encerramento` | ISO; `encerramento` = fim das propostas (PNCP) ou das inscrições (Mapas); `null` em fluxo contínuo |
| `valor` | valor estimado (PNCP) ou `null` |
| `link`, `linksExtras` | página original; outros lugares onde o mesmo edital apareceu |
| `tags` | palavras-chave que bateram |
| `ia`, `categoriaIA` | `S`/`N`/`D`/`pendente` e categoria (`curadoria`, `oficina`, `design`, `ilustracao`, `mural`, `restauro`, `exposicao`, `premio`, `residencia`, `fomento-geral`, `producao`, `outro`) |
| `coletadoEm` | ISO datetime |
| `publicadoEm`, `detalhes` | extensões para a página: data de publicação na fonte e dados específicos (objeto completo, modalidade, situação, amparo legal, áreas, projeto) |

`docs/data/_duplicados.json` guarda `{idPerdedor: idVencedor}` das fusões entre fontes, para a duplicata não voltar nem ser reclassificada. A migração do antigo `contratacoes.json` foi feita uma única vez pelo próprio `fetch.mjs`.

## Classificação por IA

Cada item novo que passou pelas palavras-chave vai, em lotes de 30, ao `claude-haiku-5-5` (Messages API da Anthropic via `fetch` nativo, sem SDK). A pergunta é a mesma para contratações e editais: *uma profissional formada em artes visuais, residente na Grande BH, pode se candidatar, concorrer ou ser contratada nisso?* Editais de cultura amplos contam como S; exclusivos de música, audiovisual, literatura, dança ou teatro, ou restritos a outro estado, contam como N. O modelo devolve `{"1":["S","exposicao"],...}` e o veredito vai para `ia` e `categoriaIA`.

- **Custo mínimo por desenho.** Só itens sem veredito vão ao modelo; um item avaliado nunca é reavaliado. Cada lote envia número, tipo, fonte, local, órgão e texto (até 600 caracteres), com `max_tokens` proporcional (~12 tokens por item). Tokens e custo estimado ficam em `meta.json` (`ia.tokensEntrada`, `ia.tokensSaida`, `ia.custoUsd`). A carga inicial de 6 mil itens custou US$ 0,13; o dia a dia custa frações de centavo.
- **Sem chave, nada quebra.** A chave vem de `ANTHROPIC_API_KEY` (segredo do repositório; nunca é gravada). Sem ela os itens ficam `pendente`, aparecem com o selo "não verificado" e são classificados na próxima execução com chave, ou com `node scripts/fetch.mjs --so-ia`.
- **Parâmetros.** O Haiku 5.5 rejeita `temperature` fora do padrão (HTTP 400); a chamada usa `thinking: disabled` e `effort: low`, o mais barato e estável para rotulagem.
- **Erros.** 429/5xx têm retry com backoff (3 tentativas); lote que falha de vez, resposta sem JSON ou com números faltando deixam os itens pendentes para a próxima execução.

## Deduplicação entre fontes

Depois da IA, registros de fontes **diferentes** com `ia != N` são comparados: títulos com similaridade de Jaccard ≥ 0,5 sobre palavras **e** (mesmo órgão normalizado **ou** mesma data de encerramento); encerramentos diferentes, ambos informados, impedem a fusão. Vence a fonte estruturada (PNCP/Mapas sobre Diário Oficial) e, em empate, o registro com mais campos preenchidos; o link do perdedor vai para `linksExtras`. A regra é mais estrita que "mesmo órgão" sozinho porque uma prefeitura publica dezenas de dispensas sem data de encerramento, e isso fundiria contratos distintos. `meta.json` registra `dedup.fundidosNestaExecucao`.

## Editar as palavras-chave

Abra [`scripts/keywords.json`](scripts/keywords.json) e edite as duas listas. Cada item é uma palavra ou expressão entre aspas.

- **`incluir`**: o item vira candidato se o texto contiver pelo menos uma destas palavras. Como a IA elimina falsos positivos, a lista pode ter termos genéricos (`arte`, `cultural`, `artista`).
- **`excluir`**: o item é descartado antes da IA se contiver qualquer uma destas (`software`, `medicamento`, `pavimentação`).

Regras de comparação: sem distinção de maiúsculas e acentos; a palavra precisa começar no início de uma palavra do texto e pode continuar por até 3 letras (`curador` encontra `curadores`, não `procurador`; `arte` encontra `artes`, não `artesanato`); plurais em `-ções`, `-ais` e `-ões` são reconhecidos; expressões com espaço precisam aparecer inteiras; hífen e espaço são equivalentes. A lista é reaplicada a toda a base a cada execução.

## Rodar localmente

Requisito: Node.js 20 ou mais novo. Nada de `npm install`.

```bash
node scripts/fetch.mjs                          # PNCP últimos 2 dias (~8 min) + Mapas (segundos)
node scripts/fetch.mjs --dias 30                # primeira carga do PNCP (~2 h; limite da API)
node scripts/fetch.mjs --dias 30 --ate 2026-09-16   # histórico em partes
node scripts/fetch.mjs --fontes mapas:bh,mapas:santa-luzia   # só algumas fontes
node scripts/fetch.mjs --so-ia                  # só classificar pendentes (precisa de ANTHROPIC_API_KEY)
```

**Por que o PNCP demora:** a API limita por IP (surto de ~6 chamadas, bloqueio de ~20 s, 1 chamada a cada 2 s sustentada). As cinco modalidades somam ~6 mil contratações por dia (~120 páginas), ou seja ~4 minutos por dia de histórico. O ritmo é adaptativo: a cada 429 o coletor pausa 30 s, 60 s, 120 s e alarga o intervalo; depois de 40 acertos volta a reduzir.

Para ver a página, sirva a pasta `docs` por HTTP (abrir o `index.html` direto do disco não funciona):

```bash
npx serve docs            # http://localhost:3000
python -m http.server 8080 --directory docs
```

## Página

- Abas **Todas | Contratações | Fomento e prêmios** (fomento + prêmio + residência + chamamento), refletidas na URL (`?tipo=fomento`).
- UF **MG** pré-selecionada; opções **Todas** e **Nacional** (itens com `uf` nula valem para qualquer UF).
- Busca em título, resumo, objeto completo, órgão e município; filtro por modalidade (PNCP); "Só com prazo aberto"; ordenação por data ou prazo; "Mostrar também os em dúvida".
- Cada card mostra selo de tipo, fonte, categoria da IA (tag colorida), palavras-chave, "Propostas até"/"Inscrições até", destaque para prazos nos próximos 7 dias, e botão para a página original. Itens reprovados pela IA nunca aparecem.
- O rodapé lista as fontes ativas lendo `meta.json`.

## Publicar no GitHub

1. *Settings → Pages → Deploy from a branch → `main`, pasta `/docs`*.
2. *Settings → Actions → General → Workflow permissions → Read and write*.
3. *Settings → Secrets and variables → Actions → New repository secret* → `ANTHROPIC_API_KEY`.
4. *Actions → Atualizar dados do PNCP → Run workflow* para a primeira carga (`dias` = 30; 90 dias devem ser divididos em três execuções com `ate`, porque uma só estouraria o limite de 6 h do job).

## Limitações

- O filtro inicial é por palavras-chave; a IA corrige a maior parte dos falsos positivos, mas revise sempre o edital original.
- O Mapa da Cultura nacional não pode ser lido por scripts (Cloudflare). Editais federais e de estados sem Mapa Cultural ainda não aparecem.
- A base guarda 365 dias (`RETENCAO_DIAS` em `scripts/fetch.mjs`); reprovados pela IA saem após 30 dias.
