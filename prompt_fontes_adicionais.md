O projeto "artes-publicas" já coleta contratações do PNCP, classifica com claude-haiku-5-5 e publica em docs/. Agora vamos adicionar duas fontes de editais de fomento (Mapas Culturais e Querido Diário) e unificar tudo num só esquema. Leia o código atual antes de começar. Faça a FASE A inteira, rode, me mostre o resultado, e só então comece a FASE B.

Contexto: o estado de interesse é Minas Gerais (MG). As cidades de interesse são a Grande BH (Belo Horizonte, Contagem, Betim, Nova Lima, Sabará, Santa Luzia, Ribeirão das Neves, Ibirité, Vespasiano, Lagoa Santa, Brumadinho) e a Região dos Inconfidentes (Ouro Preto, Mariana, Itabirito, Congonhas).

====================================================================
FASE A — Esquema unificado + adaptadores + Mapas Culturais
====================================================================

## A1. Refatorar o coletor em adaptadores

Reorganize scripts/ assim:
- scripts/fontes/pncp.mjs — o coletor atual, movido para cá, exportando `async function coletar({ dias })` que devolve um array de registros no esquema unificado abaixo.
- scripts/fontes/mapas.mjs — novo (A3).
- scripts/classificar.mjs — a etapa de IA atual, movida para cá.
- scripts/fetch.mjs — passa a ser só o orquestrador: roda cada adaptador listado em scripts/fontes.json, concatena, mescla com a base existente, classifica, deduplica, grava.
- scripts/util.mjs — fetch com retry/backoff, normalização de texto (minúsculas, sem acento), hash, filtro por keywords. Tudo que é compartilhado.

A falha de um adaptador nunca derruba a execução: registre o erro em meta.json (campo `erros: [{fonte, mensagem}]`) e continue com os outros.

## A2. Esquema unificado (docs/data/oportunidades.json)

Substitui contratacoes.json. Faça uma migração única dos registros existentes. Cada registro:

{
  "id": string,            // hash sha1 curto de `${fonte}:${idNaFonte}`
  "fonte": string,         // "pncp" | "mapas:nacional" | "mapas:mg" | "mapas:bh" | "querido-diario"
  "idNaFonte": string,
  "tipo": string,          // "contratacao" | "fomento" | "premio" | "residencia" | "chamamento" | "outro"
  "titulo": string,
  "resumo": string|null,   // 1–2 frases
  "orgao": string|null,
  "uf": string|null,
  "municipio": string|null,
  "abertura": string|null,     // ISO date
  "encerramento": string|null, // ISO date
  "valor": number|null,
  "link": string,          // sempre a página original
  "linksExtras": string[], // outros lugares onde o mesmo edital apareceu
  "tags": string[],
  "ia": "S" | "N" | "D" | "pendente",
  "categoriaIA": string|null,  // ex.: "curadoria", "oficina", "design", "restauro", "exposicao", "premio"
  "coletadoEm": string     // ISO datetime
}

Regras do PNCP mapeado para esse esquema: tipo = "contratacao"; titulo = objetoCompra truncado em 160 caracteres; resumo = null; encerramento = dataEncerramentoProposta.

## A3. Adaptador Mapas Culturais (scripts/fontes/mapas.mjs)

Mapas Culturais é o software livre do MinC usado por dezenas de instâncias (nacional, estaduais, municipais). Todas expõem a mesma API REST pública, sem autenticação. O adaptador recebe uma lista de instâncias de scripts/fontes.json e roda a mesma lógica em cada uma.

Instâncias a configurar:
- { "fonte": "mapas:nacional", "base": "https://mapas.cultura.gov.br", "uf": null }
- { "fonte": "mapas:mg", "base": "<descobrir>", "uf": "MG" }
- { "fonte": "mapas:bh", "base": "<descobrir>", "uf": "MG", "municipio": "Belo Horizonte" }

