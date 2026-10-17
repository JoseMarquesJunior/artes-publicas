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
 * Cada diário (uma edição) vira UM registro bruto com os trechos que casaram em qualquer consulta, concatenados.
 * O id na fonte é `${ibge}:${date}:${hash do url do PDF}`: estável entre execuções (o hash dos trechos mudaria
 * conforme as consultas, e geraria duplicatas). Título, prazo e valor NÃO são extraídos aqui: isso é trabalho
 * do extrator por IA (scripts/classificar.mjs).
 */
import { log, dormir, hojeUTC, somarDias, fmtISO, requisitarJson, hashCurto, registroUnificado } from '../util.mjs';

export const INTERVALO_MS = 1000;      // 1 s entre requisições
const TAMANHO_PAGINA = 50;
const MAX_POR_CONSULTA = 300;          // teto de diários por (território × consulta)
const EXCERPT_SIZE = 500;
const NUMERO_EXCERPTS = 3;
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
  const porTerritorio = territorios.map((t) => ({ nome: t.nome, ibge: t.ibge, regiao: t.regiao, diarios: 0, novos: 0, pulados: 0, erros: 0 }));
  const diarios = new Map(); // idNaFonte → registro em construção
  const erros = [];

  log(`[querido-diario] ${territorios.length} territórios cobertos × ${consultas.length} consultas · ${desde} a ${ate}`);

  for (const territorio of territorios) {
    const stat = porTerritorio.find((s) => s.ibge === territorio.ibge);
    const vistosNoTerritorio = new Set();
    for (const consulta of consultas) {
      let offset = 0;
      let total = null;
      try {
        while (true) {
          const { corpo } = await requisitarJson(montarUrl(base, { ibge: territorio.ibge, consulta, desde, ate, offset }), {
            contexto, rotulo: `[querido-diario ${territorio.nome}] `, maxTentativas: 3, espera429Ms: 10_000,
          });
          const lista = Array.isArray(corpo?.gazettes) ? corpo.gazettes : [];
          total = corpo?.total_gazettes ?? total ?? 0;

          for (const g of lista) {
            if (!g?.url || !g?.date) continue;
            const idNaFonte = `${territorio.ibge}:${g.date}:${hashCurto(g.url)}`;
            if (!vistosNoTerritorio.has(idNaFonte)) { vistosNoTerritorio.add(idNaFonte); stat.diarios++; }
            if (jaProcessados.has(idNaFonte)) { stat.pulados++; continue; }
            let reg = diarios.get(idNaFonte);
            if (!reg) {
              reg = {
                idNaFonte, data: g.date, url: g.url, txtUrl: g.txt_url ?? null, edicao: g.edition ?? null,
                extra: Boolean(g.is_extra_edition), municipio: territorio.nome, regiao: territorio.regiao ?? null,
                ibge: territorio.ibge, trechos: new Set(), consultas: new Set(),
              };
              diarios.set(idNaFonte, reg);
              stat.novos++;
            }
            reg.consultas.add(consulta);
            for (const t of g.excerpts ?? []) { const limpo = limparTrecho(t); if (limpo) reg.trechos.add(limpo); }
          }

          offset += lista.length;
          if (lista.length < TAMANHO_PAGINA || offset >= total || offset >= MAX_POR_CONSULTA) break;
          await dormir(INTERVALO_MS);
        }
      } catch (erro) {
        stat.erros++;
        erros.push({ janela: `${territorio.nome} · "${consulta}"`, mensagem: erro?.message ?? String(erro) });
        log(`  [querido-diario ${territorio.nome}] consulta "${consulta}" falhou: ${erro?.message ?? erro} — seguindo`);
      }
      await dormir(INTERVALO_MS);
    }
    log(`[querido-diario ${territorio.nome}] ${stat.diarios} diários com ocorrências, ${stat.novos} novos, ${stat.pulados} já processados`);
  }

  const registros = [...diarios.values()].map((d) => {
    // Consultas com palavras soltas casam qualquer uma delas ("edital" sozinho casa concursos públicos),
    // então os trechos mais ligados a cultura vêm primeiro e são os que sobrevivem ao corte de tamanho.
    const ordenados = [...d.trechos].sort((a, b) => pontuacaoCultural(b) - pontuacaoCultural(a));
    let texto = '';
    for (const t of ordenados) {
      if (texto.length >= LIMITE_TEXTO_BRUTO) break;
      texto = texto ? `${texto} […] ${t}` : t;
    }
    texto = texto.slice(0, LIMITE_TEXTO_BRUTO);
    return registroUnificado({
      fonte: 'querido-diario',
      idNaFonte: d.idNaFonte,
      tipo: 'outro',
      titulo: `Diário Oficial de ${d.municipio} · ${d.data}${d.edicao ? ` · edição ${d.edicao}` : ''}`,
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
      lidos: porTerritorio.reduce((s, t) => s + t.diarios, 0),
      candidatos: registros.length,
      requisicoes: contexto.requisicoes,
      periodo: { de: desde, ate, dias },
      territorios: porTerritorio,
      naoCobertos: (instancia.territorios ?? []).filter((t) => t.coberta === false).map((t) => t.nome),
      erros,
    },
  };
}
