/**
 * Classificação por IA (segunda peneira, depois das palavras-chave).
 *
 * O modelo recebe só os itens sem veredito, em lotes, e responde por item [S|N|D, categoria].
 * Sem a variável ANTHROPIC_API_KEY nada é chamado e os itens ficam "pendente". A chave só vive em memória.
 *
 * API: POST https://api.anthropic.com/v1/messages (Messages API, versão 2023-06-01), fetch nativo, sem SDK.
 * Cabeçalhos x-api-key, anthropic-version, content-type. Resposta: content[] (lê-se só os blocos "text"),
 * stop_reason, usage.input_tokens / usage.output_tokens.
 * O claude-haiku-5-5 rejeita (400) temperature diferente do padrão; para resposta estável e barata
 * usa-se thinking desligado e effort "low".
 */
import { ErroHttp, descreverErro, dormir, log, normalizar, truncar, PARTICIPACOES } from './util.mjs';

export const IA_MODELO = 'claude-haiku-5-5';
const IA_URL = 'https://api.anthropic.com/v1/messages';
const IA_VERSAO = '2023-06-01';
const IA_LOTE = 30;
const IA_TRUNCAR_TEXTO = 600;
const IA_TOKENS_POR_ITEM = 16;        // ["S","exposicao","enviar-obra"] ≈ 13 tokens + folga
const IA_MARGEM_TOKENS = 40;
const IA_MAX_TENTATIVAS = 3;
const IA_INTERVALO_MS = 200;
const IA_TIMEOUT_MS = 60_000;
const IA_PRECO_ENTRADA_USD_POR_MTOK = 0.10; // claude-haiku-5-5, prompts até 100K tokens
const IA_PRECO_SAIDA_USD_POR_MTOK = 0.50;

export const CATEGORIAS = ['curadoria', 'oficina', 'design', 'ilustracao', 'mural', 'restauro', 'exposicao', 'premio', 'residencia', 'fomento-geral', 'producao', 'parecerista', 'outro'];

const TIPO_ROTULO = {
  contratacao: 'contratação de serviço',
  fomento: 'edital de fomento',
  premio: 'prêmio',
  residencia: 'residência artística',
  chamamento: 'chamamento público',
  outro: 'outro',
};

