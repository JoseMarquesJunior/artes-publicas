/**
 * Adaptador PNCP (Portal Nacional de Contratações Públicas).
 * API pública: https://pncp.gov.br/api/consulta/swagger-ui/index.html
 * Endpoint: GET /v1/contratacoes/publicacao (dataInicial/dataFinal AAAAMMDD, codigoModalidadeContratacao,
 * pagina, tamanhoPagina 10..50; resposta com data[], totalPaginas, paginasRestantes).
 *
 * Limite da API (medido em 2026-10): por IP, ~6 requisições de surto, bloqueio de ~20 s, sustenta 1 req/2 s.
 */
import {
  log, hojeUTC, somarDias, fmtISO, fmtAAAAMMDD, criarLimitador, requisitarJson, descreverErro,
  executarEmParalelo, filtrarPorPalavras, registroUnificado, paraDataHoraISO,
} from '../util.mjs';

const API_BASE = 'https://pncp.gov.br/api/consulta/v1';

/** Modalidades varridas (códigos da tabela de domínio do PNCP). */
export const MODALIDADES = [
  { codigo: 3, nome: 'Concurso' },
  { codigo: 8, nome: 'Dispensa de licitação' },
  { codigo: 9, nome: 'Inexigibilidade' },
  { codigo: 12, nome: 'Credenciamento' },
  { codigo: 6, nome: 'Pregão eletrônico' },
];

const TAMANHO_PAGINA = 50;
const JANELA_MAX_DIAS = 30;
export const INTERVALO_PADRAO_MS = 2000;
export const PARALELO_PADRAO = 1;

function janelas(inicio, fim) {
  const lista = [];
  let de = inicio;
  while (de <= fim) {
    const candidato = somarDias(de, JANELA_MAX_DIAS - 1);
    const ate = candidato < fim ? candidato : fim;
    lista.push({ de, ate });
    de = somarDias(ate, 1);
  }
  return lista;
}

/** Muitos órgãos informam o link de origem sem "https://". */
function normalizarLink(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(s)) return `https://${s}`;
  return null;
}

/** Texto usado no filtro por palavras-chave (objeto completo, quando guardado). */
export function textoParaFiltro(registro) {
  return registro.detalhes?.objetoCompleto ?? registro.titulo ?? '';
}

export function filtrar(registro, palavras) {
  return filtrarPorPalavras(textoParaFiltro(registro), palavras);
}

/** Item bruto da API → registro no esquema unificado. */
function projetar(item, tags, coletadoEm) {
  const cnpj = item.orgaoEntidade?.cnpj ?? null;
  const temLink = cnpj && item.anoCompra != null && item.sequencialCompra != null;
  const linkPncp = temLink ? `https://pncp.gov.br/app/editais/${cnpj}/${item.anoCompra}/${item.sequencialCompra}` : null;
  const linkOrigem = normalizarLink(item.linkSistemaOrigem);
  return registroUnificado({
    fonte: 'pncp',
    idNaFonte: item.numeroControlePNCP,
    tipo: 'contratacao',
    titulo: item.objetoCompra ?? '',
    resumo: null,
    orgao: item.orgaoEntidade?.razaoSocial ?? null,
    uf: item.unidadeOrgao?.ufSigla ?? null,
    municipio: item.unidadeOrgao?.municipioNome ?? null,
    abertura: paraDataHoraISO(item.dataAberturaProposta),
    encerramento: paraDataHoraISO(item.dataEncerramentoProposta),
    valor: item.valorTotalEstimado ?? null,
    link: linkPncp ?? linkOrigem ?? `https://pncp.gov.br/app/editais?q=${encodeURIComponent(item.numeroControlePNCP)}`,
    linksExtras: linkPncp && linkOrigem ? [linkOrigem] : [],
    tags,
    coletadoEm,
    publicadoEm: paraDataHoraISO(item.dataPublicacaoPncp),
    detalhes: {
      objetoCompleto: item.objetoCompra ?? '',
      modalidade: item.modalidadeNome ?? null,
      situacao: item.situacaoCompraNome ?? null,
      amparoLegal: item.amparoLegal?.nome ?? null,
      unidade: item.unidadeOrgao?.nomeUnidade ?? null,
      cnpj,
      atualizadoNaFonte: item.dataAtualizacaoGlobal ?? item.dataAtualizacao ?? null,
    },
  });
}

/** Registro do antigo docs/data/contratacoes.json → esquema unificado (migração única). */
export function migrarRegistroAntigo(r) {
  return registroUnificado({
    fonte: 'pncp',
    idNaFonte: r.numeroControlePNCP,
    tipo: 'contratacao',
    titulo: r.objetoCompra ?? '',
    resumo: null,
    orgao: r.orgao ?? null,
    uf: r.uf ?? null,
    municipio: r.municipio ?? null,
    abertura: paraDataHoraISO(r.dataAberturaProposta),
    encerramento: paraDataHoraISO(r.dataEncerramentoProposta),
    valor: r.valorTotalEstimado ?? null,
    link: r.linkPncp ?? r.linkSistemaOrigem ?? `https://pncp.gov.br/app/editais?q=${encodeURIComponent(r.numeroControlePNCP)}`,
    linksExtras: r.linkPncp && r.linkSistemaOrigem ? [r.linkSistemaOrigem] : [],
    tags: r.tags ?? [],
    ia: r.ia,
    categoriaIA: null,
    coletadoEm: r.dataPublicacaoPncp ? `${r.dataPublicacaoPncp}` : new Date().toISOString(),
    publicadoEm: paraDataHoraISO(r.dataPublicacaoPncp),
    detalhes: {
      objetoCompleto: r.objetoCompra ?? '',
      modalidade: r.modalidadeNome ?? null,
      situacao: r.situacaoCompraNome ?? null,
      amparoLegal: r.amparoLegal ?? null,
      unidade: r.unidade ?? null,
      cnpj: r.cnpj ?? null,
      atualizadoNaFonte: r.dataAtualizacaoGlobal ?? null,
    },
  });
}

