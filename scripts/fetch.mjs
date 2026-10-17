#!/usr/bin/env node
/**
 * Orquestrador: roda cada fonte listada em scripts/fontes.json, concatena, mescla com a base existente,
 * classifica com IA, deduplica entre fontes e grava docs/data/oportunidades.json + docs/data/meta.json.
 *
 * Uso:
 *   node scripts/fetch.mjs                  # PNCP: últimos 2 dias; Mapas: inscrições encerrando de 7 dias atrás em diante
 *   node scripts/fetch.mjs --dias 30        # primeira carga do PNCP (≈ 2 h pelo limite da API)
 *   node scripts/fetch.mjs --so-ia          # não consulta fontes; só classifica os pendentes
 *   node scripts/fetch.mjs --fontes pncp,mapas:bh
 *
 * Só Node 20, fetch nativo, zero pacotes npm.
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log, hojeUTC, somarDias, fmtISO, lerDataISO, descreverErro, carregarPalavras, normalizar, palavrasDe, jaccard } from './util.mjs';
import * as pncp from './fontes/pncp.mjs';
import * as mapas from './fontes/mapas.mjs';
import { classificar } from './classificar.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const PASTA_DADOS = path.join(RAIZ, 'docs', 'data');
const ARQ_DADOS = path.join(PASTA_DADOS, 'oportunidades.json');
const ARQ_ANTIGO = path.join(PASTA_DADOS, 'contratacoes.json'); // esquema anterior; migrado uma única vez
const ARQ_META = path.join(PASTA_DADOS, 'meta.json');
const ARQ_DUPLICADOS = path.join(PASTA_DADOS, '_duplicados.json'); // {idPerdedor: idVencedor}, para não reclassificar duplicatas
const ARQ_PALAVRAS = path.join(AQUI, 'keywords.json');
const ARQ_FONTES = path.join(AQUI, 'fontes.json');

const RETENCAO_DIAS = 365;        // registros mais antigos saem da base
const DESCARTAR_N_DIAS = 30;      // reprovados pela IA saem depois de N dias
const DEDUP_SIMILARIDADE = 0.5;   // Jaccard mínimo entre títulos para considerar duplicata

const ADAPTADORES = { pncp, mapas };

const USO = `Uso: node scripts/fetch.mjs [--dias N] [--ate AAAA-MM-DD] [--intervalo MS] [--paralelo N] [--fontes a,b] [--so-ia]
  --dias N         PNCP: quantos dias para trás buscar a partir de --ate (padrão 2)
  --ate AAAA-MM-DD PNCP: data final do período (padrão: hoje). Útil para dividir a carga inicial em partes
  --intervalo MS   PNCP: espera mínima entre requisições (padrão ${pncp.INTERVALO_PADRAO_MS}; a API bloqueia com menos)
  --paralelo N     PNCP: tarefas simultâneas (padrão ${pncp.PARALELO_PADRAO})
  --fontes a,b     roda só estas fontes (nomes de scripts/fontes.json)
  --so-ia          não consulta nenhuma fonte; só classifica com IA os itens pendentes da base

Classificação por IA: exige a variável de ambiente ANTHROPIC_API_KEY. Sem ela, os itens novos ficam "pendente".`;

// ---------------------------------------------------------------- argumentos

function lerArgumentos(argv) {
  const args = { dias: 2, ate: null, intervalo: pncp.INTERVALO_PADRAO_MS, paralelo: pncp.PARALELO_PADRAO, fontes: null, soIa: false };
  const minimos = { dias: 0, intervalo: 0, paralelo: 1 };
  for (let i = 0; i < argv.length; i++) {
    let [chave, valor] = argv[i].split('=', 2);
    if (chave === '--help' || chave === '-h') { console.log(USO); process.exit(0); }
    if (chave === '--so-ia') { args.soIa = true; continue; }
    const nome = chave.startsWith('--') ? chave.slice(2) : '';
    if (!(nome in minimos) && nome !== 'ate' && nome !== 'fontes') throw new Error(`Argumento desconhecido: ${argv[i]}\n${USO}`);
    if (valor === undefined) valor = argv[++i];
    if (nome === 'ate') {
      args.ate = lerDataISO(String(valor ?? ''));
      if (!args.ate) throw new Error(`Valor inválido para --ate (use AAAA-MM-DD): ${valor}`);
      continue;
    }
    if (nome === 'fontes') { args.fontes = String(valor ?? '').split(',').map((s) => s.trim()).filter(Boolean); continue; }
    const n = Number(valor);
    if (!Number.isInteger(n) || n < minimos[nome]) throw new Error(`Valor inválido para ${chave}: ${valor}`);
    args[nome] = n;
  }
  return args;
}

// ---------------------------------------------------------------- base existente

async function lerJson(caminho, padrao) {
  try {
    return JSON.parse(await readFile(caminho, 'utf8'));
  } catch (erro) {
    if (erro.code !== 'ENOENT') log(`aviso: não foi possível ler ${path.relative(RAIZ, caminho)} (${erro.message}); usando padrão`);
    return padrao;
  }
}

/** Lê oportunidades.json; se não existir mas o antigo contratacoes.json existir, migra uma única vez. */
async function carregarExistentes() {
  const atual = await lerJson(ARQ_DADOS, null);
  if (Array.isArray(atual)) return { lista: atual, migrados: 0 };
  const antigo = await lerJson(ARQ_ANTIGO, null);
  if (!Array.isArray(antigo)) return { lista: [], migrados: 0 };
  const lista = antigo.filter((r) => r?.numeroControlePNCP).map(pncp.migrarRegistroAntigo);
  log(`Migração: ${lista.length} registros de contratacoes.json convertidos para o esquema unificado`);
  return { lista, migrados: lista.length };
}

