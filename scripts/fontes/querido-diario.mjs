/**
 * Adaptador Querido Diário (Open Knowledge Brasil): busca textual em diários oficiais municipais.
 * API pública, sem autenticação. Documentação: https://api.queridodiario.org.br/docs
 * (queridodiario.ok.org.br/api redireciona para api.queridodiario.org.br).
 *
 * Confirmado ao vivo em 2026-10-17:
 *   GET /gazettes?territory_ids=3118601&querystring=...&published_since=AAAA-MM-DD&published_until=AAAA-MM-DD
 *       &size=50&offset=0&excerpt_size=500&number_of_excerpts=3&sort_by=descending_date
 *   → { total_gazettes, gazettes: [{ territory_id, territory_name, state_code, date, scraped_at, url (PDF),
 *       txt_url, excerpts: [string], edition, is_extra_edition }] }
 *   GET /cities/{ibge} → { city: { territory_id, territory_name, level, availability_date, publication_urls } }
 *
 * Cada TRECHO (excerpt) de um diário vira um registro bruto próprio, para o extrator por IA julgar cada ato
 * administrativo isoladamente (uma edição mistura dezenas de atos). O id na fonte é
 * `${ibge}:${date}:${hash do url do PDF}:${hash do texto do trecho}`, estável entre execuções.
 * Trechos sem nenhum termo cultural são descartados antes da IA (consultas com palavras soltas casam
 * "edital" em concursos públicos). Título, prazo e valor NÃO são extraídos aqui: isso é trabalho do extrator
 * (scripts/classificar.mjs), que depois funde trechos do mesmo edital.
 */
import { log, dormir, hojeUTC, somarDias, fmtISO, requisitarJson, hashCurto, registroUnificado, normalizar } from '../util.mjs';

export const INTERVALO_MS = 1000;      // 1 s entre requisições
const FALHAS_SEGUIDAS_PARA_DESISTIR = 3; // disjuntor: a API cai com frequência; depois de 3 consultas seguidas falhando, desiste nesta execução
const TAMANHO_PAGINA = 50;
const MAX_POR_CONSULTA = 300;          // teto de diários por (território × consulta)
const EXCERPT_SIZE = 500;
const NUMERO_EXCERPTS = 3;
const TRECHO_MINIMO = 80;              // caracteres; abaixo disso não há o que extrair
export const LIMITE_TEXTO_BRUTO = 3000;

/** Registros do Querido Diário não passam por palavras-chave: as consultas já selecionam, e a IA extrai. */
export function filtrar(registro) {
  return registro.tags ?? [];
}

function montarUrl(base, { ibge, consulta, desde, ate, offset }) {
  const url = new URL(`${base.replace(/\/+$/, '')}/gazettes`);
  url.search = new URLSearchParams({
    territory_ids: ibge,
    querystring: consulta,
    published_since: desde,
    published_until: ate,
    size: String(TAMANHO_PAGINA),
    offset: String(offset),
    excerpt_size: String(EXCERPT_SIZE),
    number_of_excerpts: String(NUMERO_EXCERPTS),
    sort_by: 'descending_date',
  }).toString();
  return url;
}

function limparTrecho(t) {
  return String(t ?? '').replace(/\s+/g, ' ').replace(/- (?=\p{Ll})/gu, '').trim();
}

const TERMOS_CULTURAIS = /\b(cultur\w*|art(?:e|es|ista|istas|istic\w*)|fomento|premi\w*|aldir blanc|paulo gustavo|chamamento|credenciamento|exposic\w*|oficina\w*|patrimonio|museu|audiovisual|artesan\w*)\b/g;
function pontuacaoCultural(trecho) {
  const t = trecho.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return (t.match(TERMOS_CULTURAIS) ?? []).length;
}

/**
 * Coleta os diários dos territórios cobertos, publicados nos últimos `dias` dias, para cada consulta.
 * `jaProcessados` é um Set de idNaFonte já presentes na base ou já descartados: são pulados.
 * Devolve { registros, stats }.
 */
