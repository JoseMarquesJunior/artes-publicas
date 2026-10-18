/**
 * Adaptador do Diário Oficial do Município de Belo Horizonte (DOM-BH), direto da API da Prodabel.
 * O site dom-web.pbh.gov.br é uma SPA; a API pública (sem token) fica em https://api-dom.pbh.gov.br/api/v1
 * (endereço lido de https://dom-web.pbh.gov.br/env.json). Caminho usado, confirmado em 2026-10-18:
 *   GET /edicoes/buscarpublicacaopordata?data=AAAA-MM-DD → { data: [{ id, numero_edicao, tipo_edicao, dt_publicacao }] }
 *   GET /edicoes/{id}/sumario → árvore de órgãos; cada ato tem { id, descricao, categoria.nome_categoria,
 *                               orgao.{sigla_orgao, nome_orgao}, documento_ato }
 *   GET /edicoes/atos/{id}/publicado → { data: { titulo_ato, conteudo_html, edicao_id, orgao_id } }
 * (a pesquisa textual /edicoes/atos/pesquisar devolve 500 para clientes anônimos; por isso varre-se o sumário).
 *
 * Cada ato selecionado vira um registro bruto com detalhes.textoBruto; a IA extrai relevância, tipo, resumo,
 * prazo e valor (modo extrator), como no Querido Diário.
 */
import { log, dormir, hojeUTC, somarDias, fmtISO, requisitarJson, UA_NAVEGADOR, normalizar, filtrarPorPalavras, registroUnificado, inferirTipoFomento, truncar, descreverErro } from '../util.mjs';

export const INTERVALO_MS = 700;
const LIMITE_TEXTO = 3000;
const MAX_ATOS_POR_EXECUCAO = 120;

/** Órgãos cujos atos entram sempre (cultura, museus, turismo cultural), mesmo sem palavra-chave no título. */
const ORGAOS_CULTURA = /cultura|museu|fundacao municipal de cultura|\bfmc\b|\bsmc\b|belotur|arquivo publico/;
/** Órgãos cujos atos nunca interessam (o CDPCM publica editais de notificação de tombamento, não oportunidades). */
const ORGAOS_IGNORAR = /\bcdpcm\b|conselho deliberativo do patrimonio/;
/** Categorias/títulos que nunca interessam. */
const TITULO_IGNORAR = /^(portaria|decreto|extrato|ata |nomea|exonera|designa|homolog|resultado|errata|comunicado$|convoca|promocao|retifica)|eliminacao de documentos|ciencia de eliminacao|medida compensatoria/;

const CABECALHOS = { 'User-Agent': UA_NAVEGADOR, Origin: 'https://dom-web.pbh.gov.br', Referer: 'https://dom-web.pbh.gov.br/' };

/** Reaplicação do filtro à base existente: só "excluir" (o ato já passou pela seleção na coleta). */
export function filtrar(registro, palavras) {
  const texto = normalizar(`${registro.titulo ?? ''} ${registro.resumo ?? ''}`);
  if (palavras.excluir.some((p) => p.regex.test(texto))) return null;
  return registro.tags ?? [];
}

function atosDoSumario(arvore) {
  const atos = [];
  const andar = (n) => {
    if (n && typeof n === 'object') {
      if (n.categoria && n.documento_ato) atos.push(n);
      for (const f of n.filhos ?? []) andar(f);
    }
  };
  for (const n of arvore ?? []) andar(n);
  return atos;
}

const ENTIDADES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ordm: 'º', ordf: 'ª', deg: '°', sect: '§', ndash: '–', mdash: '—', laquo: '«', raquo: '»', hellip: '…',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ', uacute: 'ú', uuml: 'ü', ccedil: 'ç',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Uuml: 'Ü', Ccedil: 'Ç',
};
const htmlParaTexto = (html) => String(html ?? '')
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-zA-Z]+);/g, (m, nome) => ENTIDADES[nome] ?? m)
  .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

/** Seleciona o ato pelo órgão (cultura) ou pelas palavras-chave no título; descarta categorias administrativas. */
function selecionar(ato, palavras) {
  const titulo = normalizar(ato.descricao ?? '');
  const orgao = normalizar(`${ato.orgao?.sigla_orgao ?? ''} ${ato.orgao?.nome_orgao ?? ''}`);
  if (TITULO_IGNORAR.test(titulo) || ORGAOS_IGNORAR.test(orgao)) return null;
  if (palavras.excluir.some((p) => p.regex.test(titulo))) return null;
  const tags = filtrarPorPalavras(ato.descricao ?? '', palavras) ?? [];
  if (ORGAOS_CULTURA.test(orgao)) tags.push('órgão de cultura');
  return tags.length ? tags : null;
}