/** Reaplica o filtro de palavras-chave de acordo com a fonte do registro. */
function refiltrar(registro, palavras) {
  const adaptador = registro.fonte.startsWith('mapas') ? mapas : registro.fonte === 'pncp' ? pncp : null;
  return adaptador ? adaptador.filtrar(registro, palavras) : registro.tags ?? [];
}

/**
 * Mescla a base existente com os coletados:
 * - reaplica as palavras-chave atuais; descarta antigos (> RETENCAO_DIAS) e reprovados antigos (> DESCARTAR_N_DIAS);
 * - deduplica por id (fonte + idNaFonte), prevalecendo o registro mais novo e preservando o veredito da IA;
 * - descarta duplicatas entre fontes já fundidas em execuções anteriores (ARQ_DUPLICADOS).
 */
function mesclar(existentes, coletados, palavras, hoje, duplicadosConhecidos) {
  const limite = somarDias(hoje, -RETENCAO_DIAS).toISOString();
  const limiteReprovados = somarDias(hoje, -DESCARTAR_N_DIAS).toISOString();
  const dataRef = (r) => r.publicadoEm ?? r.coletadoEm ?? '';
  const mapa = new Map();
  const removidos = { antigos: 0, foraDoFiltro: 0, reprovadosAntigos: 0, duplicadosConhecidos: 0 };

  for (const r of existentes) {
    if (!r?.id) continue;
    if (dataRef(r) < limite) { removidos.antigos++; continue; }
    if (r.ia === 'N' && dataRef(r) < limiteReprovados) { removidos.reprovadosAntigos++; continue; }
    const tags = refiltrar(r, palavras);
    if (!tags) { removidos.foraDoFiltro++; continue; }
    mapa.set(r.id, { ...r, tags });
  }

  const novosPorFonte = {};
  let atualizados = 0;
  for (const r of coletados) {
    if (dataRef(r) < limite) { removidos.antigos++; continue; }
    if (duplicadosConhecidos[r.id] && (mapa.has(duplicadosConhecidos[r.id]) || coletados.some((c) => c.id === duplicadosConhecidos[r.id]))) {
      removidos.duplicadosConhecidos++;
      continue;
    }
    const atual = mapa.get(r.id);
    if (!atual) { novosPorFonte[r.fonte] = (novosPorFonte[r.fonte] ?? 0) + 1; mapa.set(r.id, r); continue; }
    const a = atual.detalhes?.atualizadoNaFonte;
    const b = r.detalhes?.atualizadoNaFonte;
    if (a && b && b < a) continue; // o existente é mais novo
    const novo = {
      ...r,
      ia: ['S', 'N', 'D'].includes(atual.ia) ? atual.ia : r.ia,
      categoriaIA: atual.categoriaIA ?? r.categoriaIA ?? null,
      linksExtras: [...new Set([...(atual.linksExtras ?? []), ...(r.linksExtras ?? [])])],
      coletadoEm: atual.coletadoEm ?? r.coletadoEm,
    };
    if (JSON.stringify(atual) !== JSON.stringify(novo)) atualizados++;
    mapa.set(r.id, novo);
  }

  return { lista: [...mapa.values()], novosPorFonte, atualizados, removidos };
}