export async function coletar({ instancia, dias = 2, jaProcessados = new Set() }) {
  const base = instancia.base ?? 'https://api.queridodiario.org.br';
  const hoje = hojeUTC();
  const desde = fmtISO(somarDias(hoje, -dias));
  const ate = fmtISO(hoje);
  const coletadoEm = new Date().toISOString();
  const contexto = { requisicoes: 0 };
  const territorios = (instancia.territorios ?? []).filter((t) => t.coberta !== false);
  const consultas = instancia.consultas ?? [];
  const porTerritorio = territorios.map((t) => ({ nome: t.nome, ibge: t.ibge, regiao: t.regiao, diarios: 0, trechos: 0, novos: 0, pulados: 0, semTermos: 0, erros: 0 }));
  const trechos = new Map(); // idNaFonte do trecho → registro em construção
  const erros = [];

  log(`[querido-diario] ${territorios.length} territórios cobertos × ${consultas.length} consultas · ${desde} a ${ate}`);
  let falhasSeguidas = 0;
  let desistiu = false;

  for (const territorio of territorios) {
    if (desistiu) break;
    const stat = porTerritorio.find((s) => s.ibge === territorio.ibge);
    const edicoesVistas = new Set();
    const trechosVistos = new Set();
    for (const consulta of consultas) {
      if (desistiu) break;
      let offset = 0;
      let total = null;
      try {
        while (true) {
          // A API cai com frequência (503/520/timeout): 3 tentativas com 10 s e 20 s de espera, timeout de 45 s.
          const { corpo } = await requisitarJson(montarUrl(base, { ibge: territorio.ibge, consulta, desde, ate, offset }), {
            contexto, rotulo: `[querido-diario ${territorio.nome}] `, maxTentativas: 3, espera429Ms: 10_000, esperaErroMs: 10_000, timeoutMs: 45_000,
          });
          falhasSeguidas = 0;
          const lista = Array.isArray(corpo?.gazettes) ? corpo.gazettes : [];
          total = corpo?.total_gazettes ?? total ?? 0;

          for (const g of lista) {
            if (!g?.url || !g?.date) continue;
            const idEdicao = `${territorio.ibge}:${g.date}:${hashCurto(g.url)}`;
            if (!edicoesVistas.has(idEdicao)) { edicoesVistas.add(idEdicao); stat.diarios++; }
            for (const t of g.excerpts ?? []) {
              const limpo = limparTrecho(t);
              if (limpo.length < TRECHO_MINIMO) continue;
              const idNaFonte = `${idEdicao}:${hashCurto(normalizar(limpo))}`;
              if (trechosVistos.has(idNaFonte)) { trechos.get(idNaFonte)?.consultas.add(consulta); continue; }
              trechosVistos.add(idNaFonte);
              stat.trechos++;
              if (jaProcessados.has(idNaFonte)) { stat.pulados++; continue; }
              if (pontuacaoCultural(limpo) === 0) { stat.semTermos++; continue; }
              trechos.set(idNaFonte, {
                idNaFonte, data: g.date, url: g.url, txtUrl: g.txt_url ?? null, edicao: g.edition ?? null,
                extra: Boolean(g.is_extra_edition), municipio: territorio.nome, regiao: territorio.regiao ?? null,
                ibge: territorio.ibge, texto: limpo, consultas: new Set([consulta]),
              });
              stat.novos++;
            }
          }

          offset += lista.length;
          if (lista.length < TAMANHO_PAGINA || offset >= total || offset >= MAX_POR_CONSULTA) break;
          await dormir(INTERVALO_MS);
        }
      } catch (erro) {
        stat.erros++;
        falhasSeguidas++;
        erros.push({ janela: `${territorio.nome} · "${consulta}"`, mensagem: erro?.message ?? String(erro) });
        log(`  [querido-diario ${territorio.nome}] consulta "${consulta}" falhou: ${erro?.message ?? erro} — seguindo`);
        if (falhasSeguidas >= FALHAS_SEGUIDAS_PARA_DESISTIR) {
          desistiu = true;
          erros.push({ janela: 'disjuntor', mensagem: `API fora do ar: ${falhasSeguidas} consultas seguidas falharam; fonte abandonada nesta execução` });
          log(`[querido-diario] API fora do ar (${falhasSeguidas} consultas seguidas falharam); desistindo nesta execução`);
        }
      }
      await dormir(INTERVALO_MS);
    }
    log(`[querido-diario ${territorio.nome}] ${stat.diarios} diários, ${stat.trechos} trechos distintos: ${stat.novos} novos para a IA, ${stat.pulados} já processados, ${stat.semTermos} sem termos culturais`);
  }

  const registros = [...trechos.values()].map((d) => {
    const texto = d.texto.slice(0, LIMITE_TEXTO_BRUTO);
    return registroUnificado({
      fonte: 'querido-diario',
      idNaFonte: d.idNaFonte,
      tipo: 'outro',
      titulo: `Diário Oficial de ${d.municipio} · ${d.data}${d.edicao ? ` · edição ${d.edicao}` : ''} · trecho`,
      resumo: null,
      orgao: null,
      uf: 'MG',
      municipio: d.municipio,
      abertura: null,
      encerramento: null,
      valor: null,
      link: d.url,
      linksExtras: d.txtUrl ? [d.txtUrl] : [],
      tags: [...d.consultas].map((c) => `consulta: ${c}`),
      coletadoEm,
      publicadoEm: d.data,
      detalhes: {
        fonteNome: `Diário Oficial de ${d.municipio}`,
        regiao: d.regiao,
        ibge: d.ibge,
        edicao: d.edicao,
        edicaoExtra: d.extra,
        textoUrl: d.txtUrl, // texto integral da edição; usado para procurar o prazo quando o trecho não o traz
        textoBruto: texto, // removido pelo extrator depois de processado
      },
    });
  });

  if (territorios.length && consultas.length && erros.length === territorios.length * consultas.length) {
    throw new Error(`todas as consultas falharam (${erros[0].mensagem})`);
  }
  return {
    registros,
    stats: {
      lidos: porTerritorio.reduce((s, t) => s + t.trechos, 0),
      diarios: porTerritorio.reduce((s, t) => s + t.diarios, 0),
      candidatos: registros.length,
      requisicoes: contexto.requisicoes,
      periodo: { de: desde, ate, dias },
      territorios: porTerritorio,
      naoCobertos: (instancia.territorios ?? []).filter((t) => t.coberta === false).map((t) => t.nome),
      erros,
    },
  };
}
