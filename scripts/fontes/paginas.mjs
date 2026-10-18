/**
 * Adaptador genérico para páginas HTML de editais: órgãos públicos (tipo "html": MinC, Funarte, Secult-MG...)
 * e instituições culturais (tipo "paginas": museus, centros culturais, residências artísticas).
 * Sem parser de DOM (só Node 20): usa regex sobre o HTML, o que basta para listagens simples de links.
 *
 * Config (scripts/fontes.json):
 *   listas:       URLs das páginas de listagem.
 *   padraoItem:   regex (string) que o href absoluto precisa casar para ser um edital.
 *   padraoExcluir: regex (string) opcional; hrefs que casam são ignorados (categorias, paginação, wp-content...).
 *   blocoInicio / blocoFim: regex (string) opcionais que delimitam o trecho da página onde procurar links
 *                 (ex.: id="content-core" no gov.br; class="item-page" no Joomla da Secult).
 *   filtroTitulo: regex (string) opcional que o texto normalizado do link precisa casar (ex.: "^(edital|chamamento|pr[êe]mio)").
 *   agruparPor:   regex (string) opcional; links cujo título casa o mesmo grupo viram um registro só
 *                 (ex.: "edital fec (\\d+)/(\\d{2,4})" junta edital, retificações e prorrogações).
 *   detalhe:      true para abrir cada página de edital e mandar o texto principal ao extrator por IA.
 *   paginaUnica:  true quando a própria página listada é o edital (programa de residência com página fixa):
 *                 o texto da página vira um registro; o id muda quando o conteúdo muda.
 *   maxLinks:     máximo de links novos seguidos por rodada (padrão 20 no tipo "paginas"; sem limite no "html").
 *   limiteTexto:  caracteres de texto enviados à IA (padrão 3000; 5000 em paginaUnica).
 *   orgao, uf, municipio, abrangencia, grupo: metadados fixos da fonte.
 *
 * Tipo "paginas" (instituições): User-Agent do projeto, 1 requisição por segundo, só links ainda não
 * conhecidos na base (jaProcessados) e no máximo maxLinks por rodada. Os registros saem com
 * detalhes.textoBruto, o que os encaminha ao EXTRATOR (como o Diário Oficial): a IA decide relevância e
 * preenche tipo, resumo, prazo, valor e participação. Palavras-chave de "incluir" não são exigidas
 * (páginas de editais já são o assunto); as de "excluir" cortam o óbvio.
 */
import { log, dormir, UA_NAVEGADOR, UA_PROJETO, hashCurto, normalizar, registroUnificado, inferirTipoFomento, truncar, descreverErro, paraDataISO } from '../util.mjs';

export const INTERVALO_MS = 1000;
const LIMITE_TEXTO = 3000;
const LIMITE_TEXTO_PAGINA_UNICA = 5000;
const MAX_ITENS_POR_LISTA = 80;
const MAX_LINKS_NOVOS_INSTITUICAO = 20;

/** Só "excluir" se aplica; "incluir" não é exigido para páginas de editais. */
export function filtrar(registro, palavras) {
  const texto = normalizar(`${registro.titulo ?? ''} ${registro.resumo ?? ''}`);
  if (palavras.excluir.some((p) => p.regex.test(texto))) return null;
  return registro.tags ?? [];
}

async function baixarHtml(url, contexto, rotulo, ua) {
  // requisitarJson faz res.json(); aqui precisamos do texto. Mesmo retry/backoff, via fetch direto.
  for (let tentativa = 1; ; tentativa++) {
    contexto.requisicoes++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7' }, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tipo = res.headers.get('content-type') ?? '';
      if (/application\/(pdf|octet-stream|zip|msword)/i.test(tipo)) throw new Error(`conteúdo não é HTML (${tipo.split(';')[0]})`);
      return { html: await res.text(), urlFinal: res.url || url };
    } catch (erro) {
      if (tentativa >= 3 || /HTTP 4\d\d|não é HTML/.test(String(erro?.message))) throw erro;
      log(`  ${rotulo}aviso: ${descreverErro(erro)} em ${url} — tentativa ${tentativa}/3`);
      await dormir(3000 * tentativa);
    }
  }
}