Para descobrir as instâncias mineiras: pesquise "mapa cultural minas gerais", "mapa cultural mg secult", "mapa cultural belo horizonte" e "mapa cultural bh pbh". Para cada URL candidata, teste com curl se {base}/api/opportunity/find responde JSON. Mantenha só as que responderem. Se nenhuma instância estadual ou de BH existir ou responder, remova-a do fontes.json, deixe só a nacional, e me diga o que encontrou — não invente URL. Se encontrar instâncias de outras cidades da lista (Contagem, Betim, Ouro Preto etc.), adicione também.

ANTES de escrever o código, descubra o formato exato da API: consulte o repositório github.com/mapasculturais/mapasculturais (documentação da API) e teste ao vivo com curl na instância nacional. O endpoint esperado é GET {base}/api/opportunity/find com a sintaxe de query da plataforma: parâmetros como @select (lista de campos), @order, @limit, @page, e filtros no formato campo=OPERADOR(valor), por exemplo registrationTo=GTE(2026-10-01). Confirme os nomes reais dos campos (name, shortDescription, registrationFrom, registrationTo, owner, project, singleUrl, terms, etc.) olhando a resposta real. Se o formato for diferente do esperado, adapte e me explique o que encontrou.

O que buscar: oportunidades com registrationTo (fim das inscrições) a partir de hoje menos 7 dias (pega as que acabaram de fechar também, para não perder nada por atraso de coleta). Pagine até o fim. Espere 500 ms entre requisições.

Na instância nacional, os editais são do Brasil inteiro. Mantenha todos os que forem de abrangência nacional ou de MG; descarte os que forem claramente de outro estado (use o campo de localização/termos da oportunidade ou do owner quando existir; na dúvida, mantenha e deixe a IA decidir — inclua a UF no texto que vai para o classificador).

Mapeamento: tipo = inferido pelo nome/descrição — "premio" se contiver "prêmio"/"premio", "residencia" se "residência", "chamamento" se "chamamento", senão "fomento". link = singleUrl (ou {base}/oportunidade/{id}). uf = a da instância, ou a extraída do registro na nacional; municipio = o da instância ou null.

Filtro: aplique o mesmo keywords.json (incluir/excluir) sobre titulo + resumo antes de mandar para a IA. Aqui vale ser generoso: muitos editais são "edital de fomento à cultura" sem citar artes visuais no título mas com categoria de artes visuais no corpo. Portanto, se o texto contiver "cultura" ou "cultural" sem bater em "excluir", deixe passar para a IA.

## A4. Classificador: ajustar para múltiplos tipos

O prompt de sistema atual é só sobre contratações. Atualize-o para dizer que os itens podem ser contratações de serviço OU editais de fomento/prêmio/residência, e que em ambos os casos a pergunta é a mesma: "uma profissional formada em artes visuais, residente na Grande BH, pode se candidatar ou concorrer a isso?". Editais de cultura amplos (todas as linguagens artísticas) contam como "S". Editais exclusivos de música, audiovisual, literatura, dança ou teatro contam como "N". Editais restritos a residentes de outro estado contam como "N".

Além de S/N/D, peça uma categoria curta por item (uma palavra: curadoria, oficina, design, ilustracao, mural, restauro, exposicao, premio, residencia, fomento-geral, producao, outro). Resposta continua em JSON de uma linha: {"1":["S","exposicao"],"2":["N",""]}. Mantenha max_tokens proporcional (~12 tokens por item). Grave em categoriaIA.

## A5. Deduplicação entre fontes

Depois de classificar, rode uma passada: agrupe registros com ia != "N" cujo orgao normalizado seja igual (ou cujo titulo normalizado tenha similaridade alta — use uma comparação simples de trigramas ou Jaccard sobre palavras, sem dependências) e cujo encerramento seja igual ou nulo em um dos dois. Mantenha o registro com mais campos preenchidos, mova o link do outro para linksExtras, e remova o duplicado. Registre em meta.json quantos foram fundidos.

## A6. Página

