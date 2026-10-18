/**
 * Adaptador do Diário Oficial dos Municípios Mineiros (Associação Mineira de Municípios), sistema SIGPub:
 * https://www.diariomunicipal.com.br/amm-mg/
 *
 * Confirmado em 2026-10-18: não há API JSON; a busca é um formulário GET em /amm-mg/pesquisar com
 * busca_avancada[texto], [entidade] (id numérico da prefeitura), [dataInicio], [dataFim], [pagina].
 * A resposta é HTML com <li class="materia-card"> (título com link /amm-mg/materia/<ID>, entidade, órgão,
 * trecho com <mark>, data de circulação, edição). Cada matéria tem versão HTML em /amm-mg/download/materia/<ID>
 * (container <div class="materia">), então não é preciso baixar PDF nem usar parser.
 *
 * Cada matéria selecionada vira um registro bruto com detalhes.textoBruto; a IA extrai (modo extrator).
 * Respeito ao site: 1 requisição por segundo e User-Agent identificando o projeto.
 */
import { log, dormir, hojeUTC, somarDias, fmtISO, normalizar, registroUnificado, inferirTipoFomento, truncar, descreverErro, UA_PROJETO } from '../util.mjs';

export const INTERVALO_MS = 1000;
const LIMITE_TEXTO = 3000;
const MAX_PAGINAS = 5;
const MAX_MATERIAS_POR_EXECUCAO = 150;
const UA = UA_PROJETO;
const TITULO_IGNORAR = /^(portaria|decreto|lei |mensagem de veto|extrato|ata |nomea|exonera|designa|homolog|resultado|errata|convoca|aviso de licita|termo de)/;

export function filtrar(registro, palavras) {
  const texto = normalizar(`${registro.titulo ?? ''} ${registro.resumo ?? ''}`);
  if (palavras.excluir.some((p) => p.regex.test(texto))) return null;
  return registro.tags ?? [];
}

const decodificar = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();

async function baixar(url, contexto, rotulo) {
  for (let tentativa = 1; ; tentativa++) {
    contexto.requisicoes++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (erro) {
      if (tentativa >= 3) throw erro;
      log(`  ${rotulo}aviso: ${descreverErro(erro)} — tentativa ${tentativa}/3`);
      await dormir(5000 * tentativa);
    }
  }
}

function urlBusca(base, { texto, entidade, desde, ate, pagina }) {
  const p = new URLSearchParams();
  p.set('busca_avancada[texto]', texto);
  p.set('busca_avancada[titulo]', '');
  p.set('busca_avancada[entidade]', String(entidade));
  p.set('busca_avancada[orgao]', '');
  p.set('busca_avancada[dataInicio]', desde);
  p.set('busca_avancada[dataFim]', ate);
  p.set('busca_avancada[ordenacao]', '');
  p.set('busca_avancada[pagina]', String(pagina));
  return `${base}/pesquisar?${p.toString()}`;
}

function extrairCards(html) {
  const cards = [];
  const re = /<li class="materia-card">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const c = m[1];
    const t = /<a href="\/amm-mg\/materia\/([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/a>/.exec(c);
    if (!t) continue;
    const campo = (classe) => { const x = new RegExp(`class="materia-card__${classe}"[^>]*>([\\s\\S]*?)<\\/(?:span|p)>`).exec(c); return x ? decodificar(x[1]) : ''; };
    const data = /<dt>Circula[çc][ãa]o<\/dt>\s*<dd>\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(c);
    const edicao = /<dt>Edi[çc][ãa]o<\/dt>\s*<dd>\s*([^<]+)</.exec(c);
    cards.push({
      id: t[1], titulo: decodificar(t[2]), entidade: campo('entidade'), orgao: campo('orgao'), trecho: campo('trecho'),
      data: data ? `${data[3]}-${data[2]}-${data[1]}` : null, edicao: edicao ? edicao[1].trim() : null,
    });
  }
  return cards;
}

