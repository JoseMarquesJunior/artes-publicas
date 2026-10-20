/**
 * Funde os arquivos de dados gerados por uma execução (pasta "novo") com os que já estão no repositório
 * (pasta "base", normalmente docs/data), registro a registro, e grava o resultado na pasta base.
 *
 * Por que existe: o workflow do GitHub e a coleta local (tarefa agendada) commitam docs/data de forma
 * independente. Quando os dois rodam ao mesmo tempo, um "git pull --rebase -X theirs" resolve o conflito
 * linha a linha e descarta registros de um dos lados (aconteceu em 2026-10-20: 51 itens da coleta local
 * sumiram). Aqui a fusão é por id: ninguém perde registro.
 *
 * Regras:
 *   oportunidades.json  — união por id. Para o mesmo id, vence o registro já avaliado pela IA (S/N/D) sobre
 *                         o pendente; empate → o da execução nova (coleta mais recente). Ids que constam em
 *                         _duplicados.json (perdedores de deduplicação) ficam de fora.
 *                         Com a pasta "origem" (a base que a execução leu, antes de rodar): um registro que
 *                         estava na origem e não está no novo foi removido de propósito (retenção, reprovado
 *                         antigo, deduplicação) e só volta se a base atual o tiver alterado nesse meio-tempo.
 *   _duplicados.json    — união das chaves.
 *   _descartados-qd.json — união por (fonte, idNaFonte).
 *   meta.json           — o da execução nova, com "total" recalculado e "fundidoCom" apontando a base.
 *
 * Uso: node scripts/fundir-dados.mjs <pasta-novo> <pasta-base> [<pasta-origem>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [novoDir, baseDir, origemDir] = process.argv.slice(2);
if (!novoDir || !baseDir) { console.error('uso: node scripts/fundir-dados.mjs <pasta-novo> <pasta-base> [<pasta-origem>]'); process.exit(2); }

async function lerJson(caminho, padrao) {
  try { return JSON.parse(await readFile(caminho, 'utf8')); } catch { return padrao; }
}
const serializarLista = (lista) => (lista.length ? `[\n${lista.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n');
const avaliado = (r) => ['S', 'N', 'D'].includes(r?.ia);

const [novo, base] = await Promise.all([lerJson(join(novoDir, 'oportunidades.json'), []), lerJson(join(baseDir, 'oportunidades.json'), [])]);
const origem = origemDir ? await lerJson(join(origemDir, 'oportunidades.json'), null) : null;
const [dupNovo, dupBase] = await Promise.all([lerJson(join(novoDir, '_duplicados.json'), {}), lerJson(join(baseDir, '_duplicados.json'), {})]);
const [descNovo, descBase] = await Promise.all([lerJson(join(novoDir, '_descartados-qd.json'), []), lerJson(join(baseDir, '_descartados-qd.json'), [])]);
const metaNovo = await lerJson(join(novoDir, 'meta.json'), null);
const metaBase = await lerJson(join(baseDir, 'meta.json'), null);

const duplicados = { ...dupBase, ...dupNovo };
const idsNovo = new Set(novo.map((r) => r?.id).filter(Boolean));
const origemPorId = origem ? new Map(origem.filter((r) => r?.id).map((r) => [r.id, JSON.stringify(r)])) : null;
const mapa = new Map();
let removidosMantidos = 0;
for (const r of base) {
  if (!r?.id || duplicados[r.id]) continue;
  if (origemPorId && !idsNovo.has(r.id) && origemPorId.has(r.id)) {
    // A execução leu este registro e o removeu de propósito. Só volta se alguém o alterou na base desde então.
    if (origemPorId.get(r.id) === JSON.stringify(r)) { removidosMantidos++; continue; }
  }
  mapa.set(r.id, r);
}
let acrescentados = 0;
let substituidos = 0;
for (const r of novo) {
  if (!r?.id || duplicados[r.id]) continue;
  const atual = mapa.get(r.id);
  if (!atual) { mapa.set(r.id, r); acrescentados++; continue; }
  if (avaliado(atual) && !avaliado(r)) continue; // a base já tem o veredito; a execução nova só recoletou
  if (JSON.stringify(atual) !== JSON.stringify(r)) substituidos++;
  mapa.set(r.id, r);
}
const lista = [...mapa.values()].sort((a, b) => (b.publicadoEm ?? b.coletadoEm ?? '').localeCompare(a.publicadoEm ?? a.coletadoEm ?? '') || a.id.localeCompare(b.id));

const chaveDesc = (d) => `${d.fonte ?? 'querido-diario'}|${d.idNaFonte}`;
const descartados = [...new Map([...descBase, ...descNovo].map((d) => [chaveDesc(d), d])).values()];

const meta = metaNovo ?? metaBase ?? {};
if (metaNovo) {
  meta.total = lista.length;
  // Contagens da base refletem a lista fundida, não só a visão da execução.
  const porVeredito = { S: 0, N: 0, D: 0, pendente: 0 };
  for (const r of lista) porVeredito[['S', 'N', 'D'].includes(r.ia) ? r.ia : 'pendente']++;
  meta.base = { aprovados: porVeredito.S, reprovados: porVeredito.N, duvidas: porVeredito.D, pendentes: porVeredito.pendente };
  meta.fundidoCom = { atualizadoEm: metaBase?.atualizadoEm ?? null, registrosDaBase: base.length, acrescentados, substituidos, removidosMantidos, comOrigem: Boolean(origem) };
}

await writeFile(join(baseDir, 'oportunidades.json'), serializarLista(lista), 'utf8');
await writeFile(join(baseDir, '_duplicados.json'), `${JSON.stringify(duplicados, null, 0)}\n`, 'utf8');
await writeFile(join(baseDir, '_descartados-qd.json'), serializarLista(descartados), 'utf8');
if (metaNovo) await writeFile(join(baseDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`fundir-dados: base ${base.length} + novo ${novo.length} → ${lista.length} registros (${acrescentados} acrescentados, ${substituidos} substituídos, ${removidosMantidos} remoções da execução mantidas${origem ? '' : '; sem pasta de origem'}) · ${Object.keys(duplicados).length} duplicados conhecidos · ${descartados.length} descartados`);