const PROMPT_SISTEMA = `Você recebe uma lista numerada de oportunidades públicas brasileiras. Cada item é uma contratação de serviço (PNCP) OU um edital de fomento, prêmio, residência ou chamamento público (Mapas Culturais), com tipo, fonte, local, órgão, título e resumo.

Para cada item, responda à mesma pergunta: uma profissional formada em ARTES VISUAIS, residente na Grande Belo Horizonte (MG), pode se candidatar, concorrer ou ser contratada nisso? Artes visuais = criação artística (pintura, desenho, gravura, escultura, cerâmica, fotografia artística, quadrinhos, grafite, mural, instalação), curadoria, montagem e produção de exposições, oficinas dessas linguagens, ilustração, design gráfico de criação, cenografia, restauro e conservação de obras e acervos artísticos, arte-educação e mediação cultural.

Regras de decisão:
- S = sim. Editais de cultura amplos (todas as linguagens, multilinguagem, pontos de cultura) são S.
- "Produção cultural" só é S quando for produção, montagem ou organização de exposição, mostra, feira de arte, festival de artes visuais, intervenção urbana ou evento cujo conteúdo principal é artes visuais. Produção de evento genérico (festa, festival de música, feira agropecuária, aniversário da cidade, evento esportivo, natal, carnaval) é N.
- SEMPRE N, mesmo que o texto diga "artístico", "cultural" ou "evento": sonorização, iluminação de palco ou cênica, palco e estrutura, filmagem, gravação, edição de vídeo, transmissão, fotografia de evento, companhia de teatro, grupo de dança, circo, música em qualquer forma (show, banda, cantor, cantora, dupla, DJ, orquestra, maestro, coral, percussão, oficina de instrumento, aquisição de instrumentos musicais), prensagem de discos, impressão gráfica comum (banners, faixas, panfletos, cartazes, camisetas, brindes) sem criação de identidade visual, locação de equipamentos, buffet, decoração de festa, segurança, transporte.
- "Oficina" só é S se for de desenho, pintura, gravura, escultura, cerâmica, fotografia artística, ilustração, quadrinhos, grafite, arte-educação, mediação ou similares de artes visuais. Oficina de música, dança, teatro, circo, literatura, audiovisual ou artesanato utilitário é N.
- "Design" só é S se for criação: identidade visual, ilustração, diagramação editorial, projeto gráfico, design de exposição. Impressão, plotagem, sinalização pronta, brindes, uniformes são N.
- Pareceristas e avaliadores de projetos culturais: S apenas se o edital for de artes visuais ou multilinguagem; categoria "parecerista".
- Modelo vivo para aulas de arte: S, categoria "outro".
- Restauro: S só quando for de obra de arte, bem cultural móvel, pintura mural, talha, azulejaria, forro pintado, acervo museológico, ou quando a obra de prédio histórico citar explicitamente elementos artísticos integrados. Restauração de prédio, pavimento, telhado, elétrica, instrumento musical é N.
- Editais exclusivos de música, audiovisual, literatura, dança ou teatro são N. Palavra-chave em outro sentido é N ("exposição a agentes químicos", "acervo bibliográfico", "design de software", "parque de exposições").
- Geografia: editais em que se ENVIA OBRA ou RESIDÊNCIAS artísticas aceitam inscrição de qualquer lugar do Brasil e NUNCA são N por serem de outro estado (só são N se exigirem explicitamente residência em outro estado). Para inscrever-projeto e prestar-servico, restrição explícita a residentes de outro estado é N; se não disser, mantenha.
- D = dúvida, quando o texto é vago demais. Na dúvida real entre S e N, responda D, nunca S.

Além do veredito e da categoria, diga COMO SE PARTICIPA (independente do tipo e da categoria), uma destas palavras:
- enviar-obra: o artista inscreve obras prontas ou portfólio para seleção — salão de artes, mostra coletiva, chamada aberta de galeria/museu/centro cultural, concurso de pintura/desenho/fotografia/gravura/escultura, exposição com seleção de artistas, aquisição ou doação de obras para acervo por edital, intervenção urbana com seleção de propostas artísticas, credenciamento de artistas para expor.
- residencia: residência artística, com ou sem bolsa, mesmo que chamada de "edital de fomento".
- inscrever-projeto: fomento em que se inscreve um projeto para receber recurso (PNAB, Lei Paulo Gustavo, FEC, fundos municipais, pontos de cultura, Rouanet); prêmio de trajetória ou de projeto.
- prestar-servico: contratação de serviço (oficina, mural encomendado, curadoria contratada, design, restauro, parecerista, montagem/cenografia/iluminação/produção de exposição, credenciamento para oficinas ou apresentações).
- formacao: curso, workshop, bolsa de estudo, programa formativo.
- outro: não se encaixa ou não dá para saber.
Regras: "exposição" só é enviar-obra quando o edital seleciona artistas ou obras para expor. Prêmio que premia obras inscritas é enviar-obra; que premia trajetória ou projeto é inscrever-projeto. Na dúvida entre enviar-obra e inscrever-projeto, veja o que se entrega na inscrição: imagens/portfólio = enviar-obra; plano/orçamento = inscrever-projeto. Para N, use "".

Exemplos de participação:
enviar-obra — "Salão de Artes Visuais de Indaiatuba: inscrição de até 3 obras por artista"
enviar-obra — "Credenciamento de artistas para exposições na Galeria de Arte do Centro Cultural, com envio de portfólio"
residencia — "Residência artística no Sítio Burle Marx, 2 meses com bolsa"
residencia — "Edital de fomento: programa de residência para artistas visuais na Casa da Cultura, 6 semanas"
inscrever-projeto — "Edital PNAB 02/2026: fomento a projetos culturais, inscrição de projeto com plano de trabalho e orçamento"
inscrever-projeto — "Prêmio de trajetórias culturais: premiação de agentes com histórico comprovado"
prestar-servico — "Contratação de empresa para montagem e cenografia da exposição do museu"
prestar-servico — "Credenciamento de oficineiros de desenho e pintura para os centros culturais"

Exemplos reais já rotulados:
S design — "Prestação de serviço especializado de diagramação para as publicações digitais e impressas do IMAP"
S design — "Serviços de projeto gráfico, diagramação e editoração eletrônica da Revista ENTRE e da Cartilha de Orientação"
S mural — "Credenciamento para prestação de serviços de intervenções artísticas – Projeto Arte nas Ruas"
S restauro — "Obra de restauração da parte civil e dos elementos artísticos e integrados da Igreja Mercês e Misericórdia"
S oficina — "Serviços educacionais e artísticos para realização de Oficinas de Arte e Cultura integradas às atividades da escola"
S mural — "Serviço de pintura artística na Sala de Depoimento Especial"
N — "Confecção de material gráfico lona tipo banner para a Secretaria Municipal de Cultura"
N — "Contratação do maestro Nilson Galvão para apresentação artística, musical e pedagógica de música erudita"
N — "Locação, montagem e desmontagem de palco 6 m x 6 m com cobertura para evento cultural"
N — "Serviços de edição de vídeos para o evento institucional Afropresença, com 12 horas de gravação bruta"
N — "Aquisição de instrumentos musicais e acessórios nos termos da Política Nacional Aldir Blanc"
N — "Fornecimento de camisetas com serigrafia destinadas ao programa educacional de resistência às drogas"

Dê também uma categoria curta por item, uma destas palavras: curadoria, oficina, design, ilustracao, mural, restauro, exposicao, premio, residencia, fomento-geral, producao, parecerista, outro. Para N, use "".

Responda apenas com um JSON em uma única linha, mapeando o número de cada item para [letra, categoria, participacao], por exemplo {"1":["S","exposicao","enviar-obra"],"2":["N","",""],"3":["D","fomento-geral","inscrever-projeto"]}. Inclua todos os números. Sem explicações, sem texto fora do JSON.`;

