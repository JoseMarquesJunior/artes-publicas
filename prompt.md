Construa um projeto completo e funcional chamado "artes-publicas": um buscador de contratações públicas na área de artes visuais, usando dados do PNCP (Portal Nacional de Contratações Públicas), publicado no GitHub Pages. Custo zero, sem backend e sem dependências externas além do Node 20 e do que o GitHub Actions oferece.

## Arquitetura (não mude)

A página NÃO consulta a API ao vivo. Um GitHub Action roda diariamente, baixa as contratações novas, filtra por palavras-chave e commita um JSON no repositório. A página estática lê só esse JSON e faz busca/filtro no navegador.

Estrutura:
- scripts/fetch.mjs — coletor (Node 20, só `fetch` nativo, zero pacotes npm)
- scripts/keywords.json — lista de palavras-chave, editável por quem não programa
- docs/index.html, docs/app.js, docs/style.css — a página (vanilla JS, sem framework, sem build)
- docs/data/contratacoes.json — base acumulada (gerada pelo script)
- docs/data/meta.json — data/hora da última atualização e contagens
- .github/workflows/atualizar.yml — cron diário + workflow_dispatch manual
- README.md — como funciona, como editar as palavras-chave, como rodar localmente
- Publicação no GitHub Pages a partir da pasta /docs da branch main

## API do PNCP

Base: https://pncp.gov.br/api/consulta/v1
Swagger: https://pncp.gov.br/api/consulta/swagger-ui/index.html
É pública, sem autenticação. ANTES de escrever o coletor, consulte o OpenAPI em https://pncp.gov.br/api/consulta/v3/api-docs e confirme os nomes exatos dos parâmetros e dos campos de resposta — não confie de memória.

Endpoint principal: GET /contratacoes/publicacao
Parâmetros: dataInicial e dataFinal (formato AAAAMMDD), codigoModalidadeContratacao (obrigatório), pagina, tamanhoPagina (mínimo 10; a API responde 400 abaixo disso; use 50 e trate a paginação pelos campos totalPaginas/paginasRestantes da resposta).

Modalidades a varrer (uma chamada por modalidade por dia):
- 3 = Concurso
- 8 = Dispensa de licitação
- 9 = Inexigibilidade (caminho usual para contratar artista — art. 74 da Lei 14.133)
- 12 = Credenciamento
- 6 = Pregão eletrônico
Deixe a lista de modalidades em uma constante configurável.

Campos esperados em cada item (confirme no Swagger): numeroControlePNCP, objetoCompra, modalidadeNome, situacaoCompraNome, valorTotalEstimado, dataPublicacaoPncp, dataAberturaProposta, dataEncerramentoProposta, orgaoEntidade.razaoSocial, orgaoEntidade.cnpj, unidadeOrgao.ufSigla, unidadeOrgao.municipioNome, anoCompra, sequencialCompra, linkSistemaOrigem.

Link para a página do edital no portal: https://pncp.gov.br/app/editais/{cnpj}/{anoCompra}/{sequencialCompra}

## Coletor (scripts/fetch.mjs)

- Aceita --dias N (padrão 2; para o primeiro carregamento rodar com --dias 90). Busca da data atual menos N dias até hoje.
- Quebra o intervalo em janelas de no máximo 30 dias se a API limitar o período.
- Para cada modalidade, pagina até o fim. Entre requisições, espere 300 ms. Em erro 429 ou 5xx, faça retry com backoff exponencial (até 4 tentativas). Nunca aborte a execução inteira por falha em uma modalidade — registre e continue.
- Filtra pelo campo objetoCompra: normalize (minúsculas, sem acentos) e teste contra scripts/keywords.json, que tem duas listas: "incluir" e "excluir". Um item entra se bater em alguma palavra de "incluir" e nenhuma de "excluir". Registre no item quais palavras bateram (campo "tags").
- Mescla com o docs/data/contratacoes.json existente, deduplicando por numeroControlePNCP (o registro mais novo prevalece). Ordena por dataPublicacaoPncp decrescente. Descarta registros com mais de 365 dias.
- Grava só os campos necessários à página (não despeje o objeto bruto inteiro).
- Atualiza docs/data/meta.json com atualizadoEm (ISO), total e totalNovos.
- Imprime um resumo no console.

Conteúdo inicial de scripts/keywords.json:
incluir: artes visuais, artista visual, artista plástico, artes plásticas, exposição, expositivo, curadoria, curador, mostra de arte, oficina de arte, oficina de desenho, oficina de pintura, ilustração, ilustrador, mural, muralismo, grafite, grafiteiro, arte urbana, cenografia, cenógrafo, design gráfico, identidade visual, diagramação, fotografia artística, acervo, museologia, museu, galeria de arte, restauro, restauração de obra, conservação de acervo, arte-educação, arte educador, mediação cultural, escultura, gravura, serigrafia, cerâmica artística, produção cultural, projeto cultural, instalação artística, performance artística
excluir: software, licença, informática, equipamento de informática, medicamento, veículo, pneu, combustível, engenharia, pavimentação, limpeza urbana, vigilância, alimentação escolar, merenda

## Página (docs/)

- Português do Brasil, responsiva, funcionando bem no celular.
- Topo: título, subtítulo de uma linha explicando o que é, e "Atualizado em …" vindo do meta.json.
- Campo de busca por texto (busca em objeto, órgão e município, sem diferenciar acento/maiúscula), filtro por UF (select com as UFs presentes nos dados, com opção "Todas"), filtro por modalidade, e um toggle "Só com propostas abertas" (dataEncerramentoProposta no futuro). Estado dos filtros refletido na URL (querystring) para dar para compartilhar um link filtrado.
- Lista em cards: objeto (truncado com "ver mais"), órgão, município/UF, modalidade, valor estimado formatado em R$, datas de publicação e encerramento, tags que bateram, botão "Ver no PNCP" abrindo o link em nova aba. Destaque visual para itens cujo prazo encerra nos próximos 7 dias.
- Ordenação: mais recentes primeiro; opção para ordenar por prazo de encerramento.
- Um aviso discreto no rodapé: "O PNCP cobre contratações de serviços. Editais de fomento e prêmios (Lei Paulo Gustavo, PNAB etc.) são publicados em outros canais."
- Visual limpo e sóbrio, uma cor de destaque, boa tipografia, modo escuro respeitando prefers-color-scheme. Sem CDN.

## Workflow (.github/workflows/atualizar.yml)

- cron diário às 06:00 UTC + workflow_dispatch com input opcional "dias".
- actions/checkout, setup-node 20, roda `node scripts/fetch.mjs --dias ${{ inputs.dias || 2 }}`, e commita docs/data/*.json só se houve mudança (git diff --quiet). permissions: contents: write.

## Entrega

1. Crie todos os arquivos.
2. Rode `node scripts/fetch.mjs --dias 30` localmente e mostre o resumo. Se a API retornar erro ou campos diferentes do esperado, corrija o script com base na resposta real e me conte o que mudou.
3. Sirva a pasta docs localmente (ex.: npx serve docs) e confirme que a página carrega os dados.
4. No final, liste os passos manuais que preciso fazer no GitHub (ativar Pages apontando para /docs, permitir que Actions escrevam no repositório).