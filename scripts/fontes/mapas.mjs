/**
 * Adaptador Mapas Culturais (software livre do MinC usado por instâncias nacional, estaduais e municipais).
 * Todas expõem a mesma API REST pública, sem autenticação:
 *   GET {base}/api/opportunity/find?@select=...&@order=...&@limit=50&@page=N&campo=OPERADOR(valor)
 * Sintaxe confirmada ao vivo em 2026-10-17 (mapaculturalbh.pbh.gov.br):
 *   - @select aceita subcampos com ponto: owner.name, ownerEntity.name;
 *   - filtros: registrationTo=GTE(2026-10-10), id=EQ(10), name=LIKE(*texto*), BET, AND, OR, !;
 *   - datas vêm como {"date":"2026-10-25 17:00:00.000000","timezone":"America/Sao_Paulo"};
 *   - fluxo contínuo usa registrationTo 2111-01-01 (placeholder) e isContinuousFlow=true;
 *   - oportunidades com `parent` são fases de outra (recurso, documentação complementar): não são aberturas;
 *   - o cabeçalho API-Metadata traz {"count","page","limit","numPages"};
 *   - algumas instâncias bloqueiam User-Agent de robô (403); envia-se um User-Agent de navegador.
 */
import {
  log, dormir, hojeUTC, somarDias, fmtISO, requisitarJson, UA_NAVEGADOR, normalizar,
  filtrarPorPalavras, registroUnificado, inferirTipoFomento, paraDataISO, paraDataHoraISO, truncar,
} from '../util.mjs';

const CAMPOS = [
  'id', 'name', 'shortDescription', 'registrationFrom', 'registrationTo', 'createTimestamp', 'publishTimestamp',
  'status', 'singleUrl', 'projectName', 'isContinuousFlow', 'terms', 'parent', 'isOpportunityPhase',
  'owner.name', 'owner.En_Estado', 'owner.En_Municipio', 'ownerEntity.name',
].join(',');
const LIMITE_PAGINA = 50;
export const INTERVALO_MS = 500;
export const DIAS_ATRAS_PADRAO = 7; // pega também o que fechou há pouco, para não perder nada por atraso de coleta

const AREA_ARTES_VISUAIS = /artes? visua|artes? plastic|artes? integrad|fotografia|design|artesanato|patrimonio/i;

/**
 * Fases de um edital (avaliação, recurso, documentação complementar) aparecem como oportunidades próprias
 * e, nestas instâncias, sem `parent` nem `isOpportunityPhase` na API pública. Reconhece-as pelo nome.
 */
const PADRAO_FASE = /^(?:\d+[ªa°º]?\s*)?fase\b|^etapa\b|documentacao (?:complementar|corrigida)|fase de recurso|^recurso\b|avaliacao preliminar|habilitacao documental|^resultado\b/;
function ehFase(item) {
  return Boolean(item.parent) || item.isOpportunityPhase === true || PADRAO_FASE.test(normalizar(item.name));
}

/** Tag extra quando a própria fonte classifica a oportunidade numa área de artes visuais. */
function extrasDeAreas(areas) {
  return Array.isArray(areas) && areas.some((a) => AREA_ARTES_VISUAIS.test(String(a).normalize('NFD').replace(/[̀-ͯ]/g, '')))
    ? ['área: artes visuais']
    : [];
}

/** Texto do filtro por palavras-chave: título + resumo. "cultura"/"cultural" já estão em keywords.json, o que torna o filtro generoso aqui. */
export function textoParaFiltro(registro) {
  return `${registro.titulo ?? ''} ${registro.resumo ?? ''}`;
}

export function filtrar(registro, palavras) {
  return filtrarPorPalavras(textoParaFiltro(registro), palavras, extrasDeAreas(registro.detalhes?.areas));
}

/** 1–2 frases, até 280 caracteres. */
function resumir(texto) {
  const limpo = String(texto ?? '').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const frases = limpo.split(/(?<=[.!?])\s+/);
  let saida = '';
  for (const f of frases.slice(0, 2)) {
    if ((saida + f).length > 280) break;
    saida = saida ? `${saida} ${f}` : f;
  }
  return saida || truncar(limpo, 280);
}

