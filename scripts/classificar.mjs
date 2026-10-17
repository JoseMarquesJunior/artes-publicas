/**
 * Classificação por IA (segunda peneira, depois das palavras-chave).
 *
 * O modelo recebe só os itens sem veredito, em lotes, e responde por item [S|N|D, categoria].
 * Sem a variável ANTHROPIC_API_KEY nada é chamado e os itens ficam "pendente". A chave só vive em memória.
 *
 * API: POST https://api.anthropic.com/v1/messages (Messages API, versão 2023-06-01), fetch nativo, sem SDK.
 * Cabeçalhos x-api-key, anthropic-version, content-type. Resposta: content[] (lê-se só os blocos "text"),
 * stop_reason, usage.input_tokens / usage.output_tokens.
 * O claude-haiku-5-5 rejeita (400) temperature diferente do padrão; para resposta estável e barata
 * usa-se thinking desligado e effort "low".
 */
import { ErroHttp, descreverErro, dormir, log, normalizar, truncar } from './util.mjs';

export const IA_MODELO = 'claude-haiku-5-5';
const IA_URL = 'https://api.anthropic.com/v1/messages';
const IA_VERSAO = '2023-06-01';
const IA_LOTE = 30;
const IA_TRUNCAR_TEXTO = 600;
const IA_TOKENS_POR_ITEM = 12;        // ["S","exposicao"] ≈ 9 tokens + folga
const IA_MARGEM_TOKENS = 40;
const IA_MAX_TENTATIVAS = 3;
const IA_INTERVALO_MS = 200;
const IA_TIMEOUT_MS = 60_000;
const IA_PRECO_ENTRADA_USD_POR_MTOK = 0.10; // claude-haiku-5-5, prompts até 100K tokens
const IA_PRECO_SAIDA_USD_POR_MTOK = 0.50;

export const CATEGORIAS = ['curadoria', 'oficina', 'design', 'ilustracao', 'mural', 'restauro', 'exposicao', 'premio', 'residencia', 'fomento-geral', 'producao', 'outro'];

const TIPO_ROTULO = {
  contratacao: 'contratação de serviço',
  fomento: 'edital de fomento',
  premio: 'prêmio',
  residencia: 'residência artística',
  chamamento: 'chamamento público',
  outro: 'outro',
};

const PROMPT_SISTEMA = `Você recebe uma lista numerada de oportunidades públicas brasileiras. Cada item é uma contratação de serviço (PNCP) OU um edital de fomento, prêmio, residência ou chamamento público (Mapas Culturais), com tipo, fonte, local, órgão, título e resumo.

Para cada item, responda à mesma pergunta: uma profissional formada em artes visuais, residente na Grande Belo Horizonte (MG), pode se candidatar, concorrer ou ser contratada nisso? Área de atuação: criação artística, curadoria, exposições, oficinas de arte, ilustração, design gráfico, murais, cenografia, restauro e conservação de obras ou acervos artísticos, arte-educação, mediação cultural, produção cultural.

Regras:
- S = sim. Editais de cultura amplos (todas as linguagens artísticas, multilinguagem) contam como S.
- N = não. Editais exclusivos de música, audiovisual, literatura, dança ou teatro são N. Editais restritos a residentes de outro estado são N. Itens em que a palavra-chave aparece em outro sentido são N (ex.: "exposição a agentes químicos", "acervo bibliográfico", "design de software", "restauração de pavimento", "serigrafia industrial para uniformes", "manutenção do ar-condicionado do museu", show de cantor).
- D = dúvida, quando o texto é vago demais para decidir.

Dê também uma categoria curta por item, uma destas palavras: curadoria, oficina, design, ilustracao, mural, restauro, exposicao, premio, residencia, fomento-geral, producao, outro. Para N, use "".

Responda apenas com um JSON em uma única linha, mapeando o número de cada item para [letra, categoria], por exemplo {"1":["S","exposicao"],"2":["N",""],"3":["D","fomento-geral"]}. Inclua todos os números. Sem explicações, sem texto fora do JSON.`;

function descreverItem(r, i) {
  const local = [r.municipio, r.uf].filter(Boolean).join('/') || (r.uf === null ? 'abrangência nacional' : 'local não informado');
  const fonte = r.detalhes?.fonteNome ?? (r.fonte === 'pncp' ? 'PNCP' : r.fonte);
  const texto = truncar([r.titulo, r.resumo].filter(Boolean).join('. '), IA_TRUNCAR_TEXTO);
  const areas = r.detalhes?.areas?.length ? ` Áreas: ${r.detalhes.areas.slice(0, 4).join(', ')}.` : '';
  return `${i + 1}. [${TIPO_ROTULO[r.tipo] ?? r.tipo}; ${fonte}; ${local}] ${r.orgao ?? 'órgão não informado'}: ${texto}${areas}`;
}