function descreverItem(r, i) {
  const local = [r.municipio, r.uf].filter(Boolean).join('/') || (r.uf === null ? 'abrangência nacional' : 'local não informado');
  const fonte = r.detalhes?.fonteNome ?? (r.fonte === 'pncp' ? 'PNCP' : r.fonte);
  const texto = truncar([r.titulo, r.resumo].filter(Boolean).join('. '), IA_TRUNCAR_TEXTO);
  const areas = r.detalhes?.areas?.length ? ` Áreas: ${r.detalhes.areas.slice(0, 4).join(', ')}.` : '';
  return `${i + 1}. [${TIPO_ROTULO[r.tipo] ?? r.tipo}; ${fonte}; ${local}] ${r.orgao ?? 'órgão não informado'}: ${texto}${areas}`;
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

/**
 * Para respostas cortadas por max_tokens: recua até o último objeto interno completo e fecha o JSON,
 * aproveitando os itens inteiros; os que ficaram de fora continuam pendentes.
 */
function extrairJsonTolerante(texto) {
  const completo = extrairJson(texto);
  if (completo) return completo;
  const ini = texto.indexOf('{');
  if (ini < 0) return null;
  for (let i = texto.lastIndexOf('}'); i > ini; i = texto.lastIndexOf('}', i - 1)) {
    try {
      const valor = JSON.parse(`${texto.slice(ini, i + 1)}}`);
      if (valor && typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor).length) return valor;
    } catch { /* tenta um fechamento anterior */ }
  }
  return null;
}

function normalizarParticipacao(valor, veredito) {
  if (veredito === 'N') return null;
  let p = normalizar(valor ?? '').replace(/\s+/g, '-');
  if (p === 'enviar-obras' || p === 'envio-de-obra' || p === 'obra') p = 'enviar-obra';
  if (p === 'residencia-artistica') p = 'residencia';
  if (p === 'projeto' || p === 'inscrever-projetos') p = 'inscrever-projeto';
  if (p === 'servico' || p === 'prestar-servicos' || p === 'contratacao') p = 'prestar-servico';
  return PARTICIPACOES.includes(p) ? p : 'outro';
}

/** Aceita ["S","exposicao","enviar-obra"], ["S","exposicao"], "S" ou {"veredito":"S","categoria":"x","participacao":"y"}. */
function interpretarResposta(valor) {
  let letra = '';
  let categoria = '';
  let participacao = '';
  if (Array.isArray(valor)) [letra, categoria, participacao] = valor;
  else if (typeof valor === 'string') letra = valor;
  else if (valor && typeof valor === 'object') { letra = valor.veredito ?? valor.v ?? ''; categoria = valor.categoria ?? valor.c ?? ''; participacao = valor.participacao ?? valor.p ?? ''; }
  letra = String(letra ?? '').trim().toUpperCase();
  if (!['S', 'N', 'D'].includes(letra)) return null;
  let cat = normalizar(categoria).replace(/\s+/g, '-');
  if (!CATEGORIAS.includes(cat)) cat = letra === 'N' ? '' : (cat ? 'outro' : '');
  return { veredito: letra, categoria: letra === 'N' ? null : (cat || null), participacao: normalizarParticipacao(participacao, letra) };
}

