Adicione uma etapa de classificação por IA ao coletor (scripts/fetch.mjs), usando a API da Anthropic com o modelo claude-haiku-5-5, com o objetivo de eliminar falsos positivos do filtro de palavras-chave gastando o mínimo possível.

## Regras de custo (obrigatórias)

- Só vão para o modelo os itens que passaram pelo filtro de palavras-chave E que ainda não têm o campo "ia" preenchido no docs/data/contratacoes.json. Nunca reclassifique um item já avaliado.
- Agrupe os itens em lotes de até 30 por requisição. Em cada lote, envie uma lista numerada contendo apenas: número, objetoCompra (truncado em 600 caracteres), nome do órgão e modalidade. Nada mais.
- Peça resposta mínima: um JSON de uma linha mapeando o número do item para "S" (sim, é contratação na área de artes visuais ou cultura visual), "N" (não) ou "D" (dúvida). Use max_tokens baixo (calcule ~8 tokens por item do lote mais uma margem). Sem explicações.
- Use temperature 0.
- Chame a API com fetch nativo (POST https://api.anthropic.com/v1/messages, headers x-api-key, anthropic-version e content-type). Sem SDK, sem pacotes npm. Confirme o formato atual da requisição e da resposta na documentação em https://platform.claude.com/docs/en/api/messages antes de escrever.
- A chave vem da variável de ambiente ANTHROPIC_API_KEY. Se ela não estiver definida, o script continua funcionando normalmente, só pula a classificação e marca os itens como "ia": "pendente". No workflow, passe a chave via secrets.ANTHROPIC_API_KEY. A chave nunca pode chegar à pasta docs/.

## Prompt de sistema para o classificador

Escreva um prompt de sistema curto (menos de 200 palavras) explicando que o modelo vai receber objetos de contratações públicas brasileiras e deve dizer se cada um é uma oportunidade real para uma profissional formada em artes visuais: criação artística, curadoria, exposições, oficinas de arte, ilustração, design gráfico, murais, cenografia, restauro e conservação de obras ou acervos artísticos, arte-educação, mediação cultural, produção cultural. Dê 4 ou 5 exemplos de falsos positivos que devem receber "N": "exposição a agentes químicos", "acervo bibliográfico", "design de software", "restauração de pavimento", "serigrafia industrial para uniformes". Instrua a usar "D" quando o objeto for vago demais.

## Tratamento de erros

- Em 429 ou 5xx, retry com backoff exponencial, até 3 tentativas. Se o lote falhar de vez, marque os itens dele como "ia": "pendente" e siga para o próximo lote; eles serão reavaliados na próxima execução.
- Se a resposta não for um JSON válido ou vier com números faltando, marque os faltantes como "pendente".
- Registre no meta.json: quantos itens foram classificados nesta execução, quantos tokens de entrada e saída foram usados (vêm no campo "usage" da resposta) e uma estimativa de custo em dólares.

## Página

- Por padrão, a página mostra só itens com "ia": "S". Um controle discreto "Mostrar também os em dúvida" inclui os "D". Os "N" ficam no JSON mas nunca aparecem (ou, se o arquivo crescer demais, descarte os "N" com mais de 30 dias).
- Itens "pendente" aparecem com um selo "não verificado".

## Palavras-chave

Agora que a IA filtra os falsos positivos, amplie a lista "incluir" do keywords.json com termos mais genéricos: arte, artística, artístico, artista, cultural, cultura, patrimônio histórico, criativa. Mantenha a lista "excluir" para cortar o óbvio antes de gastar tokens.

## Entrega

Rode o coletor com --dias 30 e me mostre: quantos itens passaram pelo regex, quantos o modelo aprovou, quantos reprovou, e o custo estimado da execução. Depois me mostre 10 exemplos de itens que o regex aprovou e o modelo reprovou, para eu avaliar se a classificação está boa.