#!/usr/bin/env node
/**
 * Coletor de contratações públicas do PNCP na área de artes visuais.
 *
 * Uso:
 *   node scripts/fetch.mjs                  # últimos 2 dias (padrão)
 *   node scripts/fetch.mjs --dias 90        # primeira carga
 *   node scripts/fetch.mjs --dias 30 --paralelo 2
 *
 * Só usa o fetch nativo do Node 20. Nenhum pacote npm.
 * Documentação da API: https://pncp.gov.br/api/consulta/swagger-ui/index.html
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const PASTA_DADOS = path.join(RAIZ, 'docs', 'data');
const ARQ_DADOS = path.join(PASTA_DADOS, 'contratacoes.json');
const ARQ_META = path.join(PASTA_DADOS, 'meta.json');
const ARQ_PALAVRAS = path.join(AQUI, 'keywords.json');

const API_BASE = 'https://pncp.gov.br/api/consulta/v1';

/** Modalidades varridas (códigos da tabela de domínio do PNCP). Edite à vontade. */
const MODALIDADES = [
  { codigo: 3, nome: 'Concurso' },
  { codigo: 8, nome: 'Dispensa de licitação' },
  { codigo: 9, nome: 'Inexigibilidade' },
  { codigo: 12, nome: 'Credenciamento' },
  { codigo: 6, nome: 'Pregão eletrônico' },
];

const TAMANHO_PAGINA = 50;   // máximo aceito pela API (mínimo 10; abaixo disso responde 400)
const JANELA_MAX_DIAS = 30;  // o período pedido é quebrado em janelas deste tamanho
const MAX_TENTATIVAS = 4;    // tentativas em 429, 5xx ou erro de rede (backoff exponencial)
const TIMEOUT_MS = 60_000;
const RETENCAO_DIAS = 365;   // registros publicados há mais tempo são descartados
const PARALELO_PADRAO = 1;   // tarefas (modalidade × janela) em andamento ao mesmo tempo

// Ritmo. A API do PNCP limita por IP: aceita um surto de ~6 requisições, bloqueia (429) por ~20 s
// e sustenta 1 requisição a cada 2 s sem bloquear (medido em 2026-10). O intervalo é global (vale para
// todas as tarefas) e adaptativo: cresce 50% a cada 429 e volta devagar ao valor base após uma sequência de acertos.
const INTERVALO_MS = 2000;       // espera mínima entre o início de duas requisições (padrão; --intervalo)
const INTERVALO_MAX_MS = 20_000; // teto do intervalo adaptativo
const ESPERA_429_MS = 30_000;    // pausa após um 429 (dobra a cada tentativa: 30 s, 60 s, 120 s)
const ESPERA_ERRO_MS = 2000;     // pausa após 5xx ou erro de rede (dobra a cada tentativa)
const ACERTOS_PARA_RELAXAR = 40; // requisições OK seguidas antes de reduzir o intervalo em 10%

// Classificação por IA (segunda peneira, depois das palavras-chave). Ver a seção "classificação por IA".
const IA_MODELO = 'claude-haiku-5-5';
const IA_URL = 'https://api.anthropic.com/v1/messages';
const IA_VERSAO = '2023-06-01';           // cabeçalho anthropic-version
const IA_LOTE = 30;                       // itens por requisição
const IA_TRUNCAR_OBJETO = 600;            // caracteres do objeto enviados ao modelo
const IA_TOKENS_POR_ITEM = 8;             // resposta: ~6 tokens por item ("1":"S",) + folga
const IA_MARGEM_TOKENS = 40;
const IA_MAX_TENTATIVAS = 3;              // em 429/5xx/rede
const IA_INTERVALO_MS = 200;              // pausa entre lotes
const IA_PRECO_ENTRADA_USD_POR_MTOK = 0.10; // claude-haiku-5-5, prompts até 100K tokens
const IA_PRECO_SAIDA_USD_POR_MTOK = 0.50;
const IA_DESCARTAR_N_DIAS = 30;           // itens reprovados pela IA saem da base depois de N dias