function extrairJson(texto) {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const valor = JSON.parse(texto.slice(ini, fim + 1));
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

/** Aceita ["S","exposicao"], "S" ou {"veredito":"S","categoria":"x"}. */
function interpretarResposta(valor) {
  let letra = '';
  let categoria = '';
  if (Array.isArray(valor)) [letra, categoria] = valor;
  else if (typeof valor === 'string') letra = valor;
  else if (valor && typeof valor === 'object') { letra = valor.veredito ?? valor.v ?? ''; categoria = valor.categoria ?? valor.c ?? ''; }
  letra = String(letra ?? '').trim().toUpperCase();
  if (!['S', 'N', 'D'].includes(letra)) return null;
  let cat = normalizar(categoria).replace(/\s+/g, '-');
  if (!CATEGORIAS.includes(cat)) cat = letra === 'N' ? '' : (cat ? 'outro' : '');
  return { veredito: letra, categoria: letra === 'N' ? null : (cat || null) };
}

async function chamarModelo(chave, lote, ia) {
  const corpo = {
    model: IA_MODELO,
    max_tokens: lote.length * IA_TOKENS_POR_ITEM + IA_MARGEM_TOKENS,
    system: PROMPT_SISTEMA,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: lote.map(descreverItem).join('\n') }],
  };
  for (let tentativa = 1; ; tentativa++) {
    ia.requisicoes++;
    try {
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS),
      });
      if (!res.ok) throw new ErroHttp(res.status, IA_URL, await res.text().catch(() => ''), res.headers.get('retry-after'));
      return await res.json();
    } catch (erro) {
      const retentavel = erro instanceof ErroHttp ? erro.retentavel : true;
      if (!retentavel || tentativa >= IA_MAX_TENTATIVAS) throw erro;
      const espera = (erro instanceof ErroHttp && erro.retryAfterMs) || 2000 * 2 ** (tentativa - 1); // 2 s, 4 s
      log(`  IA: ${descreverErro(erro)} — tentativa ${tentativa}/${IA_MAX_TENTATIVAS}, nova tentativa em ${Math.round(espera / 1000)} s`);
      await dormir(espera);
    }
  }
}

/**
 * Preenche `ia` e `categoriaIA` nos itens da lista que ainda não têm veredito.
 * Devolve estatísticas para o meta.json (tokens, custo, contagens).
 */
export async function classificar(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const ia = {
    modelo: IA_MODELO,
    ativo: Boolean(chave),
    classificados: 0, aprovados: 0, reprovados: 0, duvidas: 0, pendentes: 0,
    lotes: 0, lotesFalhos: 0, requisicoes: 0,
    tokensEntrada: 0, tokensSaida: 0, custoUsd: 0,
    porTipo: {},
  };
  const fila = lista.filter((r) => !['S', 'N', 'D'].includes(r.ia));

  if (!chave) {
    for (const r of fila) r.ia = 'pendente';
    ia.pendentes = fila.length;
    if (fila.length) log(`IA: ANTHROPIC_API_KEY não definida; ${fila.length} itens ficam como "pendente".`);
    return ia;
  }
  if (fila.length === 0) {
    log('IA: nenhum item novo para classificar.');
    return ia;
  }

  log(`IA: ${fila.length} itens a classificar com ${IA_MODELO}, em lotes de ${IA_LOTE}.`);
  for (let i = 0; i < fila.length; i += IA_LOTE) {
    const lote = fila.slice(i, i + IA_LOTE);
    ia.lotes++;
    let respostas = null;
    try {
      const resposta = await chamarModelo(chave, lote, ia);
      ia.tokensEntrada += resposta.usage?.input_tokens ?? 0;
      ia.tokensSaida += resposta.usage?.output_tokens ?? 0;
      if (resposta.stop_reason === 'refusal') {
        log('  IA: lote recusado pelo modelo (stop_reason refusal); itens ficam pendentes');
      } else {
        const texto = (resposta.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        respostas = extrairJson(texto);
        if (!respostas) log(`  IA: resposta sem JSON válido (stop_reason ${resposta.stop_reason}); itens do lote ficam pendentes`);
        else if (resposta.stop_reason === 'max_tokens') log('  IA: resposta cortada por max_tokens; itens faltantes ficam pendentes');
      }
    } catch (erro) {
      ia.lotesFalhos++;
      log(`  IA: lote ${ia.lotes} falhou de vez (${descreverErro(erro)}); itens ficam pendentes`);
    }

    lote.forEach((r, idx) => {
      const resultado = respostas ? interpretarResposta(respostas[String(idx + 1)]) : null;
      if (resultado) {
        r.ia = resultado.veredito;
        r.categoriaIA = resultado.categoria;
        ia.classificados++;
        if (r.ia === 'S') ia.aprovados++;
        else if (r.ia === 'N') ia.reprovados++;
        else ia.duvidas++;
        const t = (ia.porTipo[r.tipo] ??= { S: 0, N: 0, D: 0 });
        t[r.ia]++;
      } else {
        r.ia = 'pendente';
        ia.pendentes++;
      }
    });

    if (ia.lotes % 10 === 0) log(`  IA: ${Math.min(i + IA_LOTE, fila.length)}/${fila.length} itens processados`);
    if (i + IA_LOTE < fila.length) await dormir(IA_INTERVALO_MS);
  }

  ia.custoUsd = Number(((ia.tokensEntrada * IA_PRECO_ENTRADA_USD_POR_MTOK + ia.tokensSaida * IA_PRECO_SAIDA_USD_POR_MTOK) / 1e6).toFixed(4));
  return ia;
}
