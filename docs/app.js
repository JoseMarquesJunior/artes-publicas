/* Artes Públicas: busca e filtros no navegador sobre docs/data/oportunidades.json.
   Vanilla JS, sem build, sem dependências. */
(() => {
  'use strict';

  const LOTE = 60;             // cards renderizados por vez
  const DIAS_URGENTE = 7;      // destaque para prazos que encerram em até N dias
  const LIMITE_TRUNCAR = 220;  // textos maiores que isso ganham "ver mais"
  const DIA_MS = 86_400_000;
  const UF_PADRAO = 'MG';
  const VISAO_PADRAO = 'abertas';
  const ORDEM_PADRAO = { abertas: 'prazo', radar: 'recentes' };
  const CHAVE_VISAO = 'artes-publicas:visao';
  const REPO = 'JoseMarquesJunior/artes-publicas'; // para o link "Classificação errada?"

  const TIPO_ROTULO = { contratacao: 'Contratação', fomento: 'Fomento', premio: 'Prêmio', residencia: 'Residência', chamamento: 'Chamamento', outro: 'Outro' };
  const PART_ROTULO = { 'enviar-obra': 'Enviar obra', residencia: 'Residência', 'inscrever-projeto': 'Inscrever projeto', 'prestar-servico': 'Prestar serviço', formacao: 'Formação', outro: 'Outro' };
  const PARTES = Object.keys(PART_ROTULO);
  // Enviar obra e residência aceitam inscrição de qualquer lugar do Brasil: o filtro de UF não se aplica.
  const PARTES_NACIONAIS = new Set(['enviar-obra', 'residencia']);
  const ehNacional = (part) => PARTES_NACIONAIS.has(part);
  const ordemPadrao = (f) => (ehNacional(f.part) ? 'prazo' : ORDEM_PADRAO[f.visao]);
  const GRUPO_FOMENTO = new Set(['fomento', 'premio', 'residencia', 'chamamento']);
  const SITUACOES_ALERTA = /suspens|anulad|revogad/i;
  // Peso da categoria na ordenação por relevância: categorias claramente de artes visuais primeiro,
  // fomento amplo e produção depois, "outro"/sem categoria por último. Empates: mais recente primeiro.
  const PESO_CATEGORIA = {
    exposicao: 3, curadoria: 3, mural: 3, ilustracao: 3, restauro: 3, design: 3, oficina: 3, premio: 3, residencia: 3, parecerista: 2,
    'fomento-geral': 2, producao: 1, outro: 0,
  };
  const CATEGORIA_ROTULO = {
    curadoria: 'curadoria', oficina: 'oficina', design: 'design', ilustracao: 'ilustração', mural: 'mural', restauro: 'restauro',
    exposicao: 'exposição', premio: 'prêmio', residencia: 'residência', 'fomento-geral': 'fomento geral', producao: 'produção', parecerista: 'parecerista', outro: 'outro',
  };
  // Siglas preservadas ao converter títulos em caixa alta para caixa de sentença.
  const SIGLAS = new Set(['PNAB', 'PNCP', 'LPG', 'FEC', 'SECULT', 'SMC', 'FMC', 'MG', 'SP', 'RJ', 'BH', 'UF', 'CNPJ', 'CPF', 'MEI', 'OSC', 'PBH', 'UFMG', 'IPHAN', 'IEPHA', 'FCS', 'ONG', 'LTDA', 'EPP', 'SRP', 'ARP', 'PMBH', 'CMBH', 'TV', 'PCD', 'LGBT', 'CRAS', 'CREAS', 'CAPS', 'UBS', 'APAE', 'SESC', 'SENAC', 'SESI', 'IBGE', 'MINC', 'RS', 'PR', 'SC', 'BA', 'CE', 'PE', 'PA', 'GO', 'DF', 'ES', 'MT', 'MS', 'AM', 'TO', 'MA', 'PB', 'RN', 'AL', 'SE', 'PI', 'AC', 'RO', 'RR', 'AP', 'FUNDAC', 'FUNARTE', 'SMCULT', 'CMPC', 'COMPAC', 'FMIC', 'UEMG', 'CEFET', 'IFMG', 'UFOP', 'UFJF', 'UFU', 'UFV', 'ME']);

  const el = {};
  for (const id of ['busca', 'uf', 'regiao', 'modalidade', 'ordem', 'duvida', 'limpar', 'contagem', 'status', 'lista', 'mais', 'atualizado', 'resumo', 'filtros', 'abas', 'visoes', 'participacao', 'intro-radar', 'painel-radar', 'fontes-aviso', 'rodape-base', 'rodape-erros']) {
    el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }

  const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const fmtMoedaCent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtDataHora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // dados: tudo que veio do JSON; base: o que pode aparecer (os "N" da IA nunca são exibidos).
  const estado = { dados: [], base: [], filtrados: [], visiveis: 0, filtros: null, meta: null };

  // ------------------------------------------------------------ utilidades

  const veredito = (r) => (r.ia === 'S' || r.ia === 'N' || r.ia === 'D' ? r.ia : 'pendente');
  const grupoTipo = (r) => (r.tipo === 'contratacao' ? 'contratacao' : GRUPO_FOMENTO.has(r.tipo) ? 'fomento' : 'outro');
  const ehUrlHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
  const contratacaoDireta = (r) => /inexigibilidade|dispensa/i.test(r.detalhes?.modalidade ?? '');

  function normalizar(texto) {
    return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function paraMs(iso) {
    if (!iso) return null;
    const ms = new Date(iso.length === 10 ? `${iso}T23:59:59` : iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  function h(tag, classe, texto) {
    const n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  function plural(n, singular, pluralForma) {
    return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : pluralForma}`;
  }

  /** Títulos inteiramente em caixa alta viram caixa de sentença; siglas conhecidas e tokens com dígitos ficam como estão. */
  function caixaDeSentenca(texto) {
    const original = String(texto ?? '');
    // prefixo entre colchetes ("[Portal de Compras Públicas] - ") não conta para decidir se o título está em caixa alta
    const prefixo = /^\s*\[[^\]]*\]\s*-?\s*/.exec(original)?.[0] ?? '';
    const t = original.slice(prefixo.length);
    const letras = t.replace(/[^\p{L}]/gu, '');
    if (letras.length < 12 || letras !== letras.toUpperCase()) return original;
    let s = t.toLowerCase();
    s = s.replace(/(^\s*|[.!?:]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    s = s.replace(/\p{L}[\p{L}\p{N}]*/gu, (w) => {
      const maiusc = w.toUpperCase();
      if (SIGLAS.has(maiusc) || (/\p{N}/u.test(w) && w.length <= 8) || (w.length >= 2 && w.length <= 5 && !/[aeiouyáéíóúãõâêôà]/i.test(w))) return maiusc;
      return w;
    });
    return prefixo + s;
  }

  function nomeFonte(r) {
    if (r.fonte === 'pncp') return 'PNCP';
    if (r.detalhes?.fonteNome) return r.detalhes.fonteNome;
    if (r.fonte.startsWith('mapas')) return 'Mapa Cultural';
    if (r.fonte === 'querido-diario') return 'Diário Oficial';
    return r.fonte;
  }

  /** "aberta" × "encerrada" recalculado pela data atual; o resto vem do campo gravado pelo coletor. */
  function acionavelAtual(r, agora) {
    if (r._enc !== null) return r._enc > agora ? 'aberta' : 'encerrada';
    if (r.acionavel) return r.acionavel;
    return GRUPO_FOMENTO.has(r.tipo) ? 'aberta' : 'radar';
  }

  function lerVisaoLembrada() {
    try { const v = localStorage.getItem(CHAVE_VISAO); return v === 'radar' || v === 'abertas' ? v : null; } catch { return null; }
  }
  function lembrarVisao(v) {
    try { localStorage.setItem(CHAVE_VISAO, v); } catch { /* sem armazenamento */ }
  }

  // ------------------------------------------------------------ URL <-> filtros

  function lerFiltrosDaUrl() {
    const p = new URLSearchParams(location.search);
    const tipo = p.get('tipo');
    const visao = p.get('visao') === 'radar' ? 'radar' : p.get('visao') === 'abertas' ? 'abertas' : (lerVisaoLembrada() ?? VISAO_PADRAO);
    const ord = p.get('ord');
    const part = PARTES.includes(p.get('part')) ? p.get('part') : '';
    const f = {
      visao,
      part,
      tipo: tipo === 'contratacao' || tipo === 'fomento' ? tipo : '',
      q: p.get('q') ?? '',
      uf: p.get('uf') ?? UF_PADRAO,
      reg: ['Grande BH', 'Inconfidentes', 'Outras'].includes(p.get('regiao')) ? p.get('regiao') : '',
      mod: p.get('mod') ?? '',
      duvida: p.get('duvida') === '1',
      ord: 'prazo',
    };
    f.ord = ['prazo', 'recentes', 'relevancia'].includes(ord) ? ord : ordemPadrao(f);
    return f;
  }

  function gravarFiltrosNaUrl() {
    const f = estado.filtros;
    const p = new URLSearchParams();
    if (f.visao !== VISAO_PADRAO) p.set('visao', f.visao);
    if (f.part) p.set('part', f.part);
    if (f.tipo) p.set('tipo', f.tipo);
    if (f.q) p.set('q', f.q);
    if (f.uf !== UF_PADRAO && !ehNacional(f.part)) p.set('uf', f.uf);
    if (f.reg) p.set('regiao', f.reg);
    if (f.mod) p.set('mod', f.mod);
    if (f.duvida) p.set('duvida', '1');
    if (f.ord !== ordemPadrao(f)) p.set('ord', f.ord);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
    lembrarVisao(f.visao);
  }

  function aplicarFiltrosNosControles() {
    const f = estado.filtros;
    el.busca.value = f.q;
    garantirOpcao(el.uf, f.uf);
    garantirOpcao(el.modalidade, f.mod);
    if (ehNacional(f.part)) {
      // Regra de geografia: salões, mostras e residências aceitam inscrição de qualquer lugar do Brasil.
      el.uf.value = 'brasil';
      el.uf.disabled = true;
      el.uf.title = 'Editais de enviar obra e residências aceitam inscrição de qualquer lugar do Brasil; o filtro de UF não se aplica.';
      el.uf.parentElement.title = el.uf.title;
    } else {
      el.uf.disabled = false;
      el.uf.title = '';
      el.uf.parentElement.title = '';
      el.uf.value = f.uf;
    }
    el.regiao.value = f.reg;
    el.modalidade.value = f.mod;
    el.duvida.checked = f.duvida;
    el.ordem.value = f.ord;
    for (const b of el.abas.querySelectorAll('[data-tipo]')) {
      const ativo = b.dataset.tipo === f.tipo;
      b.setAttribute('aria-selected', String(ativo));
      b.tabIndex = ativo ? 0 : -1;
    }
    for (const b of el.visoes.querySelectorAll('[data-visao]')) {
      const ativo = b.dataset.visao === f.visao;
      b.setAttribute('aria-selected', String(ativo));
      b.tabIndex = ativo ? 0 : -1;
    }
    for (const b of el.participacao.querySelectorAll('[data-part]')) {
      const ativo = b.dataset.part === f.part;
      b.setAttribute('aria-selected', String(ativo));
      b.tabIndex = ativo ? 0 : -1;
    }
    el.introRadar.hidden = f.visao !== 'radar';
    el.painelRadar.hidden = f.visao !== 'radar';
    document.body.classList.toggle('visao-radar', f.visao === 'radar');
  }

  function garantirOpcao(select, valor) {
    if (!valor) return;
    if (![...select.options].some((o) => o.value === valor)) select.append(new Option(valor, valor));
  }

  // ------------------------------------------------------------ carga

  async function carregarJson(caminho) {
    const res = await fetch(caminho, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${caminho}: HTTP ${res.status}`);
    return res.json();
  }

  function preparar(registro) {
    const r = { ...registro };
    r._pub = paraMs(r.publicadoEm ?? r.coletadoEm);
    r._enc = paraMs(r.encerramento);
    r._grupo = grupoTipo(r);
    r._busca = normalizar([r.titulo, r.resumo, r.detalhes?.objetoCompleto, r.orgao, r.detalhes?.unidade, r.municipio, r.uf, r.idNaFonte, r.categoriaIA].filter(Boolean).join(' '));
    return r;
  }

  function preencherSelect(select, valores) {
    for (const v of valores) select.append(new Option(v, v));
  }

  function mostrarRodape(meta) {
    const d = meta?.atualizadoEm ? new Date(meta.atualizadoEm) : null;
    el.atualizado.textContent = d && !Number.isNaN(d.getTime())
      ? `Atualizado em ${fmtData.format(d)} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      : 'Data da última atualização indisponível.';
    const aprovadas = estado.dados.filter((r) => veredito(r) === 'S').length;
    el.rodapeBase.textContent = `${plural(aprovadas, 'oportunidade confirmada', 'oportunidades confirmadas')} nos últimos 12 meses, em ${plural(estado.dados.length, 'registro coletado', 'registros coletados')}.`;

    const porFonte = meta?.errosPorFonte && typeof meta.errosPorFonte === 'object' ? Object.entries(meta.errosPorFonte) : [];
    if (porFonte.length) {
      const nomes = new Map((meta.fontes ?? []).map((f) => [f.fonte, f.nome]));
      const trechos = porFonte.map(([fonte, e]) => {
        const nome = nomes.get(fonte) ?? fonte;
        if (e.completa) return `${nome} (fora do ar)`;
        return e.total ? `${nome} (${e.falhas} de ${e.total} consultas falharam)` : `${nome} (coleta parcial)`;
      });
      el.rodapeErros.textContent = `Na última coleta: ${trechos.join('; ')}. O que falhou é tentado de novo no dia seguinte.`;
      el.rodapeErros.hidden = false;
    } else if (Array.isArray(meta?.erros) && meta.erros.length) {
      el.rodapeErros.textContent = 'A última coleta teve falhas parciais; o que falhou é tentado de novo no dia seguinte.';
      el.rodapeErros.hidden = false;
    }
  }

  function mostrarFontes(meta) {
    const ativas = Array.isArray(meta?.fontes) ? meta.fontes.filter((f) => f.ativo) : [];
    if (!ativas.length) return;
    const rotuloFonte = (f) => (f.tipo === 'pncp' ? `${f.nome} (contratações de serviço)` : f.bloqueadoNoCI ? `${f.nome} (atualização manual)` : f.nome);
    const GRUPOS = [['orgaos-publicos', 'Órgãos públicos'], ['instituicoes', 'Instituições'], ['residencias', 'Residências']];
    const grupoDe = (f) => (GRUPOS.some(([g]) => g === f.grupo) ? f.grupo : 'orgaos-publicos');
    el.fontesAviso.textContent = 'Fontes ativas. ';
    for (const [grupo, rotulo] of GRUPOS) {
      const nomes = ativas.filter((f) => grupoDe(f) === grupo).map(rotuloFonte);
      if (!nomes.length) continue;
      el.fontesAviso.append(h('strong', null, `${rotulo}: `), `${nomes.join(', ')}. `);
    }
    el.fontesAviso.append('Editais publicados em outros canais ainda não aparecem aqui.');
    const inativas = (meta.fontes ?? []).filter((f) => !f.ativo && f.observacao);
    if (inativas.length) {
      el.fontesAviso.append(' ');
      el.fontesAviso.append(h('span', 'aviso-fraco', `Desligadas: ${inativas.map((f) => `${f.nome} (${f.observacao.split('.')[0].toLowerCase()})`).join('; ')}.`));
    }
  }

  // ------------------------------------------------------------ filtro e ordenação

  function passaUf(r, uf) {
    if (uf === 'todas') return true;
    if (uf === 'nacional') return !r.uf;
    return r.uf === uf || !r.uf; // itens nacionais (uf nula) valem para qualquer estado
  }

  function filtrar() {
    const { visao, part, tipo, q, uf, reg, mod, duvida, ord } = estado.filtros;
    const termos = normalizar(q).split(/\s+/).filter(Boolean);
    const agora = Date.now();

    // Filtros comuns, exceto UF e participação (a UF depende da participação: enviar obra e residência valem para o Brasil inteiro).
    const comuns = estado.base.filter((r) => {
      const ac = acionavelAtual(r, agora);
      if (visao === 'abertas' ? !(ac === 'aberta' || ac === 'fluxo-continuo') : !(ac === 'radar' || ac === 'encerrada')) return false;
      if (!duvida && veredito(r) === 'D') return false;
      if (reg && (r.regiao ?? (r.uf ? 'Outras' : null)) !== reg) return false;
      if (mod && r.detalhes?.modalidade !== mod) return false;
      if (termos.length && !termos.every((t) => r._busca.includes(t))) return false;
      return true;
    });
    const passaGeo = (r, p) => ehNacional(p) || passaUf(r, uf);
    const partDe = (r) => r.participacao ?? 'outro';

    // contagem por participação (cada uma com a sua regra geográfica)
    for (const b of el.participacao.querySelectorAll('[data-part]')) {
      const p = b.dataset.part;
      const n = comuns.filter((r) => (p ? partDe(r) === p : true) && passaGeo(r, p ? p : partDe(r))).length;
      const span = b.querySelector('.aba-n');
      if (span) span.textContent = n.toLocaleString('pt-BR');
    }

    const semTipo = comuns.filter((r) => (part ? partDe(r) === part : true) && passaGeo(r, part || partDe(r)));

    const contagens = { '': semTipo.length, contratacao: 0, fomento: 0 };
    for (const r of semTipo) if (r._grupo in contagens) contagens[r._grupo]++;
    for (const b of el.abas.querySelectorAll('[data-tipo]')) {
      const n = b.querySelector('.aba-n');
      if (n) n.textContent = (contagens[b.dataset.tipo] ?? 0).toLocaleString('pt-BR');
    }

    const lista = tipo ? semTipo.filter((r) => r._grupo === tipo) : semTipo;
    ordenar(lista, ord, agora);

    estado.filtrados = lista;
    estado.visiveis = 0;
    el.lista.replaceChildren();
    renderizarMais();
    atualizarResumo(contagens);
    if (visao === 'radar') renderizarPainelRadar(lista);
  }

  function ordenar(lista, ord, agora) {
    const pub = (r) => r._pub ?? 0;
    if (ord === 'prazo') {
      // Prazos no futuro, mais próximo primeiro; depois fluxo contínuo; depois prazo desconhecido (⚠); encerrados por fim.
      const faixa = (r) => {
        const ac = acionavelAtual(r, agora);
        if (ac === 'aberta' && r._enc !== null) return 0;
        if (ac === 'fluxo-continuo') return 1;
        if (ac === 'aberta') return 2;
        return 3;
      };
      lista.sort((a, b) => faixa(a) - faixa(b) || (faixa(a) === 0 ? a._enc - b._enc : pub(b) - pub(a)));
    } else if (ord === 'recentes') {
      lista.sort((a, b) => pub(b) - pub(a));
    } else {
      const peso = (r) => (veredito(r) === 'S' ? 10 : 0) + (PESO_CATEGORIA[r.categoriaIA] ?? 0);
      lista.sort((a, b) => peso(b) - peso(a) || pub(b) - pub(a));
    }
  }

  function atualizarResumo(contagens) {
    const f = estado.filtros;
    const n = estado.filtrados.length;
    const ufTexto = ehNacional(f.part) ? 'no Brasil inteiro' : f.uf === 'todas' ? 'no Brasil' : f.uf === 'nacional' ? 'de abrangência nacional' : `em ${f.uf}`;
    const rotuloPart = f.part ? ` · ${PART_ROTULO[f.part].toLowerCase()}` : '';
    const partes = f.visao === 'abertas'
      ? [plural(contagens[''], 'oportunidade aberta', 'oportunidades abertas') + ` ${ufTexto}${rotuloPart}`, `${contagens.fomento} de fomento`, `${contagens.contratacao} contratações`]
      : [plural(contagens[''], 'item no radar', 'itens no radar') + ` ${ufTexto}${rotuloPart}`, `${contagens.contratacao} contratações decididas`, `${contagens.fomento} editais encerrados`];
    el.resumo.textContent = partes.join(' · ');
    el.contagem.textContent = f.tipo ? `${plural(n, 'item', 'itens')} nesta aba` : plural(n, 'item', 'itens');
    const temFiltro = Boolean(f.part || f.tipo || f.q || f.reg || f.mod || f.duvida) || (f.uf !== UF_PADRAO && !ehNacional(f.part)) || f.ord !== ordemPadrao(f);
    el.limpar.hidden = !temFiltro;
  }

  function renderizarMais() {
    const agora = Date.now();
    const fatia = estado.filtrados.slice(estado.visiveis, estado.visiveis + LOTE);
    const frag = document.createDocumentFragment();
    for (const r of fatia) frag.append(criarCard(r, agora));
    el.lista.append(frag);
    estado.visiveis += fatia.length;

    if (estado.filtrados.length === 0) el.lista.append(criarVazio());
    const restam = estado.filtrados.length - estado.visiveis;
    el.mais.hidden = restam <= 0;
    if (restam > 0) el.mais.textContent = `Mostrar mais (${restam.toLocaleString('pt-BR')} restantes)`;
  }

  function criarVazio() {
    const box = h('div', 'vazio');
    box.append(h('p', '', estado.filtros.visao === 'abertas' ? 'Nenhuma oportunidade aberta corresponde aos filtros.' : 'Nenhum item do radar corresponde aos filtros.'));
    box.append(h('p', 'dica', 'Tente outras palavras, troque a UF para "Todas" ou veja a outra visão.'));
    return box;
  }

  // ------------------------------------------------------------ painel do radar

  function mediana(valores) {
    const v = [...valores].sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function tabela(titulo, cabecalho, linhas) {
    const bloco = h('div', 'painel-bloco');
    bloco.append(h('h3', '', titulo));
    const t = h('table', 'painel-tabela');
    const thead = h('thead');
    const trh = h('tr');
    for (const c of cabecalho) trh.append(h('th', '', c));
    thead.append(trh);
    t.append(thead);
    const tbody = h('tbody');
    for (const linha of linhas) {
      const tr = h('tr');
      linha.forEach((c, i) => tr.append(h('td', i > 0 ? 'num' : '', c)));
      tbody.append(tr);
    }
    t.append(tbody);
    bloco.append(t);
    return bloco;
  }

  function renderizarPainelRadar(lista) {
    el.painelRadar.replaceChildren();
    if (!lista.length) return;
    const porOrgao = new Map();
    const porCat = new Map();
    for (const r of lista) {
      const o = r.orgao ?? 'Órgão não informado';
      porOrgao.set(o, (porOrgao.get(o) ?? 0) + 1);
      const c = CATEGORIA_ROTULO[r.categoriaIA] ?? r.categoriaIA ?? 'sem categoria';
      const e = porCat.get(c) ?? { n: 0, valores: [] };
      e.n++;
      if (r.valor) e.valores.push(r.valor);
      porCat.set(c, e);
    }
    const topOrgaos = [...porOrgao].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([o, n]) => [o, n.toLocaleString('pt-BR')]);
    const cats = [...porCat].sort((a, b) => b[1].n - a[1].n).map(([c, e]) => {
      const med = mediana(e.valores);
      const faixa = e.valores.length ? `${fmtMoeda.format(Math.min(...e.valores))} – ${fmtMoeda.format(Math.max(...e.valores))}` : '—';
      return [c, e.n.toLocaleString('pt-BR'), med !== null ? fmtMoeda.format(med) : '—', faixa];
    });
    const cab = h('p', 'painel-titulo', `Síntese dos ${plural(lista.length, 'item filtrado', 'itens filtrados')}`);
    el.painelRadar.append(cab);
    const grade = h('div', 'painel-grade');
    grade.append(tabela('Quem mais contrata', ['Órgão', 'Itens'], topOrgaos));
    grade.append(tabela('Por categoria (valor estimado)', ['Categoria', 'Itens', 'Mediana', 'Faixa'], cats));
    el.painelRadar.append(grade);
  }

  // ------------------------------------------------------------ card

  function criarCard(r, agora) {
    const card = h('article', `card tipo-${r._grupo}`);
    const ac = acionavelAtual(r, agora);
    const enc = r._enc;
    const aberto = ac === 'aberta' && enc !== null;
    const diasRestantes = aberto ? Math.ceil((enc - agora) / DIA_MS) : null;
    const urgente = aberto && diasRestantes <= DIAS_URGENTE;
    if (urgente) card.classList.add('urgente');
    const fomento = r._grupo === 'fomento';
    const radar = ac === 'radar' || ac === 'encerrada';
    const situacao = r.detalhes?.situacao ?? '';
    const alerta = SITUACOES_ALERTA.test(situacao);
    if (alerta) card.classList.add('cancelado');

    // linha superior: tipo, fonte, modalidade, estado
    const topo = h('div', 'card-topo');
    topo.append(h('span', `pill pill-tipo pill-tipo-${r.tipo}`, TIPO_ROTULO[r.tipo] ?? r.tipo));
    if (r.participacao && r.participacao !== 'outro') {
      const selo = h('span', `pill pill-part pill-part-${r.participacao}`, PART_ROTULO[r.participacao]);
      if (ehNacional(r.participacao)) selo.title = 'Aceita inscrição de qualquer lugar do Brasil';
      topo.append(selo);
    }
    topo.append(h('span', 'pill pill-fonte', nomeFonte(r)));
    if (r.detalhes?.modalidade) topo.append(h('span', 'pill', r.detalhes.modalidade));
    if (alerta) topo.append(h('span', 'pill pill-alerta', situacao));
    if (radar && contratacaoDireta(r)) topo.append(h('span', 'pill', 'Contratação direta'));
    else if (ac === 'encerrada') topo.append(h('span', 'pill', fomento ? 'Inscrições encerradas' : 'Prazo encerrado'));
    else if (ac === 'fluxo-continuo') topo.append(h('span', 'pill pill-aberta', 'Fluxo contínuo'));
    else if (urgente) topo.append(h('span', 'pill pill-urgente', diasRestantes <= 1 ? 'Encerra em menos de 1 dia' : `Encerra em ${diasRestantes} dias`));
    else if (aberto) topo.append(h('span', 'pill pill-aberta', fomento ? 'Inscrições abertas' : 'Propostas abertas'));
    else if (ac === 'aberta') topo.append(h('span', 'pill pill-duvida', '⚠ prazo não identificado'));
    const v = veredito(r);
    if (v === 'pendente') {
      const selo = h('span', 'pill pill-pendente', 'Não verificado');
      selo.title = 'Ainda não passou pela classificação automática; pode ser um falso positivo das palavras-chave.';
      topo.append(selo);
    } else if (v === 'D') {
      const selo = h('span', 'pill pill-duvida', 'Em dúvida');
      selo.title = 'A classificação automática não conseguiu decidir se é uma oportunidade em artes visuais.';
      topo.append(selo);
    }
    card.append(topo);

    // título (+ texto completo ou resumo); "ver mais" abre o texto inteiro e os detalhes (amparo legal etc.)
    const extraido = r.fonte === 'querido-diario' || r.fonte === 'dom-bh' || r.fonte === 'amm' || /^(minc|funarte|secult|html:)/.test(r.fonte);
    const completo = r.detalhes?.objetoCompleto && r.detalhes.objetoCompleto.length > (r.titulo ?? '').length - 1 ? r.detalhes.objetoCompleto : null;
    const titulo = h('h2', 'titulo', caixaDeSentenca(completo ?? r.titulo ?? '(sem título)'));
    card.append(titulo);
    let resumo = null;
    if (r.resumo && !completo) {
      resumo = h('p', extraido ? 'resumo resumo-destaque' : 'resumo', r.resumo);
      card.append(resumo);
    }
    const extras = [];
    if (r.detalhes?.amparoLegal) extras.push(['Amparo legal', r.detalhes.amparoLegal]);
    if (r.detalhes?.unidade && r.detalhes.unidade !== r.orgao) extras.push(['Unidade', r.detalhes.unidade]);
    if (r.detalhes?.areas?.length) extras.push(['Áreas (segundo a fonte)', r.detalhes.areas.slice(0, 4).join(', ')]);
    if (r.detalhes?.categoria) extras.push(['Categoria no diário', r.detalhes.categoria]);
    const precisaVerMais = (completo && completo.length > LIMITE_TRUNCAR) || (resumo && r.resumo.length > LIMITE_TRUNCAR) || extras.length > 0;
    let blocoExtra = null;
    if (extras.length) {
      blocoExtra = h('dl', 'dados dados-extra');
      for (const [k, val] of extras) adicionarDado(blocoExtra, k, val);
      blocoExtra.hidden = true;
    }
    if (completo && completo.length > LIMITE_TRUNCAR) titulo.classList.add('truncado');
    if (resumo && r.resumo.length > LIMITE_TRUNCAR) resumo.classList.add('truncado');

    // órgão e local
    const orgao = h('p', 'orgao');
    orgao.append(h('strong', '', r.orgao ?? 'Órgão não informado'));
    const local = [r.municipio, r.uf].filter(Boolean).join(' / ') || (r.uf ? r.uf : 'Abrangência nacional');
    orgao.append(h('span', 'local', local));
    card.append(orgao);

    // dados em grade
    const dl = h('dl', 'dados');
    if (r.valor) adicionarDado(dl, 'Valor estimado', fmtMoedaCent.format(r.valor));
    adicionarDado(dl, 'Publicado em', r._pub !== null ? fmtData.format(r._pub) : 'Não informado');
    if (fomento && r.abertura) adicionarDado(dl, 'Inscrições de', fmtData.format(paraMs(r.abertura)));
    const enviarObra = r.participacao === 'enviar-obra' || r.participacao === 'residencia';
    if (!(radar && contratacaoDireta(r))) {
      let prazoTexto = enc !== null ? (r.encerramento.length === 10 ? fmtData.format(enc) : fmtDataHora.format(enc)) : (ac === 'fluxo-continuo' ? 'Fluxo contínuo' : '⚠ prazo não identificado');
      if (enviarObra && aberto) prazoTexto += diasRestantes <= 1 ? ' (último dia)' : ` (em ${diasRestantes} dias)`;
      adicionarDado(
        dl,
        fomento || enviarObra ? 'Inscrições até' : 'Propostas até',
        prazoTexto,
        enc !== null && !aberto ? 'encerrado' : urgente ? 'destaque' : (enc === null && ac !== 'fluxo-continuo' ? 'alerta' : ''),
      );
    }
    if (r.participacao === 'enviar-obra') {
      if (r.detalhes?.taxa) adicionarDado(dl, 'Taxa de inscrição', fmtMoedaCent.format(r.detalhes.taxa));
      if (r.detalhes?.obrasPorArtista) adicionarDado(dl, 'Nº de obras', r.detalhes.obrasPorArtista);
    }
    card.append(dl);
    if (blocoExtra) card.append(blocoExtra);

    if (precisaVerMais) {
      const btn = h('button', 'link-botao ver-mais', 'ver mais');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const aberto2 = btn.getAttribute('aria-expanded') === 'true';
        titulo.classList.toggle('truncado', aberto2 && completo && completo.length > LIMITE_TRUNCAR);
        if (resumo) resumo.classList.toggle('truncado', aberto2 && r.resumo.length > LIMITE_TRUNCAR);
        if (blocoExtra) blocoExtra.hidden = aberto2;
        btn.textContent = aberto2 ? 'ver mais' : 'ver menos';
        btn.setAttribute('aria-expanded', String(!aberto2));
      });
      card.append(btn);
    }

    // categoria da IA + palavras-chave que bateram
    const ul = h('ul', 'tags');
    ul.setAttribute('aria-label', 'Categoria e palavras-chave');
    if (r.categoriaIA) ul.append(h('li', 'tag tag-categoria', CATEGORIA_ROTULO[r.categoriaIA] ?? r.categoriaIA));
    for (const t of (r.tags ?? []).filter((t) => !t.startsWith('consulta:'))) ul.append(h('li', 'tag', t));
    if (ul.children.length) card.append(ul);

    // ações
    const acoes = h('div', 'acoes');
    if (ehUrlHttp(r.link)) {
      const rotuloBotao = r.fonte === 'pncp' ? 'Ver no PNCP'
        : r.fonte.startsWith('mapas') ? 'Ver no Mapa Cultural'
          : r.fonte === 'querido-diario' ? 'Ver no Diário Oficial (PDF)'
            : r.fonte === 'dom-bh' ? 'Ver no Diário Oficial'
              : /\.pdf(\?|$)|download=/i.test(r.link) ? 'Abrir edital (PDF)' : r.fonte.startsWith('html:') ? 'Ver na instituição' : 'Ver edital';
      const a = h('a', 'botao', rotuloBotao);
      a.href = r.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acoes.append(a);
    }
    for (const extra of (r.linksExtras ?? []).filter(ehUrlHttp).slice(0, 3)) {
      const a = h('a', 'link-secundario', rotuloLinkExtra(extra));
      a.href = extra;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acoes.append(a);
    }
    const reportar = h('a', 'link-reportar', 'Classificação errada?');
    const registro = `${r.id} · ${(r.titulo ?? '').slice(0, 90)} · ${r.link}`;
    const params = new URLSearchParams({ template: 'classificacao.yml', title: `[classificação] ${(r.titulo ?? '').slice(0, 70)}`, registro });
    reportar.href = `https://github.com/${REPO}/issues/new?${params.toString()}`;
    reportar.target = '_blank';
    reportar.rel = 'noopener noreferrer';
    reportar.title = 'Abre uma issue no GitHub com o id e o título já preenchidos';
    acoes.append(reportar);
    acoes.append(h('span', 'controle', r.idNaFonte));
    card.append(acoes);

    return card;
  }

  function rotuloLinkExtra(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (/\.txt$/i.test(url)) return 'Texto do diário (.txt)';
      if (/visualizacao\/edicao/.test(url)) return 'Edição completa';
      if (host === 'pncp.gov.br') return 'Também no PNCP';
      if (/download=|\.pdf(\?|$)/i.test(url)) return 'Retificação / anexo (PDF)';
      if (/mapacultur|mapas\.cultura/.test(host)) return 'Também no Mapa Cultural';
      return `Também em ${host}`;
    } catch {
      return 'Outro link';
    }
  }

  function adicionarDado(dl, rotulo, valor, classe) {
    const div = h('div', classe ? `dado ${classe}` : 'dado');
    div.append(h('dt', '', rotulo));
    div.append(h('dd', '', valor));
    dl.append(div);
  }

  // ------------------------------------------------------------ eventos

  function aoMudarFiltro() {
    estado.filtros = {
      ...estado.filtros,
      q: el.busca.value.trim(),
      uf: el.uf.value,
      reg: el.regiao.value,
      mod: el.modalidade.value,
      duvida: el.duvida.checked,
      ord: ['prazo', 'recentes', 'relevancia'].includes(el.ordem.value) ? el.ordem.value : ordemPadrao(estado.filtros),
    };
    if (ehNacional(estado.filtros.part)) estado.filtros.uf = UF_PADRAO; // o select está travado em "Brasil inteiro"; ao sair, volta a MG
    gravarFiltrosNaUrl();
    filtrar();
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function ligarAbas(container, atributo, aoEscolher) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest(`[data-${atributo}]`);
      if (b) aoEscolher(b.dataset[atributo]);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const abas = [...container.querySelectorAll(`[data-${atributo}]`)];
      const i = abas.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      const prox = abas[(i + (e.key === 'ArrowRight' ? 1 : abas.length - 1)) % abas.length];
      prox.focus();
      prox.click();
    });
  }

  function ligarEventos() {
    el.filtros.addEventListener('submit', (e) => e.preventDefault());
    el.busca.addEventListener('input', debounce(aoMudarFiltro, 150));
    for (const c of [el.uf, el.regiao, el.modalidade, el.ordem, el.duvida]) c.addEventListener('change', aoMudarFiltro);
    ligarAbas(el.abas, 'tipo', (tipo) => {
      estado.filtros.tipo = tipo;
      aplicarFiltrosNosControles();
      gravarFiltrosNaUrl();
      filtrar();
    });
    ligarAbas(el.visoes, 'visao', (visao) => {
      if (visao === estado.filtros.visao) return;
      estado.filtros.visao = visao;
      estado.filtros.ord = ordemPadrao(estado.filtros);
      aplicarFiltrosNosControles();
      gravarFiltrosNaUrl();
      filtrar();
    });
    ligarAbas(el.participacao, 'part', (part) => {
      if (part === estado.filtros.part) return;
      estado.filtros.part = part;
      estado.filtros.uf = UF_PADRAO; // ao trocar de participação a UF volta ao padrão (nos nacionais ela é ignorada)
      estado.filtros.ord = ordemPadrao(estado.filtros);
      aplicarFiltrosNosControles();
      gravarFiltrosNaUrl();
      filtrar();
    });
    el.limpar.addEventListener('click', () => {
      estado.filtros = { visao: estado.filtros.visao, part: '', tipo: '', q: '', uf: UF_PADRAO, reg: '', mod: '', duvida: false, ord: ORDEM_PADRAO[estado.filtros.visao] };
      aplicarFiltrosNosControles();
      gravarFiltrosNaUrl();
      filtrar();
      el.busca.focus();
    });
    el.mais.addEventListener('click', renderizarMais);
    window.addEventListener('popstate', () => {
      estado.filtros = lerFiltrosDaUrl();
      aplicarFiltrosNosControles();
      filtrar();
    });
  }

  function mostrarStatus(texto, erro = false) {
    el.status.hidden = !texto;
    el.status.textContent = texto ?? '';
    el.status.classList.toggle('erro', erro);
  }

  // ------------------------------------------------------------ início

  async function iniciar() {
    estado.filtros = lerFiltrosDaUrl();
    ligarEventos();
    mostrarStatus('Carregando oportunidades…');
    try {
      const [meta, dados] = await Promise.all([
        carregarJson('data/meta.json').catch(() => null),
        carregarJson('data/oportunidades.json'),
      ]);
      if (!Array.isArray(dados)) throw new Error('oportunidades.json não é uma lista');

      estado.meta = meta;
      estado.dados = dados.map(preparar);
      estado.base = estado.dados.filter((r) => veredito(r) !== 'N'); // reprovados pela IA nunca aparecem
      mostrarRodape(meta);
      mostrarFontes(meta);

      const ufs = [...new Set(estado.base.map((r) => r.uf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      preencherSelect(el.uf, ufs.filter((u) => u !== UF_PADRAO));
      const modalidades = [...new Set(estado.base.map((r) => r.detalhes?.modalidade).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      preencherSelect(el.modalidade, modalidades);

      aplicarFiltrosNosControles();
      mostrarStatus(null);
      filtrar();
    } catch (erro) {
      console.error(erro);
      el.resumo.textContent = 'Não foi possível carregar os dados.';
      mostrarStatus('Não foi possível carregar os dados. Se você abriu o arquivo direto do disco, sirva a pasta docs por HTTP (veja o README).', true);
    }
  }

  iniciar();
})();