const decodificar = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;|&#8216;/g, "'").replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function recortarBloco(html, instancia) {
  let bloco = html;
  if (instancia.blocoInicio) {
    const m = new RegExp(instancia.blocoInicio, 'i').exec(bloco);
    if (m) bloco = bloco.slice(m.index);
  }
  if (instancia.blocoFim) {
    const m = new RegExp(instancia.blocoFim, 'i').exec(bloco);
    if (m && m.index > 0) bloco = bloco.slice(0, m.index);
  }
  return bloco;
}

function extrairLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*?href\s*=\s*"([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href;
    try { href = new URL(m[1], baseUrl).href; } catch { continue; }
    const texto = decodificar(m[2]);
    if (texto.length >= 4) links.push({ href, texto });
  }
  return links;
}

/** Texto principal de uma página de edital: content-core (gov.br), article/main, ou body. */
function textoPrincipal(html) {
  const tentativas = [
    /id="content-core"([\s\S]*?)(?:id="viewlet-below-content"|<\/main>)/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ];
  for (const re of tentativas) {
    const m = re.exec(html);
    if (m) {
      const semScripts = m[1].replace(/<(script|style|nav|header|footer|noscript|svg|form)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
      const t = decodificar(semScripts);
      if (t.length > 200) return t;
    }
  }
  return decodificar(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' '));
}

function dataPublicacao(html) {
  const meta = /<meta\b[^>]+property="article:published_time"[^>]+content="(\d{4}-\d{2}-\d{2})/i.exec(html);
  if (meta) return meta[1];
  const m = /(?:publicado|publicação|atualizado)[^0-9]{0,30}(\d{2})\/(\d{2})\/(\d{4})/i.exec(decodificar(html.slice(0, 200_000)));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Título, descrição e texto principal de uma página de edital. */
function lerPagina(html, tituloPadrao) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const og = /<meta\b[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html);
  const desc = /<meta\b[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]*)"/i.exec(html);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  // og:title e <title> costumam trazer o título do post; o h1 às vezes é só o nome do site (logo).
  const semSufixo = (t) => t.replace(/\s+[|–—-]\s+[^|–—-]{3,60}$/, '').trim();
  const candidatos = [og ? decodificar(og[1]) : '', title ? decodificar(title[1]) : '', h1 ? decodificar(h1[1]) : ''].map(semSufixo).filter((t) => t.length >= 12);
  const titulo = candidatos[0] || (h1 ? decodificar(h1[1]) : '') || tituloPadrao;
  const texto = [titulo, desc ? decodificar(desc[1]) : '', textoPrincipal(html)].filter(Boolean).join('\n');
  return { titulo, texto, publicadoEm: dataPublicacao(html) };
}