async function chamarModelo(chave, lote, ia) {
  const corpo = {
    model: IA_MODELO,
    max_tokens: lote.length * IA_TOKENS_POR_ITEM + IA_MARGEM_TOKENS,
    system: PROMPT_SISTEMA,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: lote.map(descreverItem).join('\n') }],
  };
  for (let tentativa = 1; ; tentativa++) {
    ia.requisicoes++;
    try {
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS),
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

// ---------------------------------------------------------------- modo extrator (Querido Diário)

const EXTRATOR_LOTE = 8;                 // trechos por requisição (texto longo)
const EXTRATOR_TOKENS_POR_ITEM = 340;    // título + resumo de 200 caracteres + campos ≈ 220–290 tokens em português
const EXTRATOR_MARGEM_TOKENS = 200;
const TIPOS_EXTRATOR = ['contratacao', 'fomento', 'premio', 'residencia', 'chamamento', 'outro'];

const PROMPT_EXTRATOR = `Você recebe textos numerados sobre oportunidades públicas no Brasil: trechos de diários oficiais de municípios de Minas Gerais (Grande Belo Horizonte) ou páginas de editais de órgãos de cultura (Ministério da Cultura, Funarte, Secretaria de Cultura de Minas Gerais). Um trecho de diário pode começar ou terminar no meio de um ato, e pode misturar atos sem relação entre si; uma página de edital traz o nome do edital e, às vezes, a descrição e os prazos.

Para cada trecho, foque apenas no que diz respeito a edital, chamamento público, prêmio, credenciamento ou contratação na área de cultura e artes visuais, e responda:
- relevante: "S" se o trecho anuncia (ou prorroga o prazo de) uma oportunidade em que uma profissional formada em artes visuais (criação artística, curadoria, exposições, oficinas de arte, ilustração, design gráfico, murais, cenografia, restauro, arte-educação, mediação cultural, produção cultural) pode se inscrever, concorrer ou ser contratada; editais de cultura amplos (todas as linguagens, multilinguagem, pontos de cultura, patrimônio) contam como "S". "N" se for só menção de passagem (nomeação de comissão, homologação ou resultado, lista de habilitados, extrato de contrato ou termo já assinado, retificação sem conteúdo novo, convocação de aprovados, concurso público para cargos, ata de reunião). REGRA FORTE: oportunidade exclusiva de música, audiovisual, literatura, dança ou teatro é "N" mesmo que seja um edital aberto com prazo e valor (ex.: festival de música, edital de bandas, mostra de cinema, concurso literário). "D" se houver indício de edital aberto mas o trecho não permitir decidir se artes visuais cabem.
- titulo: nome curto do edital/oportunidade (até 120 caracteres); para "N", o assunto principal do trecho.
- tipo: "contratacao", "fomento", "premio", "residencia", "chamamento" ou "outro".
- resumo: até 200 caracteres, o que é e para quem.
- orgao: órgão responsável, ou null.
- encerramento: prazo final de inscrição/proposta em formato AAAA-MM-DD (converta datas brasileiras como 23/10/2026); null se o prazo não estiver no trecho. Nunca invente.
- valor: valor total em reais como número (sem R$, sem pontos de milhar), ou null.
- categoria: uma destas palavras: curadoria, oficina, design, ilustracao, mural, restauro, exposicao, premio, residencia, fomento-geral, producao, parecerista, outro.
- participacao: COMO SE PARTICIPA, uma destas palavras: enviar-obra (o artista inscreve obras prontas ou portfólio: salão, mostra coletiva, chamada aberta de galeria/museu, concurso de pintura/fotografia/gravura, seleção de artistas para expor, aquisição/doação de obras para acervo, credenciamento de artistas para expor), residencia (residência artística, mesmo que chamada de "edital de fomento"), inscrever-projeto (inscreve-se um projeto com plano e orçamento para receber recurso: PNAB, Lei Paulo Gustavo, FEC, fundos municipais; prêmio de trajetória ou projeto), prestar-servico (contratação de serviço: oficina, mural encomendado, curadoria contratada, design, restauro, parecerista, montagem/cenografia/produção de exposição, credenciamento para oficinas ou apresentações), formacao (curso, workshop, bolsa de estudo), outro. "Exposição" só é enviar-obra quando seleciona artistas ou obras para expor; prêmio de obras inscritas é enviar-obra. Na dúvida entre enviar-obra e inscrever-projeto, veja o que se entrega: imagens/portfólio = enviar-obra; plano/orçamento = inscrever-projeto. Para "N", use "".
- taxa: taxa de inscrição em reais como número, ou null.
- obrasPorArtista: quantas obras cada artista pode inscrever, como texto curto ("até 3 obras"), ou null.
Geografia: editais de enviar-obra e residências aceitam inscrição de qualquer lugar do Brasil e nunca são "N" por serem de outro estado.

Responda apenas com um JSON em uma única linha, mapeando o número de cada trecho a um objeto com essas onze chaves, por exemplo {"1":{"relevante":"S","titulo":"Edital PNAB 02/2026 - Multilinguagem","tipo":"fomento","resumo":"...","orgao":"Secretaria Municipal de Cultura de Contagem","encerramento":"2026-11-10","valor":500000,"categoria":"fomento-geral","participacao":"inscrever-projeto","taxa":null,"obrasPorArtista":null},"2":{"relevante":"N","titulo":"Homologação de resultado","tipo":"outro","resumo":"...","orgao":null,"encerramento":null,"valor":null,"categoria":"outro","participacao":"","taxa":null,"obrasPorArtista":null}}. Inclua todos os números. Sem texto fora do JSON.`;

function descreverTrecho(r, i) {
  const local = r.uf ? `${r.municipio ? `${r.municipio}/` : ''}${r.uf}` : 'abrangência nacional';
  const cab = `${i + 1}. [${r.detalhes?.fonteNome ?? r.fonte} · ${local} · ${r.publicadoEm ?? ''}${r.detalhes?.edicao ? ` · edição ${r.detalhes.edicao}` : ''}]`;
  return `${cab}\n${String(r.detalhes?.textoBruto ?? '').trim()}`;
}

function dataISOouNull(valor) {
  if (!valor || typeof valor !== 'string') return null;
  let m = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function interpretarExtracao(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const relevante = String(v.relevante ?? '').trim().toUpperCase();
  if (!['S', 'N', 'D'].includes(relevante)) return null;
  const valorNum = typeof v.valor === 'number' ? v.valor : Number(String(v.valor ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  let categoria = normalizar(v.categoria ?? '').replace(/\s+/g, '-');
  if (!CATEGORIAS.includes(categoria)) categoria = relevante === 'N' ? null : 'outro';
  const tipo = TIPOS_EXTRATOR.includes(v.tipo) ? v.tipo : 'outro';
  const taxaNum = typeof v.taxa === 'number' ? v.taxa : Number(String(v.taxa ?? '').replace(/[^\d,.-]/g, '').replace(',', '.'));
  return {
    relevante,
    titulo: truncar(v.titulo ?? '', 160) || null,
    tipo,
    resumo: truncar(v.resumo ?? '', 200) || null,
    orgao: typeof v.orgao === 'string' && v.orgao.trim() ? truncar(v.orgao, 160) : null,
    encerramento: dataISOouNull(v.encerramento),
    valor: Number.isFinite(valorNum) && valorNum > 0 ? valorNum : null,
    categoria: relevante === 'N' ? null : categoria,
    participacao: normalizarParticipacao(v.participacao, relevante),
    taxa: Number.isFinite(taxaNum) && taxaNum > 0 ? taxaNum : null,
    obrasPorArtista: typeof v.obrasPorArtista === 'string' && v.obrasPorArtista.trim() ? truncar(v.obrasPorArtista, 60) : null,
  };
}

async function chamarExtrator(chave, lote, stats) {
  const corpo = {
    model: IA_MODELO,
    max_tokens: lote.length * EXTRATOR_TOKENS_POR_ITEM + EXTRATOR_MARGEM_TOKENS,
    system: PROMPT_EXTRATOR,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: lote.map(descreverTrecho).join('\n\n') }],
  };
  for (let tentativa = 1; ; tentativa++) {
    stats.requisicoes++;
    try {
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS * 2),
      });
      if (!res.ok) throw new ErroHttp(res.status, IA_URL, await res.text().catch(() => ''), res.headers.get('retry-after'));
      return await res.json();
    } catch (erro) {
      const retentavel = erro instanceof ErroHttp ? erro.retentavel : true;
      if (!retentavel || tentativa >= IA_MAX_TENTATIVAS) throw erro;
      const espera = (erro instanceof ErroHttp && erro.retryAfterMs) || 2000 * 2 ** (tentativa - 1);
      log(`  IA extrator: ${descreverErro(erro)} — tentativa ${tentativa}/${IA_MAX_TENTATIVAS}, nova tentativa em ${Math.round(espera / 1000)} s`);
      await dormir(espera);
    }
  }
}

