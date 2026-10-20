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
 *   _duplicados.json    — união das chaves.
 *   _descartados-qd.json — união por (fonte, idNaFonte).
 *   meta.json           — o da execução nova, com "total" recalculado e "fundidoCom" apontando a base.
 *
 * Uso: node scripts/fundir-dados.mjs <pasta-novo> <pasta-base>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [novoDir, baseDir] = process.argv.slice(2);
if (!novoDir || !baseDir) { console.error('uso: node scripts/fundir-dados.mjs <pasta-novo> <pasta-base>'); process.exit(2); }

async function lerJson(caminho, padrao) {
  try { return JSON.parse(await readFile(caminho, 'utf8')); } catch { return padrao; }
}
const serializarLista = (lista) => (lista.length ? `[\n${lista.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n');
const avaliado = (r) => ['S', 'N', 'D'].includes(r?.ia);

const [novo, base] = await Promise.all([lerJson(join(novoDir, 'oportunidades.json'), []), lerJson(join(baseDir, 'oportunidades.json'), [])]);
const [dupNovo, dupBase] = await Promise.all([lerJson(join(novoDir, '_duplicados.json'), {}), lerJson(join(baseDir, '_duplicados.json'), {})]);
const [descNovo, descBase] = await Promise.all([lerJson(join(novoDir, '_descartados-qd.json'), []), lerJson(join(baseDir, '_descartados-qd.json'), [])]);
const metaNovo = await lerJson(join(novoDir, 'meta.json'), null);
const metaBase = await lerJson(join(baseDir, 'meta.json'), null);

const duplicados = { ...dupBase, ...dupNovo };
const mapa = new Map();
for (const r of base) if (r?.id && !duplicados[r.id]) mapa.set(r.id, r);
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
  meta.fundidoCom = { atualizadoEm: metaBase?.atualizadoEm ?? null, registrosDaBase: base.length, acrescentados, substituidos };
}

await writeFile(join(baseDir, 'oportunidades.json'), serializarLista(lista), 'utf8');
await writeFile(join(baseDir, '_duplicados.json'), `${JSON.stringify(duplicados, null, 0)}\n`, 'utf8');
await writeFile(join(baseDir, '_descartados-qd.json'), serializarLista(descartados), 'utf8');
if (metaNovo) await writeFile(join(baseDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`fundir-dados: base ${base.length} + novo ${novo.length} → ${lista.length} registros (${acrescentados} acrescentados, ${substituidos} substituídos) · ${Object.keys(duplicados).length} duplicados conhecidos · ${descartados.length} descartados`);
