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

const USO = `Uso: node scripts/fetch.mjs [--dias N] [--ate AAAA-MM-DD] [--intervalo MS] [--paralelo N]
  --dias N         quantos dias para trás buscar a partir de --ate (padrão 2)
  --ate AAAA-MM-DD data final do período (padrão: hoje). Útil para dividir a carga inicial em partes
  --intervalo MS   espera mínima entre requisições (padrão ${INTERVALO_MS}; a API bloqueia com menos que isso)
  --paralelo N     tarefas simultâneas (padrão ${PARALELO_PADRAO}; o limite da API é por IP, então não acelera)

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
  const args = { dias: 2, ate: null, intervalo: INTERVALO_MS, paralelo: PARALELO_PADRAO };
  const minimos = { dias: 0, intervalo: 0, paralelo: 1 };
  for (let i = 0; i < argv.length; i++) {
    let [chave, valor] = argv[i].split('=', 2);
    if (chave === '--help' || chave === '-h') {
      console.log(USO);
      process.exit(0);
    }
    const nome = chave.startsWith('--') ? chave.slice(2) : '';
    if (!(nome in args)) throw new Error(`Argumento desconhecido: ${argv[i]}\n${USO}`);
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

/** Compila cada palavra num regex que exige início de palavra ('curador' não casa com 'procurador'). */
function compilarPalavras(lista, nome) {
  if (!Array.isArray(lista)) throw new Error(`keywords.json: a lista "${nome}" precisa ser um array`);
  return lista
    .map((p) => String(p))
    .filter((p) => normalizar(p).length > 0)
    .map((original) => ({ original, regex: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaparRegex(normalizar(original))}`, 'u') }));
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
  const mapa = new Map();
  let removidosAntigos = 0;
  let removidosFiltro = 0;

  for (const r of existentes) {
    if (!r?.numeroControlePNCP) continue;
    if ((r.dataPublicacaoPncp ?? '') < limite) { removidosAntigos++; continue; }
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
    if (JSON.stringify(atual) !== JSON.stringify(r)) atualizados++;
    mapa.set(r.numeroControlePNCP, r);
  }

  const lista = [...mapa.values()].sort(
    (a, b) => (b.dataPublicacaoPncp ?? '').localeCompare(a.dataPublicacaoPncp ?? '') || a.numeroControlePNCP.localeCompare(b.numeroControlePNCP),
  );
  return { lista, novos, atualizados, removidosAntigos, removidosFiltro };
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
  for (const modalidade of MODALIDADES) for (const janela of janelas(inicio, fim)) tarefas.push({ modalidade, janela });

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

  if (erros.length === tarefas.length) {
    console.error('Todas as consultas falharam; nada foi gravado para não registrar uma atualização falsa.');
    process.exit(1);
  }

  const resultado = mesclar(existentes, coletados, palavras, hoje);
  const duracaoSegundos = Math.round((Date.now() - inicioExecucao) / 1000);

  const meta = {
    atualizadoEm: new Date().toISOString(),
    total: resultado.lista.length,
    totalNovos: resultado.novos,
    totalAtualizados: resultado.atualizados,
    removidos: { antigos: resultado.removidosAntigos, foraDoFiltro: resultado.removidosFiltro },
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
  console.log(`  Novos: ${resultado.novos} · Atualizados: ${resultado.atualizados} · Removidos: ${resultado.removidosAntigos} antigos, ${resultado.removidosFiltro} fora do filtro`);
  console.log(`  Base final: ${meta.total} registros → ${path.relative(RAIZ, ARQ_DADOS)}`);
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