const ehPdf = (url) => /\.pdf(?:[?#]|$)/i.test(url);

export async function coletar({ instancia, palavras, intervaloMs = INTERVALO_MS, jaProcessados = new Set() }) {
  const rotulo = `[${instancia.fonte}] `;
  const institucional = instancia.tipo === 'paginas';
  const ua = institucional || instancia.uaProjeto ? UA_PROJETO : UA_NAVEGADOR;
  const maxNovos = instancia.maxLinks ?? (institucional ? MAX_LINKS_NOVOS_INSTITUICAO : Infinity);
  const limiteTexto = instancia.limiteTexto ?? (instancia.paginaUnica ? LIMITE_TEXTO_PAGINA_UNICA : LIMITE_TEXTO);
  const contexto = { requisicoes: 0 };
  const padraoItem = instancia.padraoItem ? new RegExp(instancia.padraoItem, 'i') : null;
  const padraoExcluir = instancia.padraoExcluir ? new RegExp(instancia.padraoExcluir, 'i') : null;
  const filtroTitulo = instancia.filtroTitulo ? new RegExp(instancia.filtroTitulo, 'i') : null;
  const agruparPor = instancia.agruparPor ? new RegExp(instancia.agruparPor, 'i') : null;
  const coletadoEm = new Date().toISOString();
  const itens = new Map(); // chave → { titulo, url, extras: [], titulos: [] }
  const erros = [];
  const stats = { paginasLidas: 0, lidos: 0, linksSeguidos: 0, jaConhecidos: 0, editaisExtraidos: 0, limitados: 0 };
  const metadados = {
    fonte: instancia.fonte,
    orgao: instancia.orgao ?? null,
    uf: instancia.uf ?? null,
    municipio: instancia.municipio ?? null,
    tags: [institucional ? 'instituição' : 'página de editais'],
    coletadoEm,
  };
  const montar = ({ idNaFonte, titulo, url, extras = [], texto, textoUrl, publicadoEm }) => registroUnificado({
    ...metadados,
    idNaFonte,
    tipo: inferirTipoFomento(titulo),
    titulo,
    resumo: null,
    abertura: null,
    encerramento: null,
    valor: null,
    link: url,
    linksExtras: extras.slice(0, 6),
    publicadoEm: publicadoEm ?? paraDataISO(coletadoEm),
    detalhes: {
      fonteNome: instancia.nome ?? instancia.fonte,
      abrangencia: instancia.abrangencia ?? null,
      textoUrl,
      textoBruto: truncar(texto, limiteTexto),
    },
  });

  const registros = [];

  // Modo página única: a própria URL listada é o edital/programa (residência com página fixa).
  if (instancia.paginaUnica) {
    for (const url of instancia.listas ?? []) {
      try {
        const { html, urlFinal } = await baixarHtml(url, contexto, rotulo, ua);
        stats.paginasLidas++;
        const { titulo, texto, publicadoEm } = lerPagina(html, instancia.nome ?? url);
        // O id muda quando o conteúdo muda (nova edição do programa); o registro antigo expira pela retenção.
        const idNaFonte = `${hashCurto(url)}:${hashCurto(normalizar(texto).slice(0, 2500))}`;
        stats.lidos++;
        if (jaProcessados.has(idNaFonte)) { stats.jaConhecidos++; continue; }
        const registro = montar({ idNaFonte, titulo: truncar(titulo, 160), url: urlFinal, texto, textoUrl: url, publicadoEm });
        if (filtrar(registro, palavras)) { registros.push(registro); stats.editaisExtraidos++; }
      } catch (erro) {
        erros.push({ janela: url, mensagem: descreverErro(erro) });
        log(`${rotulo}página ${url} falhou: ${descreverErro(erro)} — seguindo`);
      }
      await dormir(intervaloMs);
    }
    if ((instancia.listas ?? []).length && erros.length >= (instancia.listas ?? []).length) throw new Error(`todas as páginas falharam (${erros[0]?.mensagem})`);
    log(`${rotulo}${stats.paginasLidas} página(s) lida(s), ${stats.jaConhecidos} sem mudança, ${registros.length} candidatos`);
    return { registros, stats: { ...stats, candidatos: registros.length, requisicoes: contexto.requisicoes, erros } };
  }

  for (const lista of instancia.listas ?? []) {
    try {
      const { html, urlFinal } = await baixarHtml(lista, contexto, rotulo, ua);
      stats.paginasLidas++;
      const links = extrairLinks(recortarBloco(html, instancia), urlFinal);
      let aceitos = 0;
      for (const { href, texto } of links) {
        if (padraoItem && !padraoItem.test(href)) continue;
        if (padraoExcluir && padraoExcluir.test(href)) continue;
        if (href.replace(/\/$/, '') === urlFinal.replace(/\/$/, '')) continue;
        if (filtroTitulo && !filtroTitulo.test(normalizar(texto))) continue;
        stats.lidos++;
        let chave = href;
        let ano = null;
        if (agruparPor) {
          const g = agruparPor.exec(normalizar(texto));
          if (g) {
            // Normaliza o ano (26 → 2026) para "02/26" e "02/2026" caírem no mesmo grupo.
            const partes = g.slice(1).map((p) => (p && /^\d{2}$/.test(p) ? `20${p}` : p ?? ''));
            chave = `${instancia.fonte}:${partes.join('/')}`;
            ano = Number(partes.find((p) => /^20\d{2}$/.test(p))) || null;
          }
        }
        if (instancia.exigirAgrupamento && chave === href) continue; // link genérico ("Edital", "Errata") sem número de edital
        if (!ano) { const m = /\b(20\d{2})\b/.exec(texto); if (m) ano = Number(m[1]); } // ano solto no título ("Edital FCS 01/2023", "... 2020")
        if (instancia.ignorarAnosAnteriores != null && ano && ano < new Date().getUTCFullYear() - instancia.ignorarAnosAnteriores) continue;
        const existente = itens.get(chave);
        if (existente) {
          if (!existente.extras.includes(href) && href !== existente.url) existente.extras.push(href);
          if (!existente.titulos.includes(texto)) existente.titulos.push(texto);
          continue;
        }
        const idNaFonte = agruparPor && chave !== href ? chave : hashCurto(href);
        if (institucional && jaProcessados.has(idNaFonte)) { stats.jaConhecidos++; continue; } // já está na base (ou foi descartado): não refaz
        if (institucional && itens.size >= maxNovos) { stats.limitados++; continue; }
        itens.set(chave, { chave, idNaFonte, titulo: texto, url: href, extras: [], titulos: [texto] });
        aceitos++;
        if (itens.size >= MAX_ITENS_POR_LISTA) break;
      }
      log(`${rotulo}${lista}: ${links.length} links, ${aceitos} editais novos na lista${stats.jaConhecidos ? ` (${stats.jaConhecidos} já conhecidos)` : ''}`);
    } catch (erro) {
      erros.push({ janela: lista, mensagem: descreverErro(erro) });
      log(`${rotulo}lista ${lista} falhou: ${descreverErro(erro)} — seguindo`);
    }
    await dormir(intervaloMs);
  }

  for (const item of itens.values()) {
    let texto = item.titulos.join(' · ');
    let publicadoEm = null;
    if (instancia.detalhe && !ehPdf(item.url)) {
      try {
        await dormir(intervaloMs);
        const { html } = await baixarHtml(item.url, contexto, rotulo, ua);
        stats.linksSeguidos++;
        const pagina = lerPagina(html, item.titulo);
        texto = pagina.texto;
        item.titulo = pagina.titulo || item.titulo;
        publicadoEm = pagina.publicadoEm;
      } catch (erro) {
        erros.push({ janela: item.url, mensagem: descreverErro(erro) });
        log(`${rotulo}detalhe ${item.url} falhou: ${descreverErro(erro)} — usa só o título`);
      }
    }
    const registro = montar({ idNaFonte: item.idNaFonte, titulo: truncar(item.titulo, 160), url: item.url, extras: item.extras, texto, textoUrl: instancia.detalhe && !ehPdf(item.url) ? item.url : null, publicadoEm });
    if (filtrar(registro, palavras)) { registros.push(registro); stats.editaisExtraidos++; }
  }

  if ((instancia.listas ?? []).length && erros.length >= (instancia.listas ?? []).length && registros.length === 0) {
    throw new Error(`todas as listas falharam (${erros[0]?.mensagem})`);
  }
  log(`${rotulo}${stats.lidos} links de editais, ${itens.size} editais distintos, ${registros.length} candidatos${stats.limitados ? ` · ${stats.limitados} deixados para a próxima rodada (máx. ${maxNovos})` : ''}`);
  return { registros, stats: { ...stats, candidatos: registros.length, requisicoes: contexto.requisicoes, erros } };
}