/**
 * Modo extrator: para registros do Querido Diário ainda pendentes, a IA decide relevância E preenche
 * título, tipo, resumo, órgão, prazo, valor e categoria a partir do texto bruto. O texto bruto é
 * removido depois de processado (não vai para o JSON público). Devolve estatísticas separadas.
 */
export async function extrair(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const stats = {
    modelo: IA_MODELO, ativo: Boolean(chave),
    processados: 0, relevantes: 0, descartados: 0, duvidas: 0, pendentes: 0,
    lotes: 0, lotesFalhos: 0, requisicoes: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0,
  };
  // Qualquer fonte que entregue detalhes.textoBruto passa pelo extrator (Diário Oficial, páginas de editais).
  const fila = lista.filter((r) => !['S', 'N', 'D'].includes(r.ia) && r.detalhes?.textoBruto && !r.revisado);
  if (!chave) {
    stats.pendentes = fila.length;
    if (fila.length) log(`IA extrator: ANTHROPIC_API_KEY não definida; ${fila.length} textos ficam pendentes (com texto bruto guardado).`);
    return stats;
  }
  if (fila.length === 0) return stats;

  log(`IA extrator: ${fila.length} textos (diários e páginas de editais), em lotes de ${EXTRATOR_LOTE}.`);
  for (let i = 0; i < fila.length; i += EXTRATOR_LOTE) {
    const lote = fila.slice(i, i + EXTRATOR_LOTE);
    stats.lotes++;
    let respostas = null;
    try {
      const resposta = await chamarExtrator(chave, lote, stats);
      stats.tokensEntrada += resposta.usage?.input_tokens ?? 0;
      stats.tokensSaida += resposta.usage?.output_tokens ?? 0;
      if (resposta.stop_reason === 'refusal') log('  IA extrator: lote recusado (refusal); trechos ficam pendentes');
      else {
        const texto = (resposta.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        respostas = extrairJsonTolerante(texto);
        if (!respostas) log(`  IA extrator: resposta sem JSON válido (stop_reason ${resposta.stop_reason}); trechos do lote ficam pendentes`);
        else if (resposta.stop_reason === 'max_tokens') log(`  IA extrator: resposta cortada por max_tokens; ${Object.keys(respostas).length}/${lote.length} itens aproveitados, os demais ficam pendentes`);
      }
    } catch (erro) {
      stats.lotesFalhos++;
      log(`  IA extrator: lote ${stats.lotes} falhou de vez (${descreverErro(erro)}); trechos ficam pendentes`);
    }

    lote.forEach((r, idx) => {
      const ex = respostas ? interpretarExtracao(respostas[String(idx + 1)]) : null;
      if (!ex) { r.ia = 'pendente'; stats.pendentes++; return; }
      stats.processados++;
      r.ia = ex.relevante;
      r.categoriaIA = ex.categoria;
      r.participacao = ex.participacao;
      if (r.detalhes) { r.detalhes.taxa = ex.taxa; r.detalhes.obrasPorArtista = ex.obrasPorArtista; }
      r.tipo = ex.tipo;
      if (ex.titulo) r.titulo = ex.titulo;
      r.resumo = ex.resumo;
      r.orgao = ex.orgao;
      r.encerramento = ex.encerramento;
      r.valor = ex.valor;
      if (r.detalhes) delete r.detalhes.textoBruto;
      if (ex.relevante === 'S') stats.relevantes++;
      else if (ex.relevante === 'N') stats.descartados++;
      else stats.duvidas++;
    });

    if (stats.lotes % 5 === 0) log(`  IA extrator: ${Math.min(i + EXTRATOR_LOTE, fila.length)}/${fila.length} trechos processados`);
    if (i + EXTRATOR_LOTE < fila.length) await dormir(IA_INTERVALO_MS);
  }
  stats.custoUsd = Number(((stats.tokensEntrada * IA_PRECO_ENTRADA_USD_POR_MTOK + stats.tokensSaida * IA_PRECO_SAIDA_USD_POR_MTOK) / 1e6).toFixed(4));
  return stats;
}

// ---------------------------------------------------------------- participação para itens já avaliados sem o campo

const PROMPT_PARTICIPACAO = `Você recebe uma lista numerada de oportunidades já consideradas relevantes para uma artista visual. Para cada item, diga COMO SE PARTICIPA, uma destas palavras:
- enviar-obra: inscrição de obras prontas ou portfólio (salão, mostra coletiva, chamada de galeria/museu, concurso de pintura/fotografia/gravura, seleção de artistas para expor, aquisição/doação de obras para acervo, credenciamento de artistas para expor).
- residencia: residência artística, mesmo que chamada de "edital de fomento".
- inscrever-projeto: inscreve-se um projeto com plano e orçamento para receber recurso (PNAB, Lei Paulo Gustavo, FEC, fundos municipais, pontos de cultura); prêmio de trajetória ou projeto.
- prestar-servico: contratação de serviço (oficina, mural encomendado, curadoria contratada, design, restauro, parecerista, montagem/cenografia/produção de exposição, credenciamento para oficinas ou apresentações).
- formacao: curso, workshop, bolsa de estudo, programa formativo.
- outro: não se encaixa ou não dá para saber.
"Exposição" só é enviar-obra quando seleciona artistas ou obras para expor; montagem/cenografia/produção é prestar-servico. Prêmio de obras inscritas é enviar-obra; de trajetória/projeto é inscrever-projeto.

Responda apenas com um JSON em uma única linha mapeando o número de cada item à palavra, por exemplo {"1":"enviar-obra","2":"prestar-servico"}. Inclua todos os números. Sem texto fora do JSON.`;

/** Preenche `participacao` nos itens S/D que ainda não têm (avaliados antes de o campo existir, ou extraídos de texto já descartado). */
export async function completarParticipacao(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const stats = { ativo: Boolean(chave), preenchidos: 0, pendentes: 0, lotes: 0, lotesFalhos: 0, requisicoes: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
  const fila = lista.filter((r) => (r.ia === 'S' || r.ia === 'D') && !r.participacao && !r.revisado);
  if (!chave || fila.length === 0) { stats.pendentes = fila.length; return stats; }
  log(`IA participação: ${fila.length} itens aprovados/dúvida sem "como participar", em lotes de ${CATEGORIZAR_LOTE}.`);
  for (let i = 0; i < fila.length; i += CATEGORIZAR_LOTE) {
    const lote = fila.slice(i, i + CATEGORIZAR_LOTE);
    stats.lotes++;
    let respostas = null;
    try {
      stats.requisicoes++;
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify({
          model: IA_MODELO, max_tokens: lote.length * 10 + IA_MARGEM_TOKENS, system: PROMPT_PARTICIPACAO,
          thinking: { type: 'disabled' }, output_config: { effort: 'low' },
          messages: [{ role: 'user', content: lote.map(descreverItem).join('\n') }],
        }),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS),
      });
      if (!res.ok) throw new ErroHttp(res.status, IA_URL, await res.text().catch(() => ''), res.headers.get('retry-after'));
      const resposta = await res.json();
      stats.tokensEntrada += resposta.usage?.input_tokens ?? 0;
      stats.tokensSaida += resposta.usage?.output_tokens ?? 0;
      respostas = extrairJsonTolerante((resposta.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    } catch (erro) {
      stats.lotesFalhos++;
      log(`  IA participação: lote ${stats.lotes} falhou (${descreverErro(erro)})`);
      if (erro instanceof ErroHttp && erro.status === 429) await dormir(erro.retryAfterMs ?? 10_000);
    }
    lote.forEach((r, idx) => {
      const p = respostas ? normalizarParticipacao(respostas[String(idx + 1)], r.ia) : null;
      if (p) { r.participacao = p; stats.preenchidos++; } else stats.pendentes++;
    });
    if (i + CATEGORIZAR_LOTE < fila.length) await dormir(IA_INTERVALO_MS);
  }
  stats.custoUsd = Number(((stats.tokensEntrada * IA_PRECO_ENTRADA_USD_POR_MTOK + stats.tokensSaida * IA_PRECO_SAIDA_USD_POR_MTOK) / 1e6).toFixed(4));
  return stats;
}

// ---------------------------------------------------------------- busca de prazo no texto integral

const PRAZOS_MAX_POR_EXECUCAO = 40;
const PRAZOS_JANELA = 6000; // caracteres de texto enviados ao modelo por item
const PROMPT_PRAZO = `Você recebe o título de uma oportunidade pública (edital, chamamento, prêmio ou contratação) e um trecho do texto integral onde ela foi publicada. Encontre, APENAS se estiver escrito no texto, o prazo final de inscrição ou de envio de propostas dessa oportunidade específica, a data de início das inscrições e o valor total em reais.

Responda apenas com um JSON em uma linha: {"encerramento":"AAAA-MM-DD" ou null,"abertura":"AAAA-MM-DD" ou null,"valor":número ou null}. Converta datas brasileiras (dd/mm/aaaa) para AAAA-MM-DD. Se houver prazo prorrogado, use a data mais recente. Nunca invente: na dúvida, null.`;

async function baixarTexto(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new ErroHttp(res.status, url, '', null);
  const bruto = await res.text();
  const ehHtml = /<html|<body|<div/i.test(bruto.slice(0, 2000));
  return ehHtml ? bruto.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ') : bruto.replace(/\s+/g, ' ');
}

/** Janela do texto ao redor do primeiro trecho que lembra o título (número do edital ou palavras do título). */
function janelaRelevante(texto, titulo) {
  const t = normalizar(texto);
  const candidatos = [];
  const numero = /(\d{1,4})\s*\/\s*(\d{4})/.exec(titulo);
  if (numero) candidatos.push(`${numero[1]}/${numero[2]}`, `${numero[1].padStart(3, '0')}/${numero[2]}`);
  const palavras = normalizar(titulo).split(' ').filter((p) => p.length >= 5).slice(0, 4);
  if (palavras.length >= 2) candidatos.push(palavras.slice(0, 2).join(' '));
  candidatos.push(...palavras);
  let pos = -1;
  for (const c of candidatos) { pos = t.indexOf(normalizar(c)); if (pos >= 0) break; }
  if (pos < 0) return texto.length <= PRAZOS_JANELA ? texto : null;
  const ini = Math.max(0, pos - Math.round(PRAZOS_JANELA * 0.3));
  return texto.slice(ini, ini + PRAZOS_JANELA);
}

/**
 * Para itens aprovados/dúvida sem prazo e com texto integral disponível (detalhes.textoUrl), procura o prazo
 * no texto completo. Tenta uma vez por item (detalhes.prazoBuscado). Estatísticas em meta.json (ia.prazos).
 */
export async function completarPrazos(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const stats = { ativo: Boolean(chave), tentados: 0, encontrados: 0, semTexto: 0, falhas: 0, requisicoes: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
  const fila = lista.filter((r) => (r.ia === 'S' || r.ia === 'D') && !r.encerramento && r.detalhes?.textoUrl && !r.detalhes?.prazoBuscado).slice(0, PRAZOS_MAX_POR_EXECUCAO);
  if (!chave || fila.length === 0) return stats;
  log(`IA prazos: ${fila.length} itens sem prazo com texto integral disponível.`);
  const cache = new Map();
  for (const r of fila) {
    stats.tentados++;
    r.detalhes.prazoBuscado = true;
    try {
      let texto = cache.get(r.detalhes.textoUrl);
      if (!texto) { texto = await baixarTexto(r.detalhes.textoUrl); cache.set(r.detalhes.textoUrl, texto); }
      const janela = janelaRelevante(texto, r.titulo);
      if (!janela) { stats.semTexto++; continue; }
      stats.requisicoes++;
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify({
          model: IA_MODELO, max_tokens: 120, system: PROMPT_PRAZO, thinking: { type: 'disabled' }, output_config: { effort: 'low' },
          messages: [{ role: 'user', content: `Título: ${r.titulo}\nÓrgão: ${r.orgao ?? 'não informado'}\nPublicado em: ${r.publicadoEm ?? '?'}\n\nTexto:\n${janela}` }],
        }),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS),
      });
      if (!res.ok) throw new ErroHttp(res.status, IA_URL, await res.text().catch(() => ''), res.headers.get('retry-after'));
      const resposta = await res.json();
      stats.tokensEntrada += resposta.usage?.input_tokens ?? 0;
      stats.tokensSaida += resposta.usage?.output_tokens ?? 0;
      const json = extrairJsonTolerante((resposta.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
      const enc = dataISOouNull(json?.encerramento);
      if (enc) { r.encerramento = enc; stats.encontrados++; }
      const ab = dataISOouNull(json?.abertura);
      if (ab && !r.abertura) r.abertura = ab;
      if (typeof json?.valor === 'number' && json.valor > 0 && !r.valor) r.valor = json.valor;
      await dormir(IA_INTERVALO_MS);
    } catch (erro) {
      stats.falhas++;
      log(`  IA prazos: ${r.titulo.slice(0, 60)}… falhou (${descreverErro(erro)})`);
    }
  }
  stats.custoUsd = Number(((stats.tokensEntrada * IA_PRECO_ENTRADA_USD_POR_MTOK + stats.tokensSaida * IA_PRECO_SAIDA_USD_POR_MTOK) / 1e6).toFixed(4));
  log(`IA prazos: ${stats.encontrados} prazos encontrados em ${stats.tentados} tentativas (${stats.semTexto} sem trecho localizável, ${stats.falhas} falhas) · US$ ${stats.custoUsd}`);
  return stats;
}

// ---------------------------------------------------------------- modo categorizador (só categoria, sem mexer no veredito)

const CATEGORIZAR_LOTE = 30;
const CATEGORIZAR_TOKENS_POR_ITEM = 8;   // "1":"exposicao", ≈ 6 tokens
const PROMPT_CATEGORIZADOR = `Você recebe uma lista numerada de oportunidades públicas já consideradas relevantes para uma profissional de artes visuais. Para cada item, escolha a categoria que melhor descreve o trabalho, uma destas palavras: curadoria, oficina, design, ilustracao, mural, restauro, exposicao, premio, residencia, fomento-geral, producao, outro.

Responda apenas com um JSON em uma única linha mapeando o número de cada item à categoria, por exemplo {"1":"exposicao","2":"design","3":"outro"}. Inclua todos os números. Sem texto fora do JSON.`;

/**
 * Preenche `categoriaIA` nos itens com veredito S ou D que ainda não têm categoria (itens classificados
 * antes de a categoria existir). Não altera o veredito. Passada única na prática: depois de preenchida,
 * a categoria é preservada nas execuções seguintes.
 */
export async function categorizar(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const stats = { modelo: IA_MODELO, ativo: Boolean(chave), categorizados: 0, pendentes: 0, lotes: 0, lotesFalhos: 0, requisicoes: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
  const fila = lista.filter((r) => (r.ia === 'S' || r.ia === 'D') && !r.categoriaIA && !r.revisado);
  if (!chave || fila.length === 0) { stats.pendentes = fila.length; return stats; }

  log(`IA categorizador: ${fila.length} itens aprovados/dúvida sem categoria, em lotes de ${CATEGORIZAR_LOTE}.`);
  for (let i = 0; i < fila.length; i += CATEGORIZAR_LOTE) {
    const lote = fila.slice(i, i + CATEGORIZAR_LOTE);
    stats.lotes++;
    let respostas = null;
    try {
      const corpo = {
        model: IA_MODELO,
        max_tokens: lote.length * CATEGORIZAR_TOKENS_POR_ITEM + IA_MARGEM_TOKENS,
        system: PROMPT_CATEGORIZADOR,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: lote.map(descreverItem).join('\n') }],
      };
      stats.requisicoes++;
      const res = await fetch(IA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': IA_VERSAO },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(IA_TIMEOUT_MS),
      });
      if (!res.ok) throw new ErroHttp(res.status, IA_URL, await res.text().catch(() => ''), res.headers.get('retry-after'));
      const resposta = await res.json();
      stats.tokensEntrada += resposta.usage?.input_tokens ?? 0;
      stats.tokensSaida += resposta.usage?.output_tokens ?? 0;
      const texto = (resposta.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      respostas = extrairJsonTolerante(texto);
    } catch (erro) {
      stats.lotesFalhos++;
      log(`  IA categorizador: lote ${stats.lotes} falhou (${descreverErro(erro)}); itens ficam sem categoria`);
      if (erro instanceof ErroHttp && erro.status === 429) await dormir(erro.retryAfterMs ?? 10_000);
    }
    lote.forEach((r, idx) => {
      const cat = respostas ? normalizar(String(respostas[String(idx + 1)] ?? '')).replace(/\s+/g, '-') : '';
      if (CATEGORIAS.includes(cat)) { r.categoriaIA = cat; stats.categorizados++; } else stats.pendentes++;
    });
    if (stats.lotes % 10 === 0) log(`  IA categorizador: ${Math.min(i + CATEGORIZAR_LOTE, fila.length)}/${fila.length}`);
    if (i + CATEGORIZAR_LOTE < fila.length) await dormir(IA_INTERVALO_MS);
  }
  stats.custoUsd = Number(((stats.tokensEntrada * IA_PRECO_ENTRADA_USD_POR_MTOK + stats.tokensSaida * IA_PRECO_SAIDA_USD_POR_MTOK) / 1e6).toFixed(4));
  return stats;
}