function projetar(item, instancia, tags, coletadoEm) {
  const base = instancia.base.replace(/\/+$/, '');
  const continuo = item.isContinuousFlow === true;
  const encerramento = continuo ? null : paraDataHoraISO(item.registrationTo);
  return registroUnificado({
    fonte: instancia.fonte,
    idNaFonte: item.id,
    tipo: inferirTipoFomento(`${item.name ?? ''} ${item.shortDescription ?? ''}`),
    titulo: item.name ?? '',
    resumo: resumir(item.shortDescription),
    orgao: item.owner?.name?.replace(/\s+/g, ' ').trim() || null,
    uf: instancia.uf ?? item.owner?.En_Estado ?? null,
    municipio: instancia.municipio ?? item.owner?.En_Municipio ?? null,
    abertura: paraDataISO(item.registrationFrom),
    encerramento,
    valor: null,
    link: item.singleUrl || `${base}/oportunidade/${item.id}/`,
    linksExtras: [],
    tags,
    coletadoEm,
    publicadoEm: paraDataHoraISO(item.publishTimestamp) ?? paraDataHoraISO(item.createTimestamp) ?? paraDataISO(item.registrationFrom),
    detalhes: {
      areas: Array.isArray(item.terms?.area) ? item.terms.area : [],
      projeto: typeof item.ownerEntity?.name === 'string' ? item.ownerEntity.name : (typeof item.projectName === 'string' ? item.projectName : null),
      instancia: base,
      fluxoContinuo: continuo,
      fonteNome: instancia.nome ?? instancia.fonte,
    },
  });
}

/**
 * Coleta as oportunidades de uma instância com fim das inscrições a partir de (hoje - diasAtras).
 * Devolve { registros, stats }. Lança erro se a instância não responder.
 */
export async function coletar({ instancia, palavras, diasAtras = DIAS_ATRAS_PADRAO, intervaloMs = INTERVALO_MS }) {
  const base = instancia.base.replace(/\/+$/, '');
  const desde = fmtISO(somarDias(hojeUTC(), -diasAtras));
  const coletadoEm = new Date().toISOString();
  const contexto = { requisicoes: 0 };
  const stats = { lidos: 0, fases: 0, candidatos: 0, paginas: 0, requisicoes: 0 };
  const saida = new Map();
  const rotulo = `[${instancia.fonte}] `;
  let numPages = null;

  log(`${rotulo}${base} · inscrições encerrando a partir de ${desde}`);
  for (let pagina = 1; ; pagina++) {
    const url = new URL(`${base}/api/opportunity/find`);
    url.search = new URLSearchParams({
      '@select': CAMPOS,
      registrationTo: `GTE(${desde})`,
      '@order': 'registrationTo ASC',
      '@limit': String(LIMITE_PAGINA),
      '@page': String(pagina),
    }).toString();

    const { corpo, headers } = await requisitarJson(url, {
      headers: { 'User-Agent': UA_NAVEGADOR },
      contexto,
      rotulo,
      maxTentativas: 3,
      espera429Ms: 5000,
    });
    if (!Array.isArray(corpo)) throw new Error(`resposta inesperada (não é lista): ${JSON.stringify(corpo).slice(0, 120)}`);

    try { numPages = JSON.parse(headers.get('api-metadata') ?? 'null')?.numPages ?? numPages; } catch { /* sem metadados */ }
    stats.paginas++;
    stats.lidos += corpo.length;

    for (const item of corpo) {
      if (item?.id == null) continue;
      if (ehFase(item)) { stats.fases++; continue; }          // fase de outra oportunidade, não é abertura
      if (item.status != null && item.status !== 1) continue; // só publicadas
      const registro = projetar(item, instancia, [], coletadoEm);
      const tags = filtrar(registro, palavras);
      if (!tags) continue;
      registro.tags = tags;
      stats.candidatos++;
      saida.set(registro.id, registro);
    }

    if (corpo.length < LIMITE_PAGINA) break;
    if (numPages != null && pagina >= numPages) break;
    await dormir(intervaloMs);
  }

  stats.requisicoes = contexto.requisicoes;
  log(`${rotulo}${stats.lidos} oportunidades lidas (${stats.fases} fases ignoradas), ${stats.candidatos} candidatas`);
  return { registros: [...saida.values()], stats };
}