/** Pagina uma (modalidade × janela) até o fim, filtrando página a página. */
async function coletarTarefa({ modalidade, janela }, { palavras, limitador, contexto, coletadoEm, saida }) {
  const parcial = { lidos: 0, candidatos: 0, paginas: 0 };
  let totalPaginas = null;
  const rotulo = `[PNCP ${modalidade.nome} ${fmtISO(janela.de)}..${fmtISO(janela.ate)}] `;
  for (let pagina = 1; ; pagina++) {
    const url = new URL(`${API_BASE}/contratacoes/publicacao`);
    url.search = new URLSearchParams({
      dataInicial: fmtAAAAMMDD(janela.de),
      dataFinal: fmtAAAAMMDD(janela.ate),
      codigoModalidadeContratacao: String(modalidade.codigo),
      pagina: String(pagina),
      tamanhoPagina: String(TAMANHO_PAGINA),
    }).toString();

    const { corpo } = await requisitarJson(url, { limitador, contexto, rotulo });
    const itens = Array.isArray(corpo?.data) ? corpo.data : [];
    if (itens.length === 0) break;

    parcial.paginas++;
    parcial.lidos += itens.length;
    for (const item of itens) {
      if (!item?.numeroControlePNCP) continue;
      const tags = filtrarPorPalavras(item.objetoCompra, palavras);
      if (!tags) continue;
      parcial.candidatos++;
      saida.set(item.numeroControlePNCP, projetar(item, tags, coletadoEm));
    }

    totalPaginas = corpo.totalPaginas ?? totalPaginas;
    if ((corpo.paginasRestantes ?? 0) <= 0) break;
    if (totalPaginas != null && pagina >= totalPaginas) break;
    if (pagina % 25 === 0) log(`  ${rotulo}página ${pagina}/${totalPaginas ?? '?'} · ${parcial.candidatos} candidatos`);
  }
  return parcial;
}

/**
 * Coleta as contratações publicadas entre (ate - dias) e ate, filtradas pelas palavras-chave.
 * Devolve { registros, stats }. Lança erro só se TODAS as janelas falharem.
 */
export async function coletar({ dias = 2, ate = null, intervalo = INTERVALO_PADRAO_MS, paralelo = PARALELO_PADRAO, palavras }) {
  const fim = ate ?? hojeUTC();
  const inicio = somarDias(fim, -dias);
  const coletadoEm = new Date().toISOString();
  const limitador = criarLimitador({ intervaloMs: intervalo });
  const contexto = { requisicoes: 0 };
  const saida = new Map();
  const erros = [];
  const porModalidade = MODALIDADES.map((m) => ({ ...m, lidos: 0, candidatos: 0, paginas: 0, falhas: 0 }));

  const tarefas = [];
  for (const modalidade of MODALIDADES) for (const janela of janelas(inicio, fim)) tarefas.push({ modalidade, janela });
  log(`[PNCP] período ${fmtISO(inicio)} a ${fmtISO(fim)} · ${tarefas.length} consultas (modalidade × janela) · intervalo ${intervalo} ms`);

  await executarEmParalelo(tarefas, paralelo, async (tarefa) => {
    const stats = porModalidade.find((m) => m.codigo === tarefa.modalidade.codigo);
    const rotulo = `[PNCP ${tarefa.modalidade.nome} ${fmtISO(tarefa.janela.de)}..${fmtISO(tarefa.janela.ate)}]`;
    try {
      const parcial = await coletarTarefa(tarefa, { palavras, limitador, contexto, coletadoEm, saida });
      stats.lidos += parcial.lidos;
      stats.candidatos += parcial.candidatos;
      stats.paginas += parcial.paginas;
      log(`${rotulo} ${parcial.paginas} páginas, ${parcial.lidos} lidos, ${parcial.candidatos} candidatos`);
    } catch (erro) {
      stats.falhas++;
      const mensagem = descreverErro(erro);
      erros.push({ janela: `${tarefa.modalidade.nome} ${fmtISO(tarefa.janela.de)}..${fmtISO(tarefa.janela.ate)}`, mensagem });
      log(`${rotulo} FALHOU: ${mensagem} — seguindo com as demais`);
    }
  });

  if (tarefas.length && erros.length === tarefas.length) {
    throw new Error(`todas as ${tarefas.length} consultas falharam (${erros[0].mensagem})`);
  }

  return {
    registros: [...saida.values()],
    stats: {
      lidos: porModalidade.reduce((s, m) => s + m.lidos, 0),
      candidatos: saida.size,
      requisicoes: contexto.requisicoes,
      bloqueios429: limitador.bloqueios,
      periodo: { de: fmtISO(inicio), ate: fmtISO(fim), dias },
      modalidades: porModalidade,
      erros,
    },
  };
}