// ---------------------------------------------------------------- deduplicação entre fontes

const camposPreenchidos = (r) => Object.values(r).filter((v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)).length;
const PRIORIDADE_FONTE = (r) => (r.fonte === 'pncp' || r.fonte.startsWith('mapas') ? 1 : 0); // dados estruturados vencem (Fase B: querido-diario = 0)

/**
 * Funde registros de FONTES DIFERENTES que parecem ser o mesmo edital: títulos similares (Jaccard >= DEDUP_SIMILARIDADE)
 * e, além disso, mesmo órgão normalizado OU mesma data de encerramento; encerramentos diferentes (ambos informados) impedem a fusão.
 * Só considera itens com ia != "N". O vencedor é a fonte estruturada e, em empate, o registro com mais campos preenchidos;
 * o link do perdedor vai para linksExtras do vencedor.
 */
function deduplicar(lista, duplicadosConhecidos) {
  const candidatos = lista.filter((r) => r.ia !== 'N');
  const info = new Map(candidatos.map((r) => [r.id, { palavras: palavrasDe(r.titulo), orgao: normalizar(r.orgao ?? ''), enc: r.encerramento ? r.encerramento.slice(0, 10) : null }]));
  const removidos = new Set();
  let fundidos = 0;

  for (let i = 0; i < candidatos.length; i++) {
    const a = candidatos[i];
    if (removidos.has(a.id)) continue;
    const ia = info.get(a.id);
    for (let j = i + 1; j < candidatos.length; j++) {
      const b = candidatos[j];
      if (removidos.has(b.id) || a.fonte === b.fonte) continue;
      const ib = info.get(b.id);
      if (ia.enc && ib.enc && ia.enc !== ib.enc) continue;
      if (a.uf && b.uf && a.uf !== b.uf) continue;
      const mesmoOrgao = ia.orgao && ia.orgao === ib.orgao;
      const mesmoPrazo = ia.enc && ia.enc === ib.enc;
      if (!mesmoOrgao && !mesmoPrazo) continue;
      if (jaccard(ia.palavras, ib.palavras) < DEDUP_SIMILARIDADE) continue;

      let vencedor = a;
      let perdedor = b;
      const pa = PRIORIDADE_FONTE(a) * 1000 + camposPreenchidos(a);
      const pb = PRIORIDADE_FONTE(b) * 1000 + camposPreenchidos(b);
      if (pb > pa) { vencedor = b; perdedor = a; }
      vencedor.linksExtras = [...new Set([...vencedor.linksExtras, perdedor.link, ...perdedor.linksExtras])].filter((l) => l !== vencedor.link);
      if (!['S', 'N', 'D'].includes(vencedor.ia) && ['S', 'D'].includes(perdedor.ia)) { vencedor.ia = perdedor.ia; vencedor.categoriaIA = perdedor.categoriaIA; }
      removidos.add(perdedor.id);
      duplicadosConhecidos[perdedor.id] = vencedor.id;
      fundidos++;
      if (perdedor === a) break;
    }
  }
  return { lista: lista.filter((r) => !removidos.has(r.id)), fundidos };
}

// ---------------------------------------------------------------- principal