- Novo filtro principal no topo, em segmentos/abas: Todas | Contratações | Fomento e prêmios (fomento + premio + residencia + chamamento). Refletido na URL.
- Filtro de UF: deixe "MG" pré-selecionado por padrão, com opção "Todas" e "Nacional" (itens com uf null).
- Cada card mostra um selo de tipo e, discretamente, a fonte ("PNCP", "Mapa Cultural").
- O card de fomento mostra "Inscrições até {encerramento}" em vez de "Propostas até".
- categoriaIA aparece como uma tag colorida.
- O aviso do rodapé sobre "o PNCP cobre só contratações" deve ser atualizado para listar as fontes ativas, lendo de meta.json.

## A7. Workflow e README

Atualize o workflow para o novo fetch.mjs. Atualize o README explicando as fontes, o esquema e como adicionar uma instância do Mapas Culturais editando fontes.json.

## Entrega da FASE A

Rode `node scripts/fetch.mjs --dias 30`. Me mostre: itens por fonte, quantos passaram no filtro de keywords, quantos a IA aprovou por tipo, quantos foram fundidos na deduplicação, custo estimado. Mostre 5 exemplos de itens aprovados do Mapas Culturais com titulo, tipo, categoriaIA e encerramento. Sirva docs/ localmente e confirme que o filtro por tipo funciona. PARE AQUI e espere meu ok.

====================================================================
FASE B — Querido Diário
====================================================================

## B1. O que é

Querido Diário (Open Knowledge Brasil) coleta diários oficiais municipais e oferece uma API pública de busca textual, sem autenticação. Documentação: https://queridodiario.ok.org.br/api/docs (e docs.queridodiario.ok.org.br). Antes de codar, leia a documentação e teste com curl: endpoint GET https://queridodiario.ok.org.br/api/gazettes com parâmetros como querystring, territory_ids (código IBGE de 7 dígitos), published_since, published_until, size, offset, e campos de resposta como excerpts, url (PDF do diário), date, territory_name. Confirme os nomes reais.

## B2. Adaptador (scripts/fontes/querido-diario.mjs)

Configuração em scripts/fontes.json:

{
  "fonte": "querido-diario",
  "territorios": [
    { "nome": "Belo Horizonte",     "ibge": "3106200", "regiao": "Grande BH" },
    { "nome": "Contagem",           "ibge": "3118601", "regiao": "Grande BH" },
    { "nome": "Betim",              "ibge": "3106705", "regiao": "Grande BH" },
    { "nome": "Nova Lima",          "ibge": "3144805", "regiao": "Grande BH" },
    { "nome": "Sabará",             "ibge": "3156700", "regiao": "Grande BH" },
    { "nome": "Santa Luzia",        "ibge": "3157807", "regiao": "Grande BH" },
    { "nome": "Ribeirão das Neves", "ibge": "3154606", "regiao": "Grande BH" },
    { "nome": "Ibirité",            "ibge": "3129806", "regiao": "Grande BH" },
    { "nome": "Vespasiano",         "ibge": "3171204", "regiao": "Grande BH" },
    { "nome": "Lagoa Santa",        "ibge": "3137601", "regiao": "Grande BH" },
    { "nome": "Brumadinho",         "ibge": "3109006", "regiao": "Grande BH" },
    { "nome": "Ouro Preto",         "ibge": "3146107", "regiao": "Inconfidentes" },
    { "nome": "Mariana",            "ibge": "3140001", "regiao": "Inconfidentes" },
    { "nome": "Itabirito",          "ibge": "3131901", "regiao": "Inconfidentes" },
    { "nome": "Congonhas",          "ibge": "3118007", "regiao": "Inconfidentes" }
  ],
  "consultas": [
    "edital artes visuais",
    "edital fomento cultura",
    "chamamento público cultura",
    "prêmio artes",
    "credenciamento artistas",
    "lei paulo gustavo",
    "política nacional aldir blanc",
    "exposição artes"
  ]
}