const USO = `Uso: node scripts/fetch.mjs [--dias N] [--ate AAAA-MM-DD] [--intervalo MS] [--paralelo N] [--so-ia]
  --dias N         quantos dias para trás buscar a partir de --ate (padrão 2)
  --ate AAAA-MM-DD data final do período (padrão: hoje). Útil para dividir a carga inicial em partes
  --intervalo MS   espera mínima entre requisições (padrão ${INTERVALO_MS}; a API bloqueia com menos que isso)
  --paralelo N     tarefas simultâneas (padrão ${PARALELO_PADRAO}; o limite da API é por IP, então não acelera)
  --so-ia          não consulta o PNCP; só classifica com IA os itens pendentes da base existente

Classificação por IA: exige a variável de ambiente ANTHROPIC_API_KEY. Sem ela, os itens novos
ficam marcados como "pendente" e são classificados na próxima execução que tiver a chave.

A API sustenta ~30 requisições/min: 2 dias levam ~8 min, 30 dias ~2 h.
Para 90 dias, rode em partes: --dias 30 · --dias 30 --ate <hoje-30> · --dias 30 --ate <hoje-60>.`;

// ---------------------------------------------------------------- utilidades

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function hojeUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function somarDias(data, n) {
  const r = new Date(data);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
const fmtISO = (d) => d.toISOString().slice(0, 10);
const fmtAAAAMMDD = (d) => fmtISO(d).replace(/-/g, '');

/** Quebra [inicio, fim] em janelas de no máximo JANELA_MAX_DIAS dias. */
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

function lerDataISO(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const d = new Date(`${texto}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || fmtISO(d) !== texto ? null : d;
}

function lerArgumentos(argv) {
  const args = { dias: 2, ate: null, intervalo: INTERVALO_MS, paralelo: PARALELO_PADRAO, soIa: false };
  const minimos = { dias: 0, intervalo: 0, paralelo: 1 };
  for (let i = 0; i < argv.length; i++) {
    let [chave, valor] = argv[i].split('=', 2);
    if (chave === '--help' || chave === '-h') {
      console.log(USO);
      process.exit(0);
    }
    if (chave === '--so-ia') {
      args.soIa = true;
      continue;
    }
    const nome = chave.startsWith('--') ? chave.slice(2) : '';
    if (!(nome in minimos) && nome !== 'ate') throw new Error(`Argumento desconhecido: ${argv[i]}\n${USO}`);
    if (valor === undefined) valor = argv[++i];
    if (nome === 'ate') {
      args.ate = lerDataISO(String(valor ?? ''));
      if (!args.ate) throw new Error(`Valor inválido para --ate (use AAAA-MM-DD): ${valor}`);
      continue;
    }
    const n = Number(valor);
    if (!Number.isInteger(n) || n < minimos[nome]) throw new Error(`Valor inválido para ${chave}: ${valor}`);
    args[nome] = n;
  }
  return args;
}

/** Resume o corpo de uma resposta de erro (JSON ou HTML) numa linha curta. */
function resumirCorpo(corpo) {
  if (!corpo) return '';
  const texto = corpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return texto.length > 100 ? `${texto.slice(0, 100)}…` : texto;
}

function descreverErro(erro) {
  if (erro instanceof ErroHttp) {
    const resumo = resumirCorpo(erro.corpo);
    return `HTTP ${erro.status}${resumo ? ` (${resumo})` : ''}`;
  }
  if (erro?.name === 'TimeoutError') return `timeout após ${TIMEOUT_MS} ms`;
  return erro?.cause?.message ?? erro?.message ?? String(erro);
}

// ---------------------------------------------------------------- HTTP

class ErroHttp extends Error {
  constructor(status, url, corpo, retryAfter) {
    super(`HTTP ${status} em ${url}`);
    this.status = status;
    this.corpo = corpo;
    this.retentavel = status === 429 || status >= 500;
    // Retry-After em segundos, quando o servidor informa.
    const segundos = Number(retryAfter);
    this.retryAfterMs = Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null;
  }
}

/**
 * Limitador global e adaptativo. Garante `ritmo.intervalo` ms entre o início de duas requisições
 * quaisquer (mesmo com tarefas em paralelo) e segura todas as tarefas quando a API devolve 429.
 */
const ritmo = { base: INTERVALO_MS, intervalo: INTERVALO_MS, proximaLiberacao: 0, acertosSeguidos: 0, bloqueios: 0 };

function configurarRitmo(intervaloBase) {
  ritmo.base = intervaloBase;
  ritmo.intervalo = intervaloBase;
}

async function aguardarVez() {
  const agora = Date.now();
  const alvo = Math.max(agora, ritmo.proximaLiberacao);
  ritmo.proximaLiberacao = alvo + ritmo.intervalo;
  if (alvo > agora) await dormir(alvo - agora);
}

function registrarAcerto() {
  ritmo.acertosSeguidos++;
  if (ritmo.intervalo > ritmo.base && ritmo.acertosSeguidos >= ACERTOS_PARA_RELAXAR) {
    ritmo.intervalo = Math.max(ritmo.base, Math.round(ritmo.intervalo * 0.9));
    ritmo.acertosSeguidos = 0;
  }
}

/** Após 429: pausa global (todas as tarefas esperam) e intervalo 50% maior. */
function registrarBloqueio(pausaMs) {
  ritmo.bloqueios++;
  ritmo.acertosSeguidos = 0;
  ritmo.intervalo = Math.min(INTERVALO_MAX_MS, Math.round(ritmo.intervalo * 1.5));
  ritmo.proximaLiberacao = Math.max(ritmo.proximaLiberacao, Date.now() + pausaMs);
}

/** GET com retry/backoff. Devolve o JSON ou null quando a API responde 204 (sem conteúdo). */
async function requisitar(url, contexto) {
  for (let tentativa = 1; ; tentativa++) {
    await aguardarVez();
    contexto.requisicoes++;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 204) { registrarAcerto(); return null; }
      if (!res.ok) throw new ErroHttp(res.status, url, await res.text().catch(() => ''), res.headers.get('retry-after'));
      const corpo = await res.json();
      registrarAcerto();
      return corpo;
    } catch (erro) {
      const retentavel = erro instanceof ErroHttp ? erro.retentavel : true; // rede, timeout, JSON inválido
      if (!retentavel || tentativa >= MAX_TENTATIVAS) throw erro;

      let espera;
      if (erro instanceof ErroHttp && erro.status === 429) {
        espera = erro.retryAfterMs ?? ESPERA_429_MS * 2 ** (tentativa - 1); // 30 s, 60 s, 120 s
        registrarBloqueio(espera);
        log(`  limite da API (429): pausa de ${Math.round(espera / 1000)} s, intervalo agora ${ritmo.intervalo} ms — tentativa ${tentativa}/${MAX_TENTATIVAS}`);
      } else {
        espera = ESPERA_ERRO_MS * 2 ** (tentativa - 1); // 2 s, 4 s, 8 s
        log(`  aviso: ${descreverErro(erro)} — tentativa ${tentativa}/${MAX_TENTATIVAS}, nova tentativa em ${espera} ms`);
      }
      await dormir(espera);
    }
  }
}

// ---------------------------------------------------------------- filtro por palavras-chave

/** Minúsculas, sem acentos, espaços normalizados. */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Transforma uma palavra-chave em regex:
 * - precisa começar no início de uma palavra do texto ('curador' não casa com 'procurador');
 * - pode continuar por até 3 letras ('curador' casa 'curadores' e 'curadoria'; 'arte' casa 'artes'
 *   mas não 'artesanato' nem 'arterial');
 * - aceita os plurais irregulares mais comuns: -ção/-ções, -al/-ais, -ão/-ões;
 * - hífen e espaço são intercambiáveis ('arte-educação' casa 'arte educação').
 */
function regexDePalavra(palavra) {
  const partes = normalizar(palavra)
    .split(' ')
    .map((p) => {
      let e = escaparRegex(p).replace(/-/g, '[\\s-]?');
      if (p.endsWith('cao')) e = `${e.slice(0, -3)}c(?:ao|oes)`;
      else if (p.endsWith('al')) e = `${e.slice(0, -2)}(?:al|ais)`;
      else if (p.endsWith('ao')) e = `${e.slice(0, -2)}(?:ao|oes|aos)`;
      return `${e}\\p{L}{0,3}`; // cada palavra da expressão pode ter até 3 letras a mais ('artistas visuais')
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

async function carregarPalavras() {
  const bruto = JSON.parse(await readFile(ARQ_PALAVRAS, 'utf8'));
  return { incluir: compilarPalavras(bruto.incluir, 'incluir'), excluir: compilarPalavras(bruto.excluir, 'excluir') };
}

/** Devolve as tags que bateram, ou null se o objeto não deve entrar. */
function classificar(objetoCompra, palavras) {
  const texto = normalizar(objetoCompra);
  if (!texto) return null;
  const tags = palavras.incluir.filter((p) => p.regex.test(texto)).map((p) => p.original);
  if (tags.length === 0) return null;
  if (palavras.excluir.some((p) => p.regex.test(texto))) return null;
  return tags;
}

// ---------------------------------------------------------------- projeção e mesclagem

/** Muitos órgãos informam o link de origem sem "https://" (ex.: "www.compras.xx.gov.br"). */
function normalizarLink(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(s)) return `https://${s}`;
  return null;
}

/** Guarda só o que a página usa. Nomes dos campos seguem o PNCP sempre que possível. */
function projetar(item, tags) {
  const cnpj = item.orgaoEntidade?.cnpj ?? null;
  const temLink = cnpj && item.anoCompra != null && item.sequencialCompra != null;
  return {
    numeroControlePNCP: item.numeroControlePNCP,
    objetoCompra: item.objetoCompra ?? '',
    modalidadeId: item.modalidadeId ?? null,
    modalidadeNome: item.modalidadeNome ?? null,
    situacaoCompraNome: item.situacaoCompraNome ?? null,
    valorTotalEstimado: item.valorTotalEstimado ?? null,
    dataPublicacaoPncp: item.dataPublicacaoPncp ?? null,
    dataAberturaProposta: item.dataAberturaProposta ?? null,
    dataEncerramentoProposta: item.dataEncerramentoProposta ?? null,
    dataAtualizacaoGlobal: item.dataAtualizacaoGlobal ?? item.dataAtualizacao ?? null,
    orgao: item.orgaoEntidade?.razaoSocial ?? null,
    cnpj,
    unidade: item.unidadeOrgao?.nomeUnidade ?? null,
    uf: item.unidadeOrgao?.ufSigla ?? null,
    municipio: item.unidadeOrgao?.municipioNome ?? null,
    anoCompra: item.anoCompra ?? null,
    sequencialCompra: item.sequencialCompra ?? null,
    amparoLegal: item.amparoLegal?.nome ?? null,
    linkSistemaOrigem: normalizarLink(item.linkSistemaOrigem),
    linkPncp: temLink ? `https://pncp.gov.br/app/editais/${cnpj}/${item.anoCompra}/${item.sequencialCompra}` : null,
    tags,
  };
}

async function carregarExistentes() {
  try {
    const lista = JSON.parse(await readFile(ARQ_DADOS, 'utf8'));
    if (!Array.isArray(lista)) throw new Error('conteúdo não é um array');
    return lista;
  } catch (erro) {
    if (erro.code !== 'ENOENT') log(`aviso: não foi possível ler ${path.relative(RAIZ, ARQ_DADOS)} (${erro.message}); começando do zero`);
    return [];
  }
}

/**
 * Mescla a base existente com os coletados:
 * - reaplica as palavras-chave atuais à base (mudanças em keywords.json valem retroativamente);
 * - descarta registros com mais de RETENCAO_DIAS;
 * - deduplica por numeroControlePNCP, prevalecendo o registro mais novo;
 * - ordena por dataPublicacaoPncp decrescente.
 */
function mesclar(existentes, coletados, palavras, hoje) {
  const limite = somarDias(hoje, -RETENCAO_DIAS).toISOString();
  const limiteReprovados = somarDias(hoje, -IA_DESCARTAR_N_DIAS).toISOString();
  const mapa = new Map();
  let removidosAntigos = 0;
  let removidosFiltro = 0;
  let removidosReprovados = 0;

  for (const r of existentes) {
    if (!r?.numeroControlePNCP) continue;
    if ((r.dataPublicacaoPncp ?? '') < limite) { removidosAntigos++; continue; }
    // Reprovados pela IA ficam um tempo (para não serem reclassificados a cada coleta) e depois saem.
    if (r.ia === 'N' && (r.dataPublicacaoPncp ?? '') < limiteReprovados) { removidosReprovados++; continue; }
    const tags = classificar(r.objetoCompra, palavras);
    if (!tags) { removidosFiltro++; continue; }
    mapa.set(r.numeroControlePNCP, { ...r, tags });
  }

  let novos = 0;
  let atualizados = 0;
  for (const r of coletados.values()) {
    if ((r.dataPublicacaoPncp ?? '') < limite) { removidosAntigos++; continue; }
    const atual = mapa.get(r.numeroControlePNCP);
    if (!atual) { novos++; mapa.set(r.numeroControlePNCP, r); continue; }
    const existenteMaisNovo = atual.dataAtualizacaoGlobal && r.dataAtualizacaoGlobal && r.dataAtualizacaoGlobal < atual.dataAtualizacaoGlobal;
    if (existenteMaisNovo) continue;
    // O veredito da IA é preservado: um item já avaliado nunca volta para a fila do modelo.
    const novo = atual.ia ? { ...r, ia: atual.ia } : r;
    if (JSON.stringify(atual) !== JSON.stringify(novo)) atualizados++;
    mapa.set(r.numeroControlePNCP, novo);
  }

  const lista = [...mapa.values()].sort(
    (a, b) => (b.dataPublicacaoPncp ?? '').localeCompare(a.dataPublicacaoPncp ?? '') || a.numeroControlePNCP.localeCompare(b.numeroControlePNCP),
  );
  return { lista, novos, atualizados, removidosAntigos, removidosFiltro, removidosReprovados };
}

/** Um registro por linha: diffs legíveis no git e arquivo compacto. */
function serializarLista(lista) {
  return lista.length ? `[\n${lista.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n';
}

// ---------------------------------------------------------------- coleta

/** Pagina uma (modalidade × janela) até o fim, filtrando página a página. */
async function coletarTarefa({ modalidade, janela }, palavras, coletados, contexto) {
  const parcial = { lidos: 0, selecionados: 0, paginas: 0 };
  let totalPaginas = null;
  for (let pagina = 1; ; pagina++) {
    const url = new URL(`${API_BASE}/contratacoes/publicacao`);
    url.search = new URLSearchParams({
      dataInicial: fmtAAAAMMDD(janela.de),
      dataFinal: fmtAAAAMMDD(janela.ate),
      codigoModalidadeContratacao: String(modalidade.codigo),
      pagina: String(pagina),
      tamanhoPagina: String(TAMANHO_PAGINA),
    }).toString();

    const corpo = await requisitar(url, contexto);
    const itens = Array.isArray(corpo?.data) ? corpo.data : [];
    if (itens.length === 0) break;

    parcial.paginas++;
    parcial.lidos += itens.length;
    for (const item of itens) {
      if (!item?.numeroControlePNCP) continue;
      const tags = classificar(item.objetoCompra, palavras);
      if (!tags) continue;
      parcial.selecionados++;
      coletados.set(item.numeroControlePNCP, projetar(item, tags));
    }

    totalPaginas = corpo.totalPaginas ?? totalPaginas;
    if ((corpo.paginasRestantes ?? 0) <= 0) break;
    if (totalPaginas != null && pagina >= totalPaginas) break;
    if (pagina % 25 === 0) log(`  [${modalidade.nome} ${fmtISO(janela.de)}..${fmtISO(janela.ate)}] página ${pagina}/${totalPaginas ?? '?'} · ${parcial.selecionados} selecionados`);
  }
  return parcial;
}

async function executarEmParalelo(itens, limite, fn) {
  let indice = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (indice < itens.length) await fn(itens[indice++]);
  });
  await Promise.all(trabalhadores);
}

// ---------------------------------------------------------------- classificação por IA

/**
 * Segunda peneira: o modelo recebe só os itens que passaram pelas palavras-chave e ainda não têm
 * o campo "ia" (S = sim, N = não, D = dúvida), em lotes, e responde um JSON mínimo. Sem a variável
 * ANTHROPIC_API_KEY nada é chamado e os itens ficam "pendente". A chave só vive em memória.
 *
 * API: POST https://api.anthropic.com/v1/messages (Messages API). Cabeçalhos x-api-key,
 * anthropic-version e content-type. Resposta: content[] (blocos; lê-se só os de type "text"),
 * stop_reason e usage.input_tokens / usage.output_tokens.
 * O claude-haiku-5-5 rejeita (400) temperature diferente do padrão; para uma resposta estável e
 * barata usa-se thinking desligado e effort "low".
 */
const IA_PROMPT_SISTEMA = `Você recebe uma lista numerada de objetos de contratações públicas brasileiras (modalidade, órgão e descrição do objeto). Para cada item, decida se é uma oportunidade real de trabalho para uma profissional formada em artes visuais: criação artística, curadoria, exposições, oficinas de arte, ilustração, design gráfico, murais, cenografia, restauro e conservação de obras ou acervos artísticos, arte-educação, mediação cultural, produção cultural.

Responda S (sim), N (não) ou D (dúvida, quando o objeto é vago demais para decidir).

Muitos itens chegaram por uma palavra-chave usada em outro sentido; esses recebem N. Exemplos de N: "exposição a agentes químicos", "acervo bibliográfico", "design de software", "restauração de pavimento", "serigrafia industrial para uniformes", "manutenção do ar-condicionado do museu".

Responda apenas com um JSON em uma única linha mapeando o número de cada item à letra, por exemplo {"1":"S","2":"N","3":"D"}. Inclua todos os números. Sem explicações, sem texto fora do JSON.`;

function montarLote(itens) {
  return itens
    .map((r, i) => {
      const objeto = String(r.objetoCompra ?? '').replace(/\s+/g, ' ').trim().slice(0, IA_TRUNCAR_OBJETO);
      return `${i + 1}. [${r.modalidadeNome ?? 'modalidade não informada'}] ${r.orgao ?? 'órgão não informado'}: ${objeto}`;
    })
    .join('\n');
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

async function chamarModelo(chave, lote, ia) {
  const corpo = {
    model: IA_MODELO,
    max_tokens: lote.length * IA_TOKENS_POR_ITEM + IA_MARGEM_TOKENS,
    system: IA_PROMPT_SISTEMA,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: montarLote(lote) }],
  };
  for (let tentativa = 1; ; tentativa++) {
    ia.requisicoes++;
    try {
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

/** Marca em cada item da lista o campo "ia". Devolve as estatísticas para o meta.json. */
async function classificarPorIA(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const ia = {
    modelo: IA_MODELO,
    ativo: Boolean(chave),
    classificados: 0, aprovados: 0, reprovados: 0, duvidas: 0, pendentes: 0,
    lotes: 0, lotesFalhos: 0, requisicoes: 0,
    tokensEntrada: 0, tokensSaida: 0, custoUsd: 0,
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
      const v = respostas ? String(respostas[String(idx + 1)] ?? '').trim().toUpperCase() : '';
      if (v === 'S' || v === 'N' || v === 'D') {
        r.ia = v;
        ia.classificados++;
        if (v === 'S') ia.aprovados++;
        else if (v === 'N') ia.reprovados++;
        else ia.duvidas++;
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

// ---------------------------------------------------------------- principal

async function main() {
  const args = lerArgumentos(process.argv.slice(2));
  configurarRitmo(args.intervalo);
  const inicioExecucao = Date.now();
  const hoje = hojeUTC();
  const fim = args.ate ?? hoje;
  const inicio = somarDias(fim, -args.dias);

  const palavras = await carregarPalavras();
  const existentes = await carregarExistentes();

  log(`Período: ${fmtISO(inicio)} a ${fmtISO(fim)} (--dias ${args.dias}) · ${MODALIDADES.length} modalidades · intervalo ${args.intervalo} ms · paralelo ${args.paralelo}`);
  log(`Palavras-chave: ${palavras.incluir.length} para incluir, ${palavras.excluir.length} para excluir · base existente: ${existentes.length} registros`);
  log(`Estimativa: a API sustenta ~${Math.round(60_000 / Math.max(args.intervalo, 1))} requisições/min; cada dia tem em torno de 120 páginas somando as modalidades.`);

  const tarefas = [];
  if (args.soIa) log('Modo --so-ia: o PNCP não será consultado.');
  else for (const modalidade of MODALIDADES) for (const janela of janelas(inicio, fim)) tarefas.push({ modalidade, janela });

  const contexto = { requisicoes: 0 };
  const erros = [];
  const porModalidade = new Map(MODALIDADES.map((m) => [m.codigo, { ...m, lidos: 0, selecionados: 0, paginas: 0, falhas: 0 }]));
  const coletados = new Map();

  await executarEmParalelo(tarefas, args.paralelo, async (tarefa) => {
    const stats = porModalidade.get(tarefa.modalidade.codigo);
    const rotulo = `[${tarefa.modalidade.nome} ${fmtISO(tarefa.janela.de)}..${fmtISO(tarefa.janela.ate)}]`;
    try {
      const parcial = await coletarTarefa(tarefa, palavras, coletados, contexto);
      stats.lidos += parcial.lidos;
      stats.selecionados += parcial.selecionados;
      stats.paginas += parcial.paginas;
      log(`${rotulo} ${parcial.paginas} páginas, ${parcial.lidos} lidos, ${parcial.selecionados} selecionados`);
    } catch (erro) {
      // Nunca aborta a execução inteira: registra e segue para as demais tarefas.
      stats.falhas++;
      const mensagem = descreverErro(erro);
      erros.push({ modalidade: tarefa.modalidade.nome, de: fmtISO(tarefa.janela.de), ate: fmtISO(tarefa.janela.ate), erro: mensagem });
      log(`${rotulo} FALHOU: ${mensagem} — seguindo com as demais`);
    }
  });

  if (!args.soIa && erros.length === tarefas.length) {
    console.error('Todas as consultas falharam; nada foi gravado para não registrar uma atualização falsa.');
    process.exit(1);
  }

  const resultado = mesclar(existentes, coletados, palavras, hoje);
  const ia = await classificarPorIA(resultado.lista);
  const duracaoSegundos = Math.round((Date.now() - inicioExecucao) / 1000);

  const porVeredito = { S: 0, N: 0, D: 0, pendente: 0 };
  for (const r of resultado.lista) porVeredito[r.ia in porVeredito ? r.ia : 'pendente']++;

  const meta = {
    atualizadoEm: new Date().toISOString(),
    total: resultado.lista.length,
    totalNovos: resultado.novos,
    totalAtualizados: resultado.atualizados,
    removidos: { antigos: resultado.removidosAntigos, foraDoFiltro: resultado.removidosFiltro, reprovadosIA: resultado.removidosReprovados },
    base: { aprovados: porVeredito.S, reprovados: porVeredito.N, duvidas: porVeredito.D, pendentes: porVeredito.pendente },
    ia: { ...ia, candidatosRegexNestaExecucao: coletados.size },
    periodo: { de: fmtISO(inicio), ate: fmtISO(fim), dias: args.dias },
    retencaoDias: RETENCAO_DIAS,
    requisicoes: contexto.requisicoes,
    bloqueios429: ritmo.bloqueios,
    duracaoSegundos,
    modalidades: [...porModalidade.values()],
    erros,
  };

  await mkdir(PASTA_DADOS, { recursive: true });
  await writeFile(ARQ_DADOS, serializarLista(resultado.lista), 'utf8');
  await writeFile(ARQ_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  // ------------------------------------------------------------ resumo
  const linha = '─'.repeat(60);
  const duracaoTexto = duracaoSegundos >= 90 ? `${Math.round(duracaoSegundos / 60)} min` : `${duracaoSegundos} s`;
  console.log(`\n${linha}\nRESUMO · ${meta.periodo.de} a ${meta.periodo.ate} · ${duracaoTexto} · ${contexto.requisicoes} requisições · ${ritmo.bloqueios} bloqueios 429\n${linha}`);
  for (const m of meta.modalidades) {
    console.log(`  ${m.nome.padEnd(24)} ${String(m.lidos).padStart(7)} lidos  ${String(m.selecionados).padStart(5)} selecionados${m.falhas ? `  (${m.falhas} janela(s) com falha)` : ''}`);
  }
  console.log(linha);
  console.log(`  Novos: ${resultado.novos} · Atualizados: ${resultado.atualizados} · Removidos: ${resultado.removidosAntigos} antigos, ${resultado.removidosFiltro} fora do filtro, ${resultado.removidosReprovados} reprovados antigos`);
  console.log(`  Palavras-chave aprovaram ${coletados.size} itens nesta execução`);
  if (ia.ativo) {
    console.log(`  IA (${ia.modelo}): ${ia.classificados} classificados → ${ia.aprovados} S · ${ia.reprovados} N · ${ia.duvidas} D · ${ia.pendentes} pendentes${ia.lotesFalhos ? ` · ${ia.lotesFalhos} lote(s) com falha` : ''}`);
    console.log(`  IA: ${ia.requisicoes} requisições · ${ia.tokensEntrada} tokens de entrada · ${ia.tokensSaida} de saída · custo estimado US$ ${ia.custoUsd.toFixed(4)}`);
  } else {
    console.log(`  IA: desligada (ANTHROPIC_API_KEY ausente) · ${ia.pendentes} itens pendentes`);
  }
  console.log(`  Base final: ${meta.total} registros (${porVeredito.S} S · ${porVeredito.N} N · ${porVeredito.D} D · ${porVeredito.pendente} pendentes) → ${path.relative(RAIZ, ARQ_DADOS)}`);
  if (erros.length) {
    console.log(`  Falhas (${erros.length}):`);
    for (const e of erros) console.log(`    - ${e.modalidade} ${e.de}..${e.ate}: ${e.erro}`);
  }
  console.log(linha);
}

main().catch((erro) => {
  console.error(`Erro fatal: ${descreverErro(erro)}`);
  process.exit(1);
});