function textoDaMateria(html) {
  const m = /<div class="materia"[^>]*>([\s\S]*?)<\/article>/.exec(html) ?? /<article[^>]*>([\s\S]*?)<\/article>/.exec(html);
  const bruto = m ? m[1] : html;
  return decodificar(bruto.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n'));
}

export async function coletar({ instancia, palavras, dias = 2, jaProcessados = new Set(), intervaloMs = INTERVALO_MS }) {
  const base = (instancia.base ?? 'https://www.diariomunicipal.com.br/amm-mg').replace(/\/+$/, '');
  const hoje = hojeUTC();
  const desde = fmtISO(somarDias(hoje, -dias));
  const ate = fmtISO(hoje);
  const coletadoEm = new Date().toISOString();
  const contexto = { requisicoes: 0 };
  const rotulo = `[${instancia.fonte}] `;
  const entidades = (instancia.entidades ?? []).filter((e) => e.ativo !== false);
  const consultas = instancia.consultas ?? [];
  const porEntidade = entidades.map((e) => ({ nome: e.nome, municipio: e.municipio, materias: 0, novas: 0, puladas: 0, ignoradas: 0, erros: 0 }));
  const selecionadas = new Map();
  const erros = [];

  log(`${rotulo}${entidades.length} entidades × ${consultas.length} consultas · ${desde} a ${ate}`);
  for (const entidade of entidades) {
    const stat = porEntidade.find((s) => s.nome === entidade.nome);
    const vistas = new Set();
    for (const consulta of consultas) {
      try {
        for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
          const html = await baixar(urlBusca(base, { texto: consulta, entidade: entidade.id, desde, ate, pagina }), contexto, rotulo);
          const cards = extrairCards(html);
          await dormir(intervaloMs);
          if (!cards.length) break;
          let novosNaPagina = 0;
          for (const c of cards) {
            if (vistas.has(c.id)) { selecionadas.get(c.id)?.consultas.add(consulta); continue; }
            vistas.add(c.id);
            novosNaPagina++;
            stat.materias++;
            if (jaProcessados.has(c.id)) { stat.puladas++; continue; }
            const tituloN = normalizar(c.titulo);
            if (TITULO_IGNORAR.test(tituloN) || palavras.excluir.some((p) => p.regex.test(tituloN))) { stat.ignoradas++; continue; }
            selecionadas.set(c.id, { ...c, entidadeCfg: entidade, consultas: new Set([consulta]) });
            stat.novas++;
          }
          if (!novosNaPagina) break; // página repetida: fim da paginação
        }
      } catch (erro) {
        stat.erros++;
        erros.push({ janela: `${entidade.nome} · "${consulta}"`, mensagem: descreverErro(erro) });
        log(`${rotulo}${entidade.nome} · "${consulta}" falhou: ${descreverErro(erro)} — seguindo`);
      }
    }
    log(`${rotulo}${entidade.nome}: ${stat.materias} matérias com ocorrências, ${stat.novas} novas para a IA, ${stat.puladas} já processadas, ${stat.ignoradas} ignoradas pelo título`);
  }

  const registros = [];
  for (const m of [...selecionadas.values()].slice(0, MAX_MATERIAS_POR_EXECUCAO)) {
    let texto = `${m.titulo}\n${m.trecho}`;
    try {
      const html = await baixar(`${base}/download/materia/${m.id}`, contexto, rotulo);
      const corpo = textoDaMateria(html);
      if (corpo.length > 80) texto = corpo;
    } catch (erro) {
      erros.push({ janela: `matéria ${m.id}`, mensagem: descreverErro(erro) });
    }
    await dormir(intervaloMs);
    registros.push(registroUnificado({
      fonte: instancia.fonte,
      idNaFonte: m.id,
      tipo: inferirTipoFomento(m.titulo),
      titulo: m.titulo,
      resumo: null,
      orgao: m.orgao ? `${m.entidade} · ${m.orgao}` : m.entidade,
      uf: 'MG',
      municipio: m.entidadeCfg.municipio,
      abertura: null,
      encerramento: null,
      valor: null,
      link: `${base}/materia/${m.id}`,
      linksExtras: [`${base}/download/materia/${m.id}`],
      tags: [...m.consultas].map((c) => `consulta: ${c}`),
      coletadoEm,
      publicadoEm: m.data,
      detalhes: {
        fonteNome: `Diário Oficial dos Municípios Mineiros (AMM) · ${m.entidadeCfg.municipio}`,
        regiao: m.entidadeCfg.regiao ?? null,
        edicao: m.edicao,
        textoUrl: `${base}/download/materia/${m.id}`,
        textoBruto: truncar(texto, LIMITE_TEXTO),
      },
    }));
  }

  if (entidades.length && consultas.length && erros.length >= entidades.length * consultas.length) throw new Error(`todas as consultas falharam (${erros[0].mensagem})`);
  return {
    registros,
    stats: { lidos: porEntidade.reduce((s, e) => s + e.materias, 0), candidatos: registros.length, requisicoes: contexto.requisicoes, periodo: { de: desde, ate, dias }, entidades: porEntidade, erros },
  };
}
