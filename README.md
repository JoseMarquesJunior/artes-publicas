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
scripts/fontes/pncp.mjs           ─┐
scripts/fontes/mapas.mjs          ─┤→ scripts/fetch.mjs → classificar.mjs (classificador + extrator) → docs/data/*.json → GitHub Pages
scripts/fontes/querido-diario.mjs ─┘
```

## Fontes

| Fonte (`fontes.json`) | O que é | Estado |
| --- | --- | --- |
| `pncp` | API pública do PNCP, `GET /v1/contratacoes/publicacao`, modalidades Concurso, Dispensa, Inexigibilidade, Credenciamento e Pregão eletrônico | ativa |
| `mapas:nova-lima`, `mapas:santa-luzia`, `mapas:ribeirao-das-neves` | Instâncias municipais do Mapas Culturais na Grande BH | ativas, coletadas pelo Action |
| `mapas:bh` | Mapa Cultural BH (Fundação Municipal de Cultura) | ativa, mas **bloqueada no CI**: o WAF (GoCache) devolve 403 a IPs de datacenter, inclusive do GitHub Actions, com qualquer cabeçalho. Só é coletada quando `fetch.mjs` roda numa máquina comum (`bloqueadoNoCI: true` em `fontes.json`) |
| `mapas:lagoa-santa` | Mapa Cultural Lagoa Santa | ativa, **bloqueada no CI** (desafio JavaScript do Cloudflare para datacenters); mesma regra acima |
| `mapas:nacional` | Mapa da Cultura (MinC), hoje em `mapa.cultura.gov.br` | ativa só no **runner próprio** (`bloqueadoNoCI`): o desafio do Cloudflare bloqueia IPs de datacenter e também o `fetch` do Node de IP residencial, mas o `curl` de IP residencial passa; por isso `viaCurl: true` (a requisição sai pelo curl do sistema, sem dependência npm). Mantém só editais de MG ou sem estado informado (a instância nacional não preenche o estado do responsável, então quase tudo entra e a IA decide) |
| `amm` | Diário Oficial dos Municípios Mineiros (AMM, sistema SIGPub): busca por texto e por prefeitura, matérias em HTML | ativa para Ribeirão das Neves, Vespasiano, Santa Luzia e Lagoa Santa |
| `pbh-fmc`, `fcs`, `iepha` | Páginas de licitações/editais da Fundação Municipal de Cultura de BH, da Fundação Clóvis Salgado e do IEPHA-MG (PDFs; só o título chega à IA) | ativas; a da FMC só tem editais até 2018 (os atos atuais da FMC vêm pelo `dom-bh`) e a do IEPHA só concorrências de 2024 |
| `querido-diario` | Busca textual nos diários oficiais municipais via API do [Querido Diário](https://queridodiario.ok.org.br) (Open Knowledge Brasil); a IA extrai título, prazo, órgão e valor de cada trecho | ativa para **Contagem** e **Betim**; ver cobertura abaixo |
| `dom-bh` | Diário Oficial do Município de Belo Horizonte, direto da API pública da Prodabel (`api-dom.pbh.gov.br`): edições por data → sumário → conteúdo de cada ato; entram atos dos órgãos de cultura (FMC, SMC, Belotur) e atos cujo título casa as palavras-chave; a IA extrai o resto | ativa |
| `minc` | Página "Editais" do Ministério da Cultura (inscrições abertas e em andamento), com o texto de cada edital | ativa (abrangência nacional) |
| `funarte` | Página "Editais abertos" da Funarte, com o texto de cada edital | ativa (abrangência nacional) |
| `secult-mg` | Páginas de editais do Fundo Estadual de Cultura (FEC) e da PNAB da Secult-MG; os editais são PDFs, então o registro usa o título do link, que costuma trazer "prazo prorrogado até", e agrupa retificações do mesmo edital | ativa (só editais do ano corrente) |

As fontes `minc`, `funarte` e `secult-mg` usam o adaptador genérico [`scripts/fontes/paginas.mjs`](scripts/fontes/paginas.mjs) (tipo `html` em `fontes.json`), configurado por regex de links, bloco da página e agrupamento. Para adicionar outra página de editais, copie um bloco e ajuste `listas`, `padraoItem` e, se houver página própria por edital, `detalhe: true`. A Lei Rouanet em si não publica editais (é um mecanismo de incentivo); o que existe de federal aparece nas páginas do MinC e da Funarte.

### Instituições culturais e residências (tipo `paginas`)

Fontes `html:<slug>` em `fontes.json`, com o mesmo adaptador genérico, mas no modo "instituição": User-Agent identificando o projeto, 1 requisição por segundo, só links que ainda não estão na base (nem em `_descartados-qd.json`), no máximo `maxLinks` (20) links novos por fonte por rodada, e teto de custo de **US$ 0,20 por rodada** para o conjunto (`TETO_INSTITUICOES_USD` em `fetch.mjs`: passando disso, o excedente fica para a rodada seguinte e `meta.avisos` registra). Cada página de edital vai ao **extrator por IA**, que preenche título, resumo, prazo, valor, categoria e **participação** (obrigatória); o `link` é a página do edital na instituição, `uf` fica `null` quando a abrangência é nacional e, na deduplicação, o registro da instituição vence o do diário ou do PNCP. `paginaUnica: true` é para programas com página fixa (residências): a própria página vira o registro, e um novo registro só nasce quando o texto muda. Itens "N" saem da base e vão para `_descartados-qd.json`, como os do diário. Estatísticas por fonte em `meta.fontes[]`: `paginasLidas`, `linksSeguidos`, `extraidos`, `relevantes`, `duvidas`, `custoUsd` (rateado).

Levantamento feito em 2026-10-18 (cada site foi aberto; URLs não foram chutadas):

| Fonte | Página lida | Abrangência | Situação |
| --- | --- | --- | --- |
| `html:cc-ufmg` | [Centro Cultural UFMG — chamadas](https://www.ufmg.br/centrocultural/category/editais/) | MG (aceita propostas de qualquer lugar) | ativa; chamadas anuais de galerias, residência e eventos (set–nov) |
| `html:sesi-cultura-mg` | [SESI Cultura MG — notícias](https://www.fiemg.com.br/sesi-cultura/noticias/) | MG | ativa; não há página de editais, as seleções das Galerias SESI saem como notícia |
| `html:bolsa-pampulha` | [Bolsa Pampulha (FMC/MAP)](https://prefeitura.pbh.gov.br/fundacao-municipal-de-cultura/museus/bolsa-pampulha) | nacional (residência em BH) | ativa; página única com o edital vigente |
| `html:guignard` | [Escola Guignard — notícias](https://www.uemg.br/institucional-guignard/noticias) | MG | ativa; sem página de editais (os "comunicados" são eleições internas) |
| `html:inima` | [Museu Inimá de Paula — notícias](https://museuinimadepaula.org.br/noticias/) | MG | ativa; raramente publica chamadas (concurso de desenho infantil) |
| `html:sesc-mg` | [Sesc em Minas — notícias](https://sescmg.com.br/noticias/) | MG | ativa; sem página de editais; filtro por título e a IA descarta o resto |
| `html:jaca` | [JA.CA — residências](https://www.jaca.center/categoria/residencias/) | nacional (Nova Lima/MG) | ativa |
| `html:mis-sp` | [MIS-SP — seleção de projetos](https://mis-sp.org.br/selecao-de-projetos/) | nacional | ativa (Nova Fotografia, MIS em Cena) |
| `html:pivo` | [Pivô — notícias](https://pivo.org.br/noticias/) | nacional | ativa; chamadas de residência (Pivô Boulevard, Pivô Pesquisa) |
| `html:tomie-ohtake` | [Instituto Tomie Ohtake — Residência Juntó](https://www.institutotomieohtake.org.br/residencia-junto/) | nacional | ativa; página única (o site não tem seção de editais) |
| `html:paco-das-artes` | [Paço das Artes — Temporada de Projetos](https://pacodasartes.org.br/temporada-de-projetos/) | nacional | ativa; página única da convocatória anual |
| `html:capacete` | [Capacete — residência de longa duração](https://capacete.org/residencias/residencia-de-longa-duracao/) | nacional/internacional | ativa; página única (o domínio capacete.net morreu; é capacete.org) |
| `html:mar` | [Museu de Arte do Rio — notícias](https://museudeartedorio.org.br/midia/noticias/) | nacional | ativa; filtro ignora "selecionados", "resultado" |
| `html:res-artis` | [Res Artis — open calls](https://resartis.org/open-calls/) | internacional | ativa; lista mundial em inglês (título original, resumo em português), 20 chamadas novas por rodada |
| `mapas:ce` | Mapa Cultural do Ceará (API) | CE | ativa (2026-10-19); entra com a UF da instância, então aparece com o filtro "todas" ou nos segmentos enviar obra/residência |
| `mapas:pe` | Mapa Cultural de Pernambuco (API) | PE | ativa, **bloqueada no CI**: a conexão expira a partir do GitHub Actions e responde de IP residencial; coletada pelo runner próprio ou localmente |
| `html:funceb` | [Funceb — editais](https://www.ba.gov.br/fundacaocultural/editais) | BA (Salões de Artes Visuais da Bahia são nacionais) | ativa; a página lista poucos editais e sem paginação |
| `html:artvsm` | [ArtVSM — arquivo](https://artvsm.substack.com/archive) | nacional | ativa, **bloqueada no CI** (o Substack devolve 403 a datacenters); boletim pago que agrega editais do país inteiro: a IA lê só a prévia e o card leva ao post, não ao edital |
| Prosas (central de editais) | produtos.prosas.com.br/editais | — | **não adicionada**: a lista só é montada por JavaScript (o HTML não traz os editais) |
| Secult-MG (salões e prêmios) | já coberta por `secult-mg` | MG | os prêmios (ex.: Prêmio Coreto) saem na mesma lista de editais FEC; não há página separada de salões |
| Funarte, Fundação Clóvis Salgado | já cobertas (`funarte`, `fcs`) | nacional / MG | — |
| Casa Fiat de Cultura | [casafiatdecultura.com.br](https://casafiatdecultura.com.br/) | — | **não adicionada**: o site só tem programação e ateliês abertos, sem editais |
| Sesc São Paulo | [sescsp.org.br](https://www.sescsp.org.br/) | — | **não adicionada**: não há seção de editais artísticos (só licitações e vagas); as chamadas saem em páginas avulsas |
| Itaú Cultural | [itaucultural.org.br/rumos](https://www.itaucultural.org.br/rumos) | — | **não adicionada**: o site é uma aplicação JavaScript (conteúdo em JSON embutido); o Rumos abre a cada ciclo |
| Fundação Iberê Camargo | [iberecamargo.org.br](https://iberecamargo.org.br/) | — | **não adicionada**: sem seção de editais; a última Bolsa Iberê/CMPC publicada é de 2023 |
| Fundação Bienal de São Paulo | [bienal.org.br](https://bienal.org.br/) | — | **não adicionada**: não faz chamadas abertas a artistas |
| Instituto Moreira Salles | [ims.com.br](https://ims.com.br/) | — | **não adicionada**: as bolsas (ZUM/IMS) saem em notícias avulsas; sem seção de editais (qualquer rota /editais volta para a home) |
| Prêmio PIPA | [premiopipa.com](https://www.premiopipa.com/) | — | **não adicionada**: não tem inscrição (artistas são indicados por comitê) |
| Salão de Arte de Ribeirão Preto (MARP) | ribeiraopreto.sp.gov.br | — | **não adicionada**: o portal da prefeitura devolve 404 para todas as rotas de cultura em 2026-10-18 |
| Salão Anapolino de Arte | anapolis.go.gov.br | — | **não adicionada**: só notícias esparsas; a busca do site não lista resultados em HTML |
| Sítio Roberto Burle Marx | sitioburlemarx.museus.gov.br | — | **não adicionada**: o domínio não resolve; sem programa de residência localizado |
| Casa Tomada | casatomada.com.br | — | **não adicionada**: site com proteção anti-robô (conteúdo só via JavaScript) |
| TransArtists | transartists.org | — | **não adicionada**: desafio JavaScript do Cloudflare mesmo de IP residencial |

### Como sugerir uma instituição

Abra uma [issue no repositório](https://github.com/JoseMarquesJunior/artes-publicas/issues/new) com o **nome da instituição** e a **URL da página onde ela publica editais ou chamadas** (não a home). Se a página listar links para cada edital, entra como fonte `paginas` com `padraoItem`; se for uma página fixa de programa, entra com `paginaUnica: true`. Sites que só funcionam com JavaScript ou que bloqueiam robôs (Cloudflare) não podem ser lidos sem dependências e ficam de fora.

### Querido Diário: cobertura e funcionamento

Dos 15 municípios de interesse (Grande BH e Inconfidentes), em 2026-10-17 o Querido Diário só coleta regularmente **Contagem** e **Betim** (último diário no dia anterior). **Belo Horizonte** está cadastrada desde 2021, mas o raspador deles parou em **25/03/2026**; como a fonte `dom-bh` cobre BH direto da API da Prodabel, BH ficou `coberta: false` no Querido Diário para não gastar requisições. As outras 12 cidades não têm diário coletado lá (`coberta: false`; os códigos IBGE foram todos validados na API do IBGE).

### Diário Oficial dos Municípios Mineiros (AMM)

Verificado em 2026-10-18 no formulário de busca do SIGPub (`/amm-mg/pesquisar`, select de entidades): das 12 cidades sem Querido Diário, publicam na AMM as prefeituras de **Ribeirão das Neves**, **Vespasiano**, **Santa Luzia** e **Lagoa Santa**. Não publicam ali: Nova Lima, Sabará, Ibirité, Brumadinho, Ouro Preto, Congonhas; de Mariana só a Câmara e de Itabirito só o SAAE. Para essas, os canais conhecidos (não implementados): Nova Lima e Sabará usam diário próprio no site da prefeitura; Santa Luzia também tem o DOM próprio (`santaluzia.mg.gov.br/dom`); Ouro Preto publica em `ouropreto.mg.gov.br/diario`; Ibirité em `ibirite.mg.gov.br/diario-eletronico`; Sabará e outras pequenas também usam o Diário Oficial do Estado (Jornal Minas Gerais). Não há endpoint JSON: a busca é um GET com `busca_avancada[texto]`, `[entidade]`, `[dataInicio]`, `[dataFim]`, `[pagina]`, e cada matéria tem versão HTML em `/amm-mg/download/matéria/<ID>`, então não foi preciso parser de PDF nem dependência npm. O adaptador [`scripts/fontes/amm.mjs`](scripts/fontes/amm.mjs) usa as mesmas consultas do Querido Diário, 1 requisição por segundo e User-Agent identificando o projeto; o extrator por IA é o mesmo.

Para cada território coberto × consulta de `fontes.json`, o adaptador busca `GET /gazettes` com `territory_ids`, `querystring`, `published_since`/`published_until` (os últimos `--dias`), `size=50`, `excerpt_size=500`, `number_of_excerpts=3`, com 1 s entre requisições. Observações da API: `territory_ids` precisa ser repetido (lista separada por vírgula não funciona); palavras soltas casam qualquer uma delas ("edital" sozinho casa concursos públicos), frases entre aspas são exatas. Cada **trecho** devolvido pela busca vira um registro bruto próprio (`idNaFonte` = `ibge:data:hash(url do PDF):hash(texto)`, estável entre execuções), para a IA julgar cada ato administrativo isoladamente; trechos sem nenhum termo cultural (concurso público, nomeações) são descartados antes da IA. Nada é extraído por regex: título, tipo, resumo, órgão, prazo e valor vêm do **extrator por IA**. Como o mesmo edital aparece em vários trechos e edições, trechos do mesmo município com títulos extraídos muito parecidos são fundidos depois (o que tem prazo vence; o resto completa o vencedor).

**Consultas**: só frases exatas entre aspas (`"artes visuais"`, `"aldir blanc"`, `"chamamento público"`...), porque na API do Querido Diário palavras soltas casam qualquer uma delas e duas frases numa consulta viram OU. A API cai com frequência (503/520/timeout); o adaptador espera 15 s, 30 s e 60 s entre tentativas.

**Extrator** (`scripts/classificar.mjs`, modo `extrair`, usado também pelo DOM-BH e pelas páginas de editais): lotes de 8 trechos, `max_tokens` ≈ 150 por trecho, mesmo modelo e parâmetros do classificador (o Haiku 5.5 rejeita `temperature`; usa-se `thinking: disabled` + `effort: low`). Para cada trecho devolve `relevante` (S/N/D), `titulo`, `tipo`, `resumo` (≤ 200 caracteres), `orgao`, `encerramento` (ISO; `null` se não estiver no texto), `valor`, `categoria`. Menções de passagem (comissões, homologações, extratos de contrato, retificações, concursos para cargos) são "N" e vão para `docs/data/_descartados-qd.json` (só id e data) para não serem reprocessadas. O texto bruto é apagado depois da extração. Tokens e custo ficam separados em `meta.json` (`ia` para a classificação, `ia.extracao` para a extração).

Fontes com `bloqueadoNoCI` são puladas quando a variável `GITHUB_ACTIONS` existe e coletadas normalmente num computador pessoal: rode `node scripts/fetch.mjs --fontes mapas:bh,mapas:lagoa-santa,mapas:nacional,mapas:pe,html:artvsm` e commite `docs/data`; os itens entram como "pendente" e o próximo Action os classifica. Os editais da Prefeitura de BH também saem no Diário Oficial do Município, que a Fase B (Querido Diário) passa a cobrir.

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

`docs/data/_duplicados.json` guarda `{idPerdedor: idVencedor}` das fusões entre fontes, para a duplicata não voltar nem ser reclassificada; `docs/data/_descartados-qd.json` guarda os trechos de diário que a IA marcou "N". A migração do antigo `contratacoes.json` foi feita uma única vez pelo próprio `fetch.mjs`. Registros do Diário Oficial trazem também `regiao` ("Grande BH" ou "Inconfidentes"); os demais recebem `regiao` pelo município.

## Classificação por IA

Cada item novo que passou pelas palavras-chave vai, em lotes de 30, ao `claude-haiku-5-5` (Messages API da Anthropic via `fetch` nativo, sem SDK). A pergunta é a mesma para contratações e editais: *uma profissional formada em artes visuais, residente na Grande BH, pode se candidatar, concorrer ou ser contratada nisso?* Editais de cultura amplos contam como S; exclusivos de música, audiovisual, literatura, dança ou teatro, ou restritos a outro estado, contam como N. O modelo devolve `{"1":["S","exposicao"],...}` e o veredito vai para `ia` e `categoriaIA`.

- **Custo mínimo por desenho.** Só itens sem veredito vão ao modelo; um item avaliado nunca é reavaliado. Cada lote envia número, tipo, fonte, local, órgão e texto (até 600 caracteres), com `max_tokens` proporcional (~12 tokens por item). Tokens e custo estimado ficam em `meta.json` (`ia.tokensEntrada`, `ia.tokensSaida`, `ia.custoUsd`). A carga inicial de 6 mil itens custou US$ 0,13; o dia a dia custa frações de centavo.
- **Prazo no texto integral.** Itens aprovados ou em dúvida sem prazo e com texto integral disponível (`detalhes.textoUrl`: o `.txt` da edição no Querido Diário, o ato no DOM-BH, a página do edital) passam por uma busca de prazo: o coletor baixa o texto, recorta ~6.000 caracteres ao redor do trecho que lembra o título (número do edital ou palavras do título) e pergunta ao modelo só o prazo, a abertura e o valor. Uma tentativa por item (`detalhes.prazoBuscado`), até 40 por execução; estatísticas em `ia.prazos`.
- **Categoria para itens antigos.** Itens aprovados ou em dúvida que não têm `categoriaIA` (classificados antes de a categoria existir) passam por um **categorizador** que pede só a categoria, em lotes de 30 e ~8 tokens por item, sem reavaliar o veredito. Na prática roda uma vez; as estatísticas ficam em `meta.json` (`ia.categorizacao`).
- **Sem chave, nada quebra.** A chave vem de `ANTHROPIC_API_KEY` (segredo do repositório; nunca é gravada). Sem ela os itens ficam `pendente`, aparecem com o selo "não verificado" e são classificados na próxima execução com chave, ou com `node scripts/fetch.mjs --so-ia`.
- **Parâmetros.** O Haiku 5.5 rejeita `temperature` fora do padrão (HTTP 400); a chamada usa `thinking: disabled` e `effort: low`, o mais barato e estável para rotulagem.
- **Erros.** 429/5xx têm retry com backoff (3 tentativas); lote que falha de vez, resposta sem JSON ou com números faltando deixam os itens pendentes para a próxima execução.

### Segundo portão por categoria

Depois da IA, todo item aprovado (S) em categoria `producao` ou `outro` cujo texto (título + objeto + resumo) não contém nenhum termo da lista `fortes` de `keywords.json` (artes visuais, exposição, mural, grafite, ilustração, restauro, acervo, museu, design gráfico, diagramação…) é rebaixado para D e marcado `rebaixadoPorPortao: true`. `meta.json` registra `ia.rebaixadosPortao`.

### Reclassificar a base

`node scripts/fetch.mjs --reclassificar` (ou o input `reclassificar` no workflow) reenvia à IA todos os itens S e D, exceto os revisados manualmente; o veredito anterior fica em `iaAnterior` e `categoriaAnterior` para comparação. Use depois de mudar o prompt. Custa centavos (lotes de 30).

### Vereditos manuais (`scripts/revisados.json`)

Formato: `{ "<id>": { "ia": "S"|"N", "categoriaIA": "exposicao", "obs": "texto livre" } }`. O coletor aplica esse arquivo por cima da IA em toda execução, e os itens listados nunca voltam ao modelo (nem na reclassificação).

Fluxo de revisão: cada card tem o link "Classificação errada?", que abre uma issue no GitHub pelo template [`classificacao.yml`](.github/ISSUE_TEMPLATE/classificacao.yml) com id, título e link já preenchidos; quem abre escolhe "deveria ser S/N", a categoria e uma observação. Para transferir a issue para o arquivo: copie o id do campo "Registro" (os 12 caracteres antes do primeiro "·"), adicione uma entrada em `scripts/revisados.json` com `ia`, `categoriaIA` e `obs` (pode citar o número da issue), commite e feche a issue. Na próxima execução o veredito manual passa a valer.

## Deduplicação entre fontes

Depois da IA, registros de fontes **diferentes** com `ia != N` são comparados: títulos com similaridade de Jaccard ≥ 0,5 sobre palavras **e** (mesmo órgão normalizado **ou** mesma data de encerramento); encerramentos diferentes, ambos informados, impedem a fusão. Vence a fonte estruturada (PNCP e Mapas Culturais sobre Diário Oficial, cujo título vem da IA) e, em empate, o registro com mais campos preenchidos; o link do perdedor vai para `linksExtras` (no card: "Também em …"). A regra é mais estrita que "mesmo órgão" sozinho porque uma prefeitura publica dezenas de dispensas sem data de encerramento, e isso fundiria contratos distintos. `meta.json` registra `dedup.fundidosNestaExecucao`.

## Editar as palavras-chave

Abra [`scripts/keywords.json`](scripts/keywords.json) e edite as duas listas. Cada item é uma palavra ou expressão entre aspas.

- **`incluir`**: o item vira candidato se o texto contiver pelo menos uma destas palavras. Como a IA elimina falsos positivos, a lista pode ter termos genéricos (`arte`, `cultural`, `artista`).
- **`excluir`**: o item é descartado antes da IA se contiver qualquer uma destas (`software`, `medicamento`, `pavimentação`).
- **`excluirFraco`** + **`genericos`**: termos musicais (`show`, `banda`, `cantor`, `atração musical`, `orquestra`...) vetam o item só quando as palavras de `incluir` que bateram são todas genéricas (`arte`, `cultura`, `cultural`...). Assim a contratação de um cantor para um "evento cultural" cai antes da IA (centenas por dia), mas um festival com shows **e** exposição ou oficina de grafite passa. Para páginas de editais e diários oficiais só os vetos se aplicam; `incluir` não é exigido.

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

- Linha de **como participar** (`participacao`, campo independente de tipo e categoria): **Enviar obra** (salões, mostras, chamadas de galerias e museus, concursos de pintura/fotografia/gravura, aquisição de obras para acervo), **Residência**, **Inscrever projeto** (PNAB, LPG, FEC, fundos), **Prestar serviço** (oficina, mural encomendado, curadoria, design, restauro, parecerista), **Formação** e **Todas**, com contagens; na URL, `?part=enviar-obra`. Regra de geografia: em "Enviar obra" e "Residência" o filtro de UF é ignorado e aparece travado em "Brasil inteiro" (esses editais aceitam inscrição de qualquer lugar); nos outros, a UF volta ao padrão MG. Nessas duas, a ordenação padrão é prazo mais próximo, e o card mostra "Inscrições até" com os dias restantes e, quando a IA extraiu, taxa de inscrição e número de obras por artista.
- Duas visões, acima dos filtros: **Abertas agora** (padrão; itens com `acionavel` aberta ou fluxo contínuo, ordenados por prazo mais próximo, com os de prazo desconhecido no fim e um ⚠) e **Radar de mercado** (`?visao=radar`; contratações já decididas e editais encerrados, ordenados por data, com um painel de síntese: dez órgãos que mais contratam, distribuição por categoria, mediana e faixa de valores). A última visão escolhida fica em `localStorage`.
- O campo `acionavel` é calculado pelo coletor (`aberta`, `fluxo-continuo`, `encerrada`, `radar`; `prazoDesconhecido: true` para editais de inscrição sem prazo identificado) e a página recalcula aberta × encerrada pela data atual. `node scripts/fetch.mjs --so-reprocessar` recalcula só os campos derivados.
- Abas **Todas | Contratações | Fomento e prêmios** (fomento + prêmio + residência + chamamento), refletidas na URL (`?tipo=fomento`).
- UF **MG** pré-selecionada; opções **Todas** e **Nacional** (itens com `uf` nula valem para qualquer UF). Filtro de **Região** (Grande BH | Inconfidentes | Outras), derivado do município (campo `regiao`, preenchido pelo coletor a partir da lista de territórios de `fontes.json`).
- Cards do Diário Oficial mostram "Diário Oficial de {município}" no selo, o resumo extraído em destaque (o título vem da IA), botão "Ver no Diário Oficial (PDF)" e, quando a IA não achou o prazo no trecho, "⚠ prazo não identificado".
- Busca em título, resumo, objeto completo, órgão e município; filtro por modalidade (PNCP); "Só com prazo aberto"; "Mostrar também os em dúvida".
- Ordenação padrão por **relevância**: aprovados antes dos não verificados, categorias claramente de artes visuais (exposição, curadoria, mural, ilustração, restauro, design, oficina, prêmio, residência) antes de fomento geral, produção e "outro", e mais recentes primeiro nos empates. Também por data ou por prazo (`?ord=recentes`, `?ord=prazo`).
- Cada card mostra selo de tipo, fonte, categoria da IA (tag colorida), palavras-chave, "Propostas até"/"Inscrições até", destaque para prazos nos próximos 7 dias, e botão para a página original. Itens reprovados pela IA nunca aparecem.
- O rodapé lista as fontes ativas lendo `meta.json`; o cabeçalho avisa, por fonte, quando a última coleta foi parcial ("Diário Oficial (13 de 24 consultas falharam)"), a partir de `meta.errosPorFonte`.

## Runner próprio (self-hosted) para as fontes bloqueadas no CI

O GitHub Pages só serve arquivos; quem coleta é o GitHub Actions, e é o IP dos runners do GitHub que o Mapa Cultural BH, Lagoa Santa e o Mapa da Cultura nacional bloqueiam. Um **self-hosted runner** é o agente do Actions instalado no seu computador: o workflow continua no repositório, mas o job roda na sua máquina, com o seu IP residencial. O workflow [`atualizar-local.yml`](.github/workflows/atualizar-local.yml) (`runs-on: self-hosted`, cron às 07:30 UTC, mesmo grupo de `concurrency` do principal, nunca em `pull_request`) lê de `fontes.json` as fontes com `bloqueadoNoCI: true` e roda `fetch.mjs --fontes <lista>`. O `fetch.mjs` pula essas fontes só quando `GITHUB_ACTIONS` está definido **e** `RUNNER_ENVIRONMENT` é `github-hosted`; num runner self-hosted (`RUNNER_ENVIRONMENT=self-hosted`) ou numa máquina comum, coleta.

**Instalar o runner (Windows ou Linux):**

1. No GitHub: *Settings → Actions → Runners → New self-hosted runner*, escolha o sistema operacional e siga os comandos mostrados (baixar o pacote, `config.cmd`/`config.sh --url https://github.com/<você>/artes-publicas --token <token>`). Aceite o nome e os rótulos padrão (o rótulo `self-hosted` é o que o workflow usa).
2. Instale como serviço para iniciar com a máquina: no Windows, responda "Y" à pergunta "Would you like to run the runner as service?" durante o `config.cmd`, ou depois rode `svc.cmd install` e `svc.cmd start`; no Linux, `sudo ./svc.sh install && sudo ./svc.sh start`.
3. Instale o Node 20 na máquina (o passo `setup-node` do workflow baixa o Node se não houver, mas ter o Node local evita isso).
4. Teste: *Actions → "Atualizar fontes bloqueadas no CI (runner próprio)" → Run workflow*. O job deve aparecer como executado no seu runner (Settings → Actions → Runners mostra "Active").

**Aviso de segurança.** O GitHub recomenda **não** usar runner self-hosted em repositório público, porque um pull request de terceiros pode executar código no seu computador. Duas opções: tornar o repositório privado (o Pages continua funcionando em contas pagas; em contas gratuitas, Pages exige repositório público), ou aceitar o risco com as mitigações já aplicadas: o workflow tem `if: github.event_name != 'pull_request'` (nunca roda em PR), e você deve marcar em *Settings → Actions → General → Fork pull request workflows* a opção **"Require approval for all outside collaborators"** (ou "Require approval for all external contributors"), para nenhum workflow de fork rodar sem sua aprovação. Não dê ao runner acesso a mais nada da sua máquina do que o necessário (use um usuário sem privilégios).

**Plano B: tarefa agendada local.** Sem runner, os scripts [`scripts/coleta-local.ps1`](scripts/coleta-local.ps1) (Windows) e [`scripts/coleta-local.sh`](scripts/coleta-local.sh) (Linux/macOS) fazem `git pull`, rodam o coletor só com as fontes bloqueadas e fazem commit + push se houve mudança. Os comentários no topo de cada um mostram como agendar (Agendador de Tarefas / cron). Exigem git e node no PATH e o repositório clonado com credenciais salvas; `ANTHROPIC_API_KEY` é opcional (sem ela os itens entram pendentes e o Action do GitHub classifica no dia seguinte).

### Contador de visitas

O rodapé mostra um badge do [hits.sh](https://hits.sh) para `josemarquesjunior.github.io/artes-publicas`, igual ao do carroscopio: cada carregamento da página soma 1 e a imagem SVG volta com o total. Não usa cookies nem script de terceiros; a tag `<img>` é injetada por JavaScript no fim de `index.html` para cópias locais e pré-renderizações não contarem. Limitações: conta carregamentos (não visitantes únicos), não tem painel e a contagem fica no serviço, não no repositório.

## Publicar no GitHub

1. *Settings → Pages → Deploy from a branch → `main`, pasta `/docs`*.
2. *Settings → Actions → General → Workflow permissions → Read and write*.
3. *Settings → Secrets and variables → Actions → New repository secret* → `ANTHROPIC_API_KEY`.
4. *Actions → Atualizar dados do PNCP → Run workflow* para a primeira carga (`dias` = 30; 90 dias devem ser divididos em três execuções com `ate`, porque uma só estouraria o limite de 6 h do job).

## Limitações

- O filtro inicial é por palavras-chave; a IA corrige a maior parte dos falsos positivos, mas revise sempre o edital original.
- O Mapa da Cultura nacional não pode ser lido por scripts (Cloudflare). Editais federais e de estados sem Mapa Cultural ainda não aparecem.
- Instituições sem página de editais (Casa Fiat, Sesc SP, Itaú Cultural, Iberê Camargo, Bienal, IMS) e sites bloqueados (TransArtists, Casa Tomada) não entram; ver a tabela em "Instituições culturais e residências".
- A base guarda 365 dias (`RETENCAO_DIAS` em `scripts/fetch.mjs`); reprovados pela IA saem após 30 dias.
