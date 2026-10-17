/**
 * Utilidades compartilhadas pelos adaptadores, pelo classificador e pelo orquestrador.
 * Só Node 20: fetch nativo, node:crypto, node:fs. Nenhum pacote npm.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------- log e tempo

export const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function hojeUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export function somarDias(data, n) {
  const r = new Date(data);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
export const fmtISO = (d) => d.toISOString().slice(0, 10);
export const fmtAAAAMMDD = (d) => fmtISO(d).replace(/-/g, '');

export function lerDataISO(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const d = new Date(`${texto}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || fmtISO(d) !== texto ? null : d;
}

/** "2026-10-25 17:00:00.000000" ou ISO → "2026-10-25"; null se inválida ou placeholder (ano >= 2100). */
export function paraDataISO(valor) {
  if (!valor) return null;
  const s = typeof valor === 'object' && valor.date ? valor.date : String(valor);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  if (Number(m[1]) >= 2100 || Number(m[1]) < 1990) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Mantém data e hora quando existirem ("2026-10-25T17:00:00"); null se inválida ou placeholder. */
export function paraDataHoraISO(valor) {
  if (!valor) return null;
  const s = typeof valor === 'object' && valor.date ? valor.date : String(valor);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  const data = paraDataISO(s);
  if (!data) return null;
  return m ? `${data}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}` : data;
}

// ---------------------------------------------------------------- texto

/** Minúsculas, sem acentos, espaços normalizados. */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function truncar(texto, max) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const corte = t.lastIndexOf(' ', max - 1);
  return `${t.slice(0, corte > max * 0.6 ? corte : max - 1).trimEnd()}…`;
}

/** sha1 curto (12 hex) de uma string: identificador estável entre execuções. */
export function hashCurto(texto) {
  return createHash('sha1').update(String(texto)).digest('hex').slice(0, 12);
}

/** Palavras com 3+ letras, sem acento, para comparações de similaridade. */
export function palavrasDe(texto) {
  return new Set(normalizar(texto).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((p) => p.length >= 3));
}

