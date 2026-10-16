# Artes Públicas

Buscador de contratações públicas na área de **artes visuais**, construído sobre os dados abertos do [PNCP](https://pncp.gov.br) (Portal Nacional de Contratações Públicas). Página estática publicada no GitHub Pages, atualizada todo dia por um GitHub Action. Custo zero, sem backend, sem dependências além do Node 20.

## Como funciona

A página **não consulta a API do PNCP ao vivo**. O fluxo é:

1. Todo dia às 06:00 UTC, o workflow [`atualizar.yml`](.github/workflows/atualizar.yml) roda `node scripts/fetch.mjs --dias 2`.
2. O coletor consulta `GET /v1/contratacoes/publicacao` da API pública do PNCP para cada modalidade configurada, pagina até o fim e filtra o campo `objetoCompra` pelas palavras-chave de [`scripts/keywords.json`](scripts/keywords.json). Os candidatos novos passam então por uma classificação com IA (`claude-haiku-5-5`) que confirma ou descarta cada um (seção [Classificação por IA](#classificação-por-ia)).
3. Os resultados são mesclados com a base existente em [`docs/data/contratacoes.json`](docs/data/contratacoes.json) (deduplicados por `numeroControlePNCP`, registros com mais de 365 dias são descartados) e [`docs/data/meta.json`](docs/data/meta.json) recebe a data da atualização e as contagens.
4. Se algo mudou, o Action commita os dois JSON no repositório.
5. A página em [`docs/`](docs/) lê só esses JSON e faz busca, filtros e ordenação no navegador.

```
scripts/fetch.mjs ──(API PNCP)──▶ docs/data/*.json ──(GitHub Pages)──▶ docs/index.html + app.js
```

### Modalidades varridas

| Código | Modalidade | Por quê |
| --- | --- | --- |
| 3 | Concurso | Concursos de arte e projetos |
| 8 | Dispensa de licitação | Contratações de pequeno valor |
| 9 | Inexigibilidade | Caminho usual para contratar artista (art. 74 da Lei 14.133/2021) |
| 12 | Credenciamento | Cadastros de artistas, oficineiros, mediadores |
| 6 | Pregão eletrônico | Serviços de design, cenografia, montagem |

A lista fica na constante `MODALIDADES` no início de `scripts/fetch.mjs`.

## Estrutura

```
.github/workflows/atualizar.yml   cron diário + execução manual
scripts/fetch.mjs                 coletor (Node 20, só fetch nativo, zero npm)
scripts/keywords.json             palavras-chave (incluir / excluir)
docs/index.html, app.js, style.css  a página (vanilla JS, sem build)
docs/data/contratacoes.json       base acumulada (gerada pelo script)
docs/data/meta.json               última atualização e contagens
```

## Classificação por IA

As palavras-chave trazem falsos positivos inevitáveis ("exposição a agentes químicos", "acervo bibliográfico", "restauração de pavimento"). Por isso o coletor tem uma segunda peneira: cada item novo que passou pelas palavras-chave é enviado, em lotes de 30, ao modelo `claude-haiku-5-5` (API da Anthropic, chamada com `fetch` nativo, sem SDK), que responde por item **S** (é oportunidade em artes visuais), **N** (não) ou **D** (dúvida). O veredito fica no campo `ia` de cada registro.

- **Custo mínimo por desenho.** Só vão ao modelo os itens sem veredito; um item avaliado nunca é reavaliado. Cada lote envia só número, objeto (até 600 caracteres), órgão e modalidade, e pede um JSON de uma linha com `max_tokens` calculado (~8 tokens por item). Uma carga de 30 dias custa centavos de dólar; a execução diária, frações de centavo. Os totais de tokens e o custo estimado ficam em `meta.json` (`ia.tokensEntrada`, `ia.tokensSaida`, `ia.custoUsd`).
- **Sem chave, nada quebra.** A chave vem da variável de ambiente `ANTHROPIC_API_KEY`. Se ela não existir, a coleta roda normalmente e os itens ficam `"ia": "pendente"`; a página os mostra com o selo "não verificado" e eles são classificados na próxima execução que tiver a chave (ou com `node scripts/fetch.mjs --so-ia`, que não consulta o PNCP). A chave nunca é gravada: só existe em memória e no segredo do GitHub.
- **Na página**, por padrão aparecem só os itens **S** e os pendentes (com selo). O controle "Mostrar também os em dúvida" inclui os **D**. Os **N** ficam no JSON por 30 dias (para não serem reclassificados) e nunca aparecem.
- **Erros.** 429 e 5xx têm retry com backoff (até 3 tentativas). Se um lote falhar de vez, ou se a resposta vier sem JSON válido ou com números faltando, os itens afetados ficam pendentes e voltam à fila na próxima execução.
- **Parâmetros.** O Haiku 5.5 rejeita `temperature` diferente do padrão (HTTP 400), então, em vez de `temperature: 0`, a chamada desliga o raciocínio estendido (`thinking: disabled`) e usa `effort: low`, o que é o mais barato e dá respostas estáveis para uma tarefa de rótulo.

Para ligar no GitHub: *Settings → Secrets and variables → Actions → New repository secret*, nome `ANTHROPIC_API_KEY`, valor a chave criada em [platform.claude.com](https://platform.claude.com). O workflow já lê `secrets.ANTHROPIC_API_KEY`.

## Editar as palavras-chave

Abra [`scripts/keywords.json`](scripts/keywords.json) e edite as duas listas. Não é preciso saber programar: cada item é uma palavra ou expressão entre aspas, separadas por vírgula.

- **`incluir`**: o edital vira candidato se o objeto contiver pelo menos uma destas palavras. As que bateram aparecem na página como *tags*. Como a IA elimina os falsos positivos, a lista pode ter termos genéricos (`arte`, `cultural`, `artista`); o preço de um termo genérico é só o custo de tokens dos candidatos extras.
- **`excluir`**: o edital é descartado antes de chegar à IA se o objeto contiver qualquer uma destas. Serve para cortar o óbvio (`software`, `medicamento`, `pavimentação`) sem gastar tokens.

Regras de comparação:

- Não diferencia maiúsculas nem acentos (`Exposição` = `exposicao`).
- A palavra precisa começar no início de uma palavra do texto e pode continuar por até 3 letras: `curador` encontra `curadores` e `curadoria`, e **não** encontra `procurador`; `arte` encontra `artes`, e **não** encontra `artesanato` nem `arterial`.
- Plurais em `-ções`, `-ais` e `-ões` são reconhecidos (`exposição` encontra `exposições`; `mural` encontra `murais`).
- Expressões com espaço (`galeria de arte`) precisam aparecer inteiras; hífen e espaço são equivalentes (`arte-educação` = `arte educação`).

Salvou no GitHub? Na próxima execução do Action a nova lista é reaplicada a **toda a base**, não só aos editais novos. Registros que deixaram de bater são removidos; os que passaram a bater só entram quando forem recoletados (rode manualmente com `dias` maior, veja abaixo).

Para editar pelo site do GitHub: abra o arquivo, clique no lápis, edite, "Commit changes". Para testar sem esperar o cron: aba **Actions** → *Atualizar dados do PNCP* → **Run workflow**.

## Rodar localmente

Requisito: [Node.js 20](https://nodejs.org) ou mais novo. Nada de `npm install`.

```bash
# só os últimos 2 dias (padrão): cerca de 8 minutos
node scripts/fetch.mjs

# últimos 30 dias: cerca de 2 horas
node scripts/fetch.mjs --dias 30

# 30 dias terminando numa data específica (para montar o histórico em partes)
node scripts/fetch.mjs --dias 30 --ate 2026-09-16

# intervalo maior entre requisições, se a API bloquear com frequência
node scripts/fetch.mjs --intervalo 3000
```

**Por que demora:** a API do PNCP limita requisições por IP. Medido em outubro de 2026: ela aceita um surto de ~6 chamadas, bloqueia (HTTP 429) por ~20 segundos e sustenta 1 chamada a cada 2 segundos. As cinco modalidades somam ~6 mil contratações por dia, ou ~120 páginas de 50 registros, então cada dia de histórico custa ~4 minutos. Paralelismo não ajuda, porque o limite é por IP.

O coletor espera 2 s entre requisições (ajustável com `--intervalo`), e o ritmo é adaptativo: a cada 429 ele pausa 30 s, 60 s, 120 s e aumenta o intervalo em 50%; depois de 40 acertos seguidos volta a reduzir. Erros 5xx e de rede têm retry com backoff (até 4 tentativas). Nenhuma falha aborta a execução inteira: a janela que falhou fica registrada em `meta.json` (campo `erros`) e aparece discretamente na página.

Para ver a página, sirva a pasta `docs` por HTTP (abrir o `index.html` direto do disco não funciona, porque o navegador bloqueia o `fetch` dos JSON):

```bash
npx serve docs
# ou
python -m http.server 8080 --directory docs
```

E abra `http://localhost:3000` (serve) ou `http://localhost:8080` (python).

## Publicar no GitHub

1. Crie o repositório no GitHub e envie o código (`git push`).
2. **Pages**: *Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, pasta `/docs`* → Save. A página fica em `https://<usuario>.github.io/<repositorio>/`.
3. **Permissão de escrita para o Action**: *Settings → Actions → General → Workflow permissions → Read and write permissions* → Save. Sem isso o `git push` do workflow falha.
3b. **Chave da Anthropic** (opcional, mas sem ela tudo fica "não verificado"): *Settings → Secrets and variables → Actions → New repository secret* → nome `ANTHROPIC_API_KEY`.
4. **Primeira carga**: aba *Actions → Atualizar dados do PNCP → Run workflow*. Pelo limite da API, 90 dias de uma vez levariam ~6 h e estourariam o tempo máximo de um job. Rode em três partes de 30 dias (cada uma ≈ 2 h), uma após a outra, informando `dias` = `30` e `ate` = hoje, hoje−30 dias e hoje−60 dias. O cron diário depois roda com 2 dias (≈ 8 min). Se este repositório já veio com `docs/data/*.json` preenchidos, só complete o que faltar.

## Dados gravados por registro

Só o que a página usa, nunca o objeto bruto da API:

`numeroControlePNCP`, `objetoCompra`, `modalidadeId`, `modalidadeNome`, `situacaoCompraNome`, `valorTotalEstimado`, `dataPublicacaoPncp`, `dataAberturaProposta`, `dataEncerramentoProposta`, `dataAtualizacaoGlobal`, `orgao`, `cnpj`, `unidade`, `uf`, `municipio`, `anoCompra`, `sequencialCompra`, `amparoLegal`, `linkSistemaOrigem`, `linkPncp` (`https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}`), `tags` e `ia` (`S`, `N`, `D` ou `pendente`).

## Limitações

- O PNCP cobre **contratações de serviços**. Editais de fomento e prêmios (Lei Paulo Gustavo, PNAB, editais de secretarias de cultura) são publicados em outros canais e não aparecem aqui.
- O filtro é por palavras-chave no objeto da compra. Haverá falsos positivos (ex.: "acervo" bibliográfico) e falsos negativos (objetos genéricos como "contratação de pessoa jurídica"). Ajuste `keywords.json`.
- A base guarda 365 dias. Para histórico maior, altere `RETENCAO_DIAS` em `scripts/fetch.mjs`.