// ---------------------------------------------------------------- modo classificador (PNCP, Mapas)

/**
 * Preenche `ia` e `categoriaIA` nos itens da lista que ainda não têm veredito (exceto os do Querido Diário,
 * que passam pelo extrator). Devolve estatísticas para o meta.json (tokens, custo, contagens).
 */
export async function classificar(lista) {
  const chave = process.env.ANTHROPIC_API_KEY;
  const ia = {
    modelo: IA_MODELO,
    ativo: Boolean(chave),
    classificados: 0, aprovados: 0, reprovados: 0, duvidas: 0, pendentes: 0,
    lotes: 0, lotesFalhos: 0, requisicoes: 0,
    tokensEntrada: 0, tokensSaida: 0, custoUsd: 0,
    porTipo: {},
  };
  const fila = lista.filter((r) => !['S', 'N', 'D'].includes(r.ia) && !r.detalhes?.textoBruto && !r.revisado);

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
      const resultado = respostas ? interpretarResposta(respostas[String(idx + 1)]) : null;
      if (resultado) {
        r.ia = resultado.veredito;
        r.categoriaIA = resultado.categoria;
        r.participacao = resultado.participacao;
        ia.classificados++;
        if (r.ia === 'S') ia.aprovados++;
        else if (r.ia === 'N') ia.reprovados++;
        else ia.duvidas++;
        const t = (ia.porTipo[r.tipo] ??= { S: 0, N: 0, D: 0 });
        t[r.ia]++;
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