function serializarLista(lista) {
  return lista.length ? `[\n${lista.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n';
}

async function main() {
  const args = lerArgumentos(process.argv.slice(2));
  const inicioExecucao = Date.now();
  const hoje = hojeUTC();

  const palavras = await carregarPalavras(ARQ_PALAVRAS);
  const config = JSON.parse(await readFile(ARQ_FONTES, 'utf8'));
  const { lista: existentes, migrados } = await carregarExistentes();
  const duplicadosConhecidos = await lerJson(ARQ_DUPLICADOS, {});

  const fontes = (config.fontes ?? []).filter((f) => f.ativo !== false && (!args.fontes || args.fontes.includes(f.fonte)));
  log(`Fontes ativas: ${fontes.map((f) => f.fonte).join(', ') || 'nenhuma'} · palavras-chave: ${palavras.incluir.length} incluir / ${palavras.excluir.length} excluir · base: ${existentes.length} registros`);
  if (args.soIa) log('Modo --so-ia: nenhuma fonte será consultada.');

  // 1. Coleta, fonte a fonte. A falha de uma nunca derruba as outras.
  const coletados = [];
  const erros = [];
  const statsFontes = [];
  for (const fonte of args.soIa ? [] : fontes) {
    const adaptador = ADAPTADORES[fonte.tipo];
    const stat = { fonte: fonte.fonte, nome: fonte.nome ?? fonte.fonte, tipo: fonte.tipo, lidos: 0, candidatos: 0, requisicoes: 0, erro: null };
    try {
      if (!adaptador) throw new Error(`tipo de fonte desconhecido: ${fonte.tipo}`);
      const resultado = fonte.tipo === 'pncp'
        ? await adaptador.coletar({ dias: args.dias, ate: args.ate, intervalo: args.intervalo, paralelo: args.paralelo, palavras })
        : await adaptador.coletar({ instancia: fonte, palavras });
      coletados.push(...resultado.registros);
      Object.assign(stat, resultado.stats, { candidatos: resultado.registros.length });
      if (resultado.stats.erros?.length) erros.push(...resultado.stats.erros.map((e) => ({ fonte: fonte.fonte, mensagem: `${e.janela}: ${e.mensagem}` })));
    } catch (erro) {
      stat.erro = descreverErro(erro);
      erros.push({ fonte: fonte.fonte, mensagem: stat.erro });
      log(`[${fonte.fonte}] FALHOU: ${stat.erro} — seguindo com as demais fontes`);
    }
    statsFontes.push(stat);
  }

  if (!args.soIa && fontes.length && statsFontes.every((s) => s.erro)) {
    console.error('Todas as fontes falharam; nada foi gravado para não registrar uma atualização falsa.');
    process.exit(1);
  }

  // 2. Mescla, 3. IA, 4. deduplicação, 5. ordenação
  const mesclado = mesclar(existentes, coletados, palavras, hoje, duplicadosConhecidos);
  const ia = await classificar(mesclado.lista);
  const dedup = deduplicar(mesclado.lista, duplicadosConhecidos);
  const lista = dedup.lista.sort((a, b) => (b.publicadoEm ?? b.coletadoEm ?? '').localeCompare(a.publicadoEm ?? a.coletadoEm ?? '') || a.id.localeCompare(b.id));
  for (const s of statsFontes) s.novos = mesclado.novosPorFonte[s.fonte] ?? 0;

  const porVeredito = { S: 0, N: 0, D: 0, pendente: 0 };
  const porTipo = {};
  const porFonte = {};
  for (const r of lista) {
    porVeredito[r.ia in porVeredito ? r.ia : 'pendente']++;
    (porTipo[r.tipo] ??= { total: 0, S: 0, N: 0, D: 0, pendente: 0 }).total++;
    porTipo[r.tipo][r.ia in porVeredito ? r.ia : 'pendente']++;
    (porFonte[r.fonte] ??= { total: 0, S: 0 }).total++;
    if (r.ia === 'S') porFonte[r.fonte].S++;
  }

  const duracaoSegundos = Math.round((Date.now() - inicioExecucao) / 1000);
  const totalNovos = Object.values(mesclado.novosPorFonte).reduce((s, n) => s + n, 0);
  const fontesMeta = (config.fontes ?? []).map((f) => ({
    fonte: f.fonte, nome: f.nome ?? f.fonte, tipo: f.tipo, ativo: f.ativo !== false, observacao: f.observacao ?? null,
    ...(statsFontes.find((s) => s.fonte === f.fonte) ?? {}),
    naBase: porFonte[f.fonte]?.total ?? 0, aprovadosNaBase: porFonte[f.fonte]?.S ?? 0,
  }));

  const meta = {
    atualizadoEm: new Date().toISOString(),
    total: lista.length,
    totalNovos,
    totalAtualizados: mesclado.atualizados,
    removidos: mesclado.removidos,
    migrados,
    base: { aprovados: porVeredito.S, reprovados: porVeredito.N, duvidas: porVeredito.D, pendentes: porVeredito.pendente },
    porTipo,
    fontes: fontesMeta,
    ia: { ...ia, candidatosNestaExecucao: coletados.length },
    dedup: { fundidosNestaExecucao: dedup.fundidos, duplicadosConhecidos: Object.keys(duplicadosConhecidos).length },
    periodoPncp: statsFontes.find((s) => s.fonte === 'pncp')?.periodo ?? null,
    retencaoDias: RETENCAO_DIAS,
    duracaoSegundos,
    erros,
  };

  await mkdir(PASTA_DADOS, { recursive: true });
  await writeFile(ARQ_DADOS, serializarLista(lista), 'utf8');
  await writeFile(ARQ_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await writeFile(ARQ_DUPLICADOS, `${JSON.stringify(duplicadosConhecidos, null, 0)}\n`, 'utf8');
  if (migrados) await unlink(ARQ_ANTIGO).catch(() => {});

  // ------------------------------------------------------------ resumo
  const linha = '─'.repeat(64);
  const duracaoTexto = duracaoSegundos >= 90 ? `${Math.round(duracaoSegundos / 60)} min` : `${duracaoSegundos} s`;
  console.log(`\n${linha}\nRESUMO · ${duracaoTexto}\n${linha}`);
  console.log('  Fontes nesta execução:');
  for (const s of statsFontes) {
    console.log(`    ${s.fonte.padEnd(26)} ${String(s.lidos).padStart(7)} lidos ${String(s.candidatos).padStart(6)} candidatos ${String(s.novos ?? 0).padStart(5)} novos ${String(s.requisicoes ?? 0).padStart(5)} req${s.erro ? `  ERRO: ${s.erro}` : ''}`);
  }
  if (ia.ativo) {
    console.log(`  IA (${ia.modelo}): ${ia.classificados} classificados → ${ia.aprovados} S · ${ia.reprovados} N · ${ia.duvidas} D · ${ia.pendentes} pendentes${ia.lotesFalhos ? ` · ${ia.lotesFalhos} lote(s) com falha` : ''}`);
    for (const [tipo, t] of Object.entries(ia.porTipo)) console.log(`    ${tipo.padEnd(14)} S ${t.S} · N ${t.N} · D ${t.D}`);
    console.log(`  IA: ${ia.requisicoes} requisições · ${ia.tokensEntrada} tokens de entrada · ${ia.tokensSaida} de saída · custo estimado US$ ${ia.custoUsd.toFixed(4)}`);
  } else {
    console.log(`  IA: desligada (ANTHROPIC_API_KEY ausente) · ${ia.pendentes} itens pendentes`);
  }
  console.log(`  Deduplicação entre fontes: ${dedup.fundidos} fundidos nesta execução (${Object.keys(duplicadosConhecidos).length} conhecidos)`);
  console.log(`  Removidos: ${mesclado.removidos.antigos} antigos · ${mesclado.removidos.foraDoFiltro} fora do filtro · ${mesclado.removidos.reprovadosAntigos} reprovados antigos · ${mesclado.removidos.duplicadosConhecidos} duplicatas conhecidas${migrados ? ` · migrados do esquema antigo: ${migrados}` : ''}`);
  console.log(`  Base final: ${lista.length} registros (${porVeredito.S} S · ${porVeredito.N} N · ${porVeredito.D} D · ${porVeredito.pendente} pendentes)`);
  for (const [tipo, t] of Object.entries(porTipo)) console.log(`    ${tipo.padEnd(14)} ${String(t.total).padStart(5)} total · ${t.S} aprovados`);
  if (erros.length) {
    console.log(`  Erros (${erros.length}):`);
    for (const e of erros.slice(0, 10)) console.log(`    - ${e.fonte}: ${e.mensagem}`);
  }
  console.log(`  → ${path.relative(RAIZ, ARQ_DADOS)}\n${linha}`);
}

main().catch((erro) => {
  console.error(`Erro fatal: ${descreverErro(erro)}`);
  process.exit(1);
});