/** Jaccard sobre conjuntos de palavras (0..1). */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const p of a) if (b.has(p)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------- palavras-chave

/**
 * Transforma uma palavra-chave em regex:
 * - precisa começar no início de uma palavra do texto ('curador' não casa com 'procurador');
 * - cada palavra pode continuar por até 3 letras ('curadores', 'curadoria', 'artistas visuais';
 *   mas 'arte' não casa 'artesanato' nem 'arterial');
 * - aceita plurais irregulares comuns: -ção/-ções, -al/-ais, -ão/-ões;
 * - hífen e espaço são intercambiáveis ('arte-educação' casa 'arte educação').
 */
export function regexDePalavra(palavra) {
  const partes = normalizar(palavra)
    .split(' ')
    .map((p) => {
      let e = escaparRegex(p).replace(/-/g, '[\\s-]?');
      if (p.endsWith('cao')) e = `${e.slice(0, -3)}c(?:ao|oes)`;
      else if (p.endsWith('al')) e = `${e.slice(0, -2)}(?:al|ais)`;
      else if (p.endsWith('ao')) e = `${e.slice(0, -2)}(?:ao|oes|aos)`;
      return `${e}\\p{L}{0,3}`;
    });
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${partes.join('\\s+')}(?![\\p{L}\\p{N}])`, 'u');
}

function compilarPalavras(lista, nome) {
  if (!Array.isArray(lista)) throw new Error(`keywords.json: a lista "${nome}" precisa ser um array`);
  return lista
    .map((p) => String(p))
    .filter((p) => normalizar(p).length > 0)
    .map((original) => ({ original, regex: regexDePalavra(original) }));
}

export async function carregarPalavras(caminho) {
  const bruto = JSON.parse(await readFile(caminho, 'utf8'));
  return { incluir: compilarPalavras(bruto.incluir, 'incluir'), excluir: compilarPalavras(bruto.excluir, 'excluir') };
}

/**
 * Devolve as tags que bateram em "incluir", ou null se o texto não deve entrar
 * (nenhuma tag, ou alguma palavra de "excluir" presente).
 * `extras` são tags adicionais que já qualificam o texto (ex.: área "Artes Visuais" informada pela fonte).
 */
export function filtrarPorPalavras(texto, palavras, extras = []) {
  const t = normalizar(texto);
  if (!t && extras.length === 0) return null;
  if (palavras.excluir.some((p) => p.regex.test(t))) return null;
  const tags = palavras.incluir.filter((p) => p.regex.test(t)).map((p) => p.original);
  for (const e of extras) if (!tags.includes(e)) tags.push(e);
  return tags.length ? tags : null;
}

// ---------------------------------------------------------------- HTTP

export const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class ErroHttp extends Error {
  constructor(status, url, corpo, retryAfter) {
    super(`HTTP ${status} em ${url}`);
    this.status = status;
    this.corpo = corpo;
    this.retentavel = status === 429 || status >= 500;
    const segundos = Number(retryAfter);
    this.retryAfterMs = Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null;
  }
}

function resumirCorpo(corpo) {
  if (!corpo) return '';
  const texto = String(corpo).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return texto.length > 100 ? `${texto.slice(0, 100)}…` : texto;
}

export function descreverErro(erro) {
  if (erro instanceof ErroHttp) {
    const resumo = resumirCorpo(erro.corpo);
    return `HTTP ${erro.status}${resumo ? ` (${resumo})` : ''}`;
  }
  if (erro?.name === 'TimeoutError') return 'timeout';
  return erro?.cause?.message ?? erro?.message ?? String(erro);
}

/**
 * Limitador de ritmo adaptativo: garante `intervalo` ms entre o início de duas requisições quaisquer,
 * cresce 50% a cada 429 (segurando todas as tarefas) e relaxa de volta após uma sequência de acertos.
 */
export function criarLimitador({ intervaloMs, maxMs = 20_000, acertosParaRelaxar = 40 }) {
  const r = { base: intervaloMs, intervalo: intervaloMs, proximaLiberacao: 0, acertos: 0, bloqueios: 0 };
  return {
    get intervalo() { return r.intervalo; },
    get bloqueios() { return r.bloqueios; },
    async aguardar() {
      const agora = Date.now();
      const alvo = Math.max(agora, r.proximaLiberacao);
      r.proximaLiberacao = alvo + r.intervalo;
      if (alvo > agora) await dormir(alvo - agora);
    },
    acerto() {
      r.acertos++;
      if (r.intervalo > r.base && r.acertos >= acertosParaRelaxar) {
        r.intervalo = Math.max(r.base, Math.round(r.intervalo * 0.9));
        r.acertos = 0;
      }
    },
    bloqueio(pausaMs) {
      r.bloqueios++;
      r.acertos = 0;
      r.intervalo = Math.min(maxMs, Math.round(r.intervalo * 1.5));
      r.proximaLiberacao = Math.max(r.proximaLiberacao, Date.now() + pausaMs);
    },
  };
}

/**
 * GET/POST JSON com retry e backoff. Em 429 respeita Retry-After ou usa `espera429Ms` × 2^(tentativa-1);
 * em 5xx/rede usa `esperaErroMs` × 2^(tentativa-1). Erros 4xx (exceto 429) não são repetidos.
 * Devolve { corpo, headers }; corpo é null em 204.
 */
export async function requisitarJson(url, {
  metodo = 'GET', headers = {}, body, limitador, contexto, maxTentativas = 4,
  timeoutMs = 60_000, espera429Ms = 30_000, esperaErroMs = 2000, rotulo = '',
} = {}) {
  for (let tentativa = 1; ; tentativa++) {
    if (limitador) await limitador.aguardar();
    if (contexto) contexto.requisicoes = (contexto.requisicoes ?? 0) + 1;
    try {
      const res = await fetch(url, {
        method: metodo,
        headers: { Accept: 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204) { limitador?.acerto(); return { corpo: null, headers: res.headers }; }
      if (!res.ok) throw new ErroHttp(res.status, url, await res.text().catch(() => ''), res.headers.get('retry-after'));
      const corpo = await res.json();
      limitador?.acerto();
      return { corpo, headers: res.headers };
    } catch (erro) {
      const retentavel = erro instanceof ErroHttp ? erro.retentavel : true; // rede, timeout, JSON inválido
      if (!retentavel || tentativa >= maxTentativas) throw erro;
      let espera;
      if (erro instanceof ErroHttp && erro.status === 429) {
        espera = erro.retryAfterMs ?? espera429Ms * 2 ** (tentativa - 1);
        limitador?.bloqueio(espera);
        log(`  ${rotulo}limite (429): pausa de ${Math.round(espera / 1000)} s${limitador ? `, intervalo agora ${limitador.intervalo} ms` : ''} — tentativa ${tentativa}/${maxTentativas}`);
      } else {
        espera = esperaErroMs * 2 ** (tentativa - 1);
        log(`  ${rotulo}aviso: ${descreverErro(erro)} — tentativa ${tentativa}/${maxTentativas}, nova tentativa em ${espera} ms`);
      }
      await dormir(espera);
    }
  }
}

/** Executa `fn` sobre os itens com no máximo `limite` em andamento. */
export async function executarEmParalelo(itens, limite, fn) {
  let indice = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (indice < itens.length) await fn(itens[indice++]);
  });
  await Promise.all(trabalhadores);
}

// ---------------------------------------------------------------- esquema unificado

export const TIPOS = ['contratacao', 'fomento', 'premio', 'residencia', 'chamamento', 'outro'];
export const VEREDITOS = ['S', 'N', 'D'];

/** Infere o tipo de um edital de fomento pelo nome/descrição. */
export function inferirTipoFomento(texto) {
  const t = normalizar(texto);
  if (/\bpremi(?:o|os|acao)\b/.test(t)) return 'premio';
  if (/\bresidencia/.test(t)) return 'residencia';
  if (/\bchamamento/.test(t)) return 'chamamento';
  return 'fomento';
}

/**
 * Monta um registro no esquema unificado preenchendo os campos ausentes com null/[].
 * Campos além do esquema (publicadoEm, detalhes) são extensões usadas pela página.
 */
export function registroUnificado(campos) {
  const fonte = campos.fonte;
  const idNaFonte = String(campos.idNaFonte);
  return {
    id: hashCurto(`${fonte}:${idNaFonte}`),
    fonte,
    idNaFonte,
    tipo: TIPOS.includes(campos.tipo) ? campos.tipo : 'outro',
    titulo: truncar(campos.titulo ?? '', 160),
    resumo: campos.resumo ?? null,
    orgao: campos.orgao ?? null,
    uf: campos.uf ?? null,
    municipio: campos.municipio ?? null,
    abertura: campos.abertura ?? null,
    encerramento: campos.encerramento ?? null,
    valor: typeof campos.valor === 'number' && campos.valor > 0 ? campos.valor : null,
    link: campos.link,
    linksExtras: Array.isArray(campos.linksExtras) ? campos.linksExtras.filter(Boolean) : [],
    tags: Array.isArray(campos.tags) ? campos.tags : [],
    ia: VEREDITOS.includes(campos.ia) ? campos.ia : 'pendente',
    categoriaIA: campos.categoriaIA ?? null,
    coletadoEm: campos.coletadoEm ?? new Date().toISOString(),
    publicadoEm: campos.publicadoEm ?? null,
    detalhes: campos.detalhes ?? null,
  };
}
