/**
 * Adaptador genérico para páginas HTML de editais (Ministério da Cultura, Funarte, Secult-MG...).
 * Configurado em scripts/fontes.json com "tipo": "html". Sem parser de DOM (só Node 20): usa regex
 * sobre o HTML, o que basta para listagens simples de links.
 *
 * Config:
 *   listas:       URLs das páginas de listagem.
 *   padraoItem:   regex (string) que o href absoluto precisa casar para ser um edital.
 *   blocoInicio / blocoFim: regex (string) opcionais que delimitam o trecho da página onde procurar links
 *                 (ex.: id="content-core" no gov.br; class="item-page" no Joomla da Secult).
 *   filtroTitulo: regex (string) opcional que o texto do link precisa casar (ex.: "^(edital|chamamento|pr[êe]mio)").
 *   agruparPor:   regex (string) opcional; links cujo título casa o mesmo grupo viram um registro só
 *                 (ex.: "edital fec (\\d+)/(\\d{2,4})" junta edital, retificações e prorrogações).
 *   detalhe:      true para abrir cada página de edital e mandar o texto principal ao extrator por IA.
 *   orgao, uf, municipio: metadados fixos da fonte.
 *
 * Os registros saem com detalhes.textoBruto, o que os encaminha ao EXTRATOR (como o Diário Oficial):
 * a IA decide relevância e preenche tipo, resumo, prazo e valor. Palavras-chave de "incluir" não são
 * exigidas (páginas de editais já são o assunto); as de "excluir" cortam o óbvio.
 */
import { log, dormir, requisitarJson, UA_NAVEGADOR, hashCurto, normalizar, registroUnificado, inferirTipoFomento, truncar, descreverErro, paraDataISO } from '../util.mjs';

export const INTERVALO_MS = 1000;
const LIMITE_TEXTO = 3000;
const MAX_ITENS_POR_LISTA = 80;

/** Só "excluir" se aplica; "incluir" não é exigido para páginas de editais. */
export function filtrar(registro, palavras) {
  const texto = normalizar(`${registro.titulo ?? ''} ${registro.resumo ?? ''}`);
  if (palavras.excluir.some((p) => p.regex.test(texto))) return null;
  return registro.tags ?? [];
}

async function baixarHtml(url, contexto, rotulo) {
  // requisitarJson faz res.json(); aqui precisamos do texto. Mesmo retry/backoff, via fetch direto.
  for (let tentativa = 1; ; tentativa++) {
    contexto.requisicoes++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA_NAVEGADOR, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { html: await res.text(), urlFinal: res.url || url };
    } catch (erro) {
      if (tentativa >= 3) throw erro;
      log(`  ${rotulo}aviso: ${descreverErro(erro)} em ${url} — tentativa ${tentativa}/3`);
      await dormir(3000 * tentativa);
    }
  }
}

const decodificar = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
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
      const semScripts = m[1].replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
      const t = decodificar(semScripts);
      if (t.length > 200) return t;
    }
  }
  return decodificar(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '));
}

function dataPublicacao(html) {
  const m = /(?:publicado|publicação|atualizado)[^0-9]{0,30}(\d{2})\/(\d{2})\/(\d{4})/i.exec(decodificar(html.slice(0, 200_000)));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export async function coletar({ instancia, palavras, intervaloMs = INTERVALO_MS }) {
  const rotulo = `[${instancia.fonte}] `;
  const contexto = { requisicoes: 0 };
  const padraoItem = new RegExp(instancia.padraoItem, 'i');
  const filtroTitulo = instancia.filtroTitulo ? new RegExp(instancia.filtroTitulo, 'i') : null;
  const agruparPor = instancia.agruparPor ? new RegExp(instancia.agruparPor, 'i') : null;
  const coletadoEm = new Date().toISOString();
  const itens = new Map(); // chave → { titulo, url, extras: [], titulos: [] }
  const erros = [];
  let linksVistos = 0;

  for (const lista of instancia.listas ?? []) {
    try {
      const { html, urlFinal } = await baixarHtml(lista, contexto, rotulo);
      const links = extrairLinks(recortarBloco(html, instancia), urlFinal);
      let aceitos = 0;
      for (const { href, texto } of links) {
        if (!padraoItem.test(href)) continue;
        if (filtroTitulo && !filtroTitulo.test(normalizar(texto))) continue;
        linksVistos++;
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
        if (instancia.ignorarAnosAnteriores != null && ano && ano < new Date().getUTCFullYear() - instancia.ignorarAnosAnteriores) continue;
        const existente = itens.get(chave);
        if (existente) {
          if (!existente.extras.includes(href) && href !== existente.url) existente.extras.push(href);
          if (!existente.titulos.includes(texto)) existente.titulos.push(texto);
          continue;
        }
        itens.set(chave, { chave, titulo: texto, url: href, extras: [], titulos: [texto] });
        aceitos++;
        if (itens.size >= MAX_ITENS_POR_LISTA) break;
      }
      log(`${rotulo}${lista}: ${links.length} links, ${aceitos} editais novos na lista`);
    } catch (erro) {
      erros.push({ janela: lista, mensagem: descreverErro(erro) });
      log(`${rotulo}lista ${lista} falhou: ${descreverErro(erro)} — seguindo`);
    }
    await dormir(intervaloMs);
  }

  const registros = [];
  for (const item of itens.values()) {
    let texto = item.titulos.join(' · ');
    let publicadoEm = null;
    if (instancia.detalhe) {
      try {
        await dormir(intervaloMs);
        const { html } = await baixarHtml(item.url, contexto, rotulo);
        const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
        const desc = /<meta\b[^>]+name="description"[^>]+content="([^"]*)"/i.exec(html);
        const titulo = h1 ? decodificar(h1[1]) : item.titulo;
        texto = [titulo, desc ? decodificar(desc[1]) : '', textoPrincipal(html)].filter(Boolean).join('\n');
        item.titulo = titulo || item.titulo;
        publicadoEm = dataPublicacao(html);
      } catch (erro) {
        erros.push({ janela: item.url, mensagem: descreverErro(erro) });
        log(`${rotulo}detalhe ${item.url} falhou: ${descreverErro(erro)} — usa só o título`);
      }
    }
    const registro = registroUnificado({
      fonte: instancia.fonte,
      idNaFonte: agruparPor && item.chave !== item.url ? item.chave : hashCurto(item.url),
      tipo: inferirTipoFomento(item.titulo),
      titulo: item.titulo,
      resumo: null,
      orgao: instancia.orgao ?? null,
      uf: instancia.uf ?? null,
      municipio: instancia.municipio ?? null,
      abertura: null,
      encerramento: null,
      valor: null,
      link: item.url,
      linksExtras: item.extras.slice(0, 6),
      tags: ['página de editais'],
      coletadoEm,
      publicadoEm: publicadoEm ?? paraDataISO(coletadoEm),
      detalhes: {
        fonteNome: instancia.nome ?? instancia.fonte,
        textoUrl: instancia.detalhe ? item.url : null,
        textoBruto: truncar(texto, LIMITE_TEXTO),
      },
    });
    if (filtrar(registro, palavras)) registros.push(registro);
  }

  if ((instancia.listas ?? []).length && erros.length >= (instancia.listas ?? []).length && registros.length === 0) {
    throw new Error(`todas as listas falharam (${erros[0]?.mensagem})`);
  }
  log(`${rotulo}${linksVistos} links de editais, ${itens.size} editais distintos, ${registros.length} candidatos`);
  return { registros, stats: { lidos: linksVistos, candidatos: registros.length, requisicoes: contexto.requisicoes, erros } };
}