export async function coletar({ instancia, palavras, dias = 2, jaProcessados = new Set(), intervaloMs = INTERVALO_MS }) {
  const base = (instancia.base ?? 'https://api-dom.pbh.gov.br/api/v1').replace(/\/+$/, '');
  const hoje = hojeUTC();
  const coletadoEm = new Date().toISOString();
  const contexto = { requisicoes: 0 };
  const stats = { lidos: 0, edicoes: 0, atos: 0, candidatos: 0, pulados: 0, requisicoes: 0, erros: [] };
  const rotulo = `[${instancia.fonte}] `;
  const selecionados = [];

  log(`${rotulo}DOM-BH · ${fmtISO(somarDias(hoje, -dias))} a ${fmtISO(hoje)}`);
  for (let i = dias; i >= 0; i--) {
    const data = fmtISO(somarDias(hoje, -i));
    let edicoes = [];
    try {
      const { corpo } = await requisitarJson(`${base}/edicoes/buscarpublicacaopordata?data=${data}`, { headers: CABECALHOS, contexto, rotulo, maxTentativas: 3, esperaErroMs: 5000 });
      edicoes = Array.isArray(corpo?.data) ? corpo.data : [];
    } catch (erro) {
      stats.erros.push({ janela: data, mensagem: descreverErro(erro) });
      log(`${rotulo}${data}: falha ao listar edições (${descreverErro(erro)})`);
      continue;
    }
    await dormir(intervaloMs);
    for (const edicao of edicoes) {
      stats.edicoes++;
      let atos = [];
      try {
        const { corpo } = await requisitarJson(`${base}/edicoes/${edicao.id}/sumario`, { headers: CABECALHOS, contexto, rotulo, maxTentativas: 3, esperaErroMs: 5000 });
        atos = atosDoSumario(corpo?.data);
      } catch (erro) {
        stats.erros.push({ janela: `edição ${edicao.numero_edicao} (${data})`, mensagem: descreverErro(erro) });
        log(`${rotulo}edição ${edicao.numero_edicao}: falha no sumário (${descreverErro(erro)})`);
        continue;
      }
      stats.atos += atos.length;
      for (const ato of atos) {
        if (jaProcessados.has(String(ato.id))) { stats.pulados++; continue; }
        const tags = selecionar(ato, palavras);
        if (!tags) continue;
        selecionados.push({ ato, tags, edicao, data });
      }
      await dormir(intervaloMs);
    }
  }
  stats.lidos = stats.atos;

  const registros = [];
  for (const { ato, tags, edicao, data } of selecionados.slice(0, MAX_ATOS_POR_EXECUCAO)) {
    let titulo = ato.descricao ?? '';
    let texto = '';
    try {
      const { corpo } = await requisitarJson(`${base}/edicoes/atos/${ato.id}/publicado`, { headers: CABECALHOS, contexto, rotulo, maxTentativas: 3, esperaErroMs: 5000 });
      titulo = corpo?.data?.titulo_ato || titulo;
      texto = htmlParaTexto(corpo?.data?.conteudo_html);
    } catch (erro) {
      stats.erros.push({ janela: `ato ${ato.id}`, mensagem: descreverErro(erro) });
      log(`${rotulo}ato ${ato.id}: falha ao obter conteúdo (${descreverErro(erro)}); usa só o título`);
    }
    await dormir(intervaloMs);
    registros.push(registroUnificado({
      fonte: instancia.fonte,
      idNaFonte: String(ato.id),
      tipo: inferirTipoFomento(titulo),
      titulo,
      resumo: null,
      orgao: ato.orgao?.nome_orgao ?? null,
      uf: 'MG',
      municipio: 'Belo Horizonte',
      abertura: null,
      encerramento: null,
      valor: null,
      link: `https://dom-web.pbh.gov.br/visualizacao/ato/${ato.id}`,
      linksExtras: [`https://dom-web.pbh.gov.br/visualizacao/edicao/${edicao.id}`],
      tags,
      coletadoEm,
      publicadoEm: edicao.dt_publicacao ?? data,
      detalhes: {
        fonteNome: 'Diário Oficial de Belo Horizonte',
        regiao: 'Grande BH',
        edicao: edicao.numero_edicao ?? null,
        categoria: ato.categoria?.nome_categoria ?? null,
        orgaoSigla: ato.orgao?.sigla_orgao ?? null,
        textoUrl: `${base}/edicoes/atos/${ato.id}/publicado`,
        textoBruto: truncar(`${titulo}\n${texto}`, LIMITE_TEXTO),
      },
    }));
  }
  stats.candidatos = registros.length;
  stats.requisicoes = contexto.requisicoes;
  log(`${rotulo}${stats.edicoes} edições, ${stats.atos} atos, ${selecionados.length} selecionados (${stats.pulados} já processados), ${registros.length} com conteúdo`);
  if (stats.edicoes === 0 && stats.erros.length) throw new Error(`nenhuma edição lida (${stats.erros[0].mensagem})`);
  return { registros, stats };
}