Valide cada código IBGE antes de usar, consultando https://servicodados.ibge.gov.br/api/v1/localidades/municipios/{codigo} e conferindo se o nome bate; corrija os que estiverem errados e me avise. Depois verifique na API do Querido Diário se cada território está coberto (faça uma consulta sem querystring com published_since nos últimos 60 dias; se vier vazio, marque "coberta": false no fontes.json e me liste quais cidades ficaram de fora). Belo Horizonte é capital e deve estar coberta; as cidades menores podem não estar.

Para cada território coberto × consulta, busque os diários publicados nos últimos N dias (--dias). Espere 1 s entre requisições. Cada resultado traz um ou mais trechos (excerpts). Junte os trechos de um mesmo diário num único texto. Gere um registro bruto com: fonte, idNaFonte = `${ibge}:${date}:${hash dos trechos}`, link = url do PDF, municipio, uf = "MG", regiao, textoBruto (até 3000 caracteres), coletadoEm. Não tente extrair título/prazo/valor com regex — isso é trabalho da etapa de extração.

Dedupe registros brutos já processados pelo idNaFonte antes de mandar à IA.

## B3. Extrator (em scripts/classificar.mjs, segundo modo)

Para registros de fonte "querido-diario", a IA não só classifica: ela extrai. Crie um segundo prompt de sistema, "extrator", que recebe lotes de até 8 trechos de diário oficial (menores que os lotes de classificação, porque o texto é longo) e devolve, por trecho, um JSON com:

{ "relevante": "S"|"N"|"D", "titulo": string, "tipo": "contratacao"|"fomento"|"premio"|"residencia"|"chamamento"|"outro", "resumo": string (máx. 200 caracteres), "orgao": string|null, "encerramento": "AAAA-MM-DD"|null, "valor": number|null, "categoria": string }

Instruções importantes no prompt: o trecho pode conter vários atos administrativos misturados; focar no que diz respeito a edital/chamamento/prêmio/contratação na área de cultura e artes visuais; se o trecho for só uma menção de passagem (ex.: nomeação de comissão, homologação de resultado, extrato de contrato já assinado, retificação sem conteúdo), marcar "N"; se o prazo não estiver no trecho, encerramento = null (não inventar); datas em formato brasileiro devem ser convertidas para ISO.

Use max_tokens generoso aqui (~150 tokens por trecho). Temperature 0. Grave o resultado nos campos do esquema unificado; descarte textoBruto depois de extrair (não vai para o JSON público). Registre tokens e custo separadamente para "classificacao" e "extracao" em meta.json.

Registros com relevante = "N" são gravados num arquivo separado docs/data/_descartados-qd.json (só idNaFonte + data) para não reprocessar; não entram no oportunidades.json.

## B4. Página

- Fonte "Diário Oficial" no selo do card, com o nome do município.
- Novo filtro de região (Grande BH | Inconfidentes | Outras), derivado do campo regiao quando existir e do município nos demais casos.
- Como o link é um PDF de diário inteiro, o botão vira "Ver no Diário Oficial (PDF)" e o card mostra o resumo extraído em destaque, já que o título vem da IA.
- Itens com encerramento null aparecem com "prazo não identificado" e um ícone de alerta.

## B5. Deduplicação

A passada de dedup da Fase A agora também cruza Querido Diário com Mapas Culturais e PNCP (o mesmo edital municipal costuma aparecer no diário e no Mapa Cultural). Nesses casos, prefira manter o registro do Mapa Cultural/PNCP (dados estruturados) e mova o link do diário para linksExtras.

## Entrega da FASE B

Rode `node scripts/fetch.mjs --dias 30`. Me mostre: para cada território, quantos diários vieram, quantos trechos foram enviados à IA, quantos foram marcados relevantes, custo da extração. Mostre 5 exemplos extraídos completos (titulo, tipo, orgao, encerramento, resumo, link). Depois mostre 5 exemplos que a IA descartou, com os primeiros 200 caracteres do trecho, para eu avaliar. Atualize README e workflow.