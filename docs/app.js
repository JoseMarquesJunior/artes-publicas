/* Artes Públicas: busca e filtros no navegador sobre docs/data/oportunidades.json.
   Vanilla JS, sem build, sem dependências. */
(() => {
  'use strict';

  const LOTE = 60;             // cards renderizados por vez
  const DIAS_URGENTE = 7;      // destaque para prazos que encerram em até N dias
  const LIMITE_TRUNCAR = 220;  // textos maiores que isso ganham "ver mais"
  const DIA_MS = 86_400_000;
  const UF_PADRAO = 'MG';

  const TIPO_ROTULO = { contratacao: 'Contratação', fomento: 'Fomento', premio: 'Prêmio', residencia: 'Residência', chamamento: 'Chamamento', outro: 'Outro' };
  const GRUPO_FOMENTO = new Set(['fomento', 'premio', 'residencia', 'chamamento']);
  // Peso da categoria na ordenação por relevância: categorias claramente de artes visuais primeiro,
  // fomento amplo e produção depois, "outro"/sem categoria por último. Empates: mais recente primeiro.
  const ORDEM_PADRAO = 'relevancia';
  const PESO_CATEGORIA = {
    exposicao: 3, curadoria: 3, mural: 3, ilustracao: 3, restauro: 3, design: 3, oficina: 3, premio: 3, residencia: 3,
    'fomento-geral': 2, producao: 1, outro: 0,
  };
  const CATEGORIA_ROTULO = {
    curadoria: 'curadoria', oficina: 'oficina', design: 'design', ilustracao: 'ilustração', mural: 'mural', restauro: 'restauro',
    exposicao: 'exposição', premio: 'prêmio', residencia: 'residência', 'fomento-geral': 'fomento geral', producao: 'produção', outro: 'outro',
  };

  const el = {};
  for (const id of ['busca', 'uf', 'regiao', 'modalidade', 'ordem', 'abertas', 'duvida', 'limpar', 'contagem', 'status', 'lista', 'mais', 'atualizado', 'filtros', 'abas', 'fontes-aviso']) {
    el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }

  const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtDataHora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // dados: tudo que veio do JSON; base: o que pode aparecer (os "N" da IA nunca são exibidos).
  const estado = { dados: [], base: [], filtrados: [], visiveis: 0, filtros: lerFiltrosDaUrl() };

  // ------------------------------------------------------------ utilidades

  const veredito = (r) => (r.ia === 'S' || r.ia === 'N' || r.ia === 'D' ? r.ia : 'pendente');
  const grupoTipo = (r) => (r.tipo === 'contratacao' ? 'contratacao' : GRUPO_FOMENTO.has(r.tipo) ? 'fomento' : 'outro');
  const ehUrlHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

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

  function nomeFonte(r) {
    if (r.fonte === 'pncp') return 'PNCP';
    if (r.detalhes?.fonteNome) return r.detalhes.fonteNome;
    if (r.fonte.startsWith('mapas')) return 'Mapa Cultural';
    if (r.fonte === 'querido-diario') return 'Diário Oficial';
    return r.fonte;
  }

  // ------------------------------------------------------------ URL <-> filtros

  function lerFiltrosDaUrl() {
    const p = new URLSearchParams(location.search);
    const tipo = p.get('tipo');
    return {
      tipo: tipo === 'contratacao' || tipo === 'fomento' ? tipo : '',
      q: p.get('q') ?? '',
      uf: p.get('uf') ?? UF_PADRAO,
      reg: ['Grande BH', 'Inconfidentes', 'Outras'].includes(p.get('regiao')) ? p.get('regiao') : '',
      mod: p.get('mod') ?? '',
      abertas: p.get('abertas') === '1',
      duvida: p.get('duvida') === '1',
      ord: ['prazo', 'recentes', 'relevancia'].includes(p.get('ord')) ? p.get('ord') : ORDEM_PADRAO,
    };
  }

  function gravarFiltrosNaUrl() {
    const f = estado.filtros;
    const p = new URLSearchParams();
    if (f.tipo) p.set('tipo', f.tipo);
    if (f.q) p.set('q', f.q);
    if (f.uf !== UF_PADRAO) p.set('uf', f.uf);
    if (f.reg) p.set('regiao', f.reg);
    if (f.mod) p.set('mod', f.mod);
    if (f.abertas) p.set('abertas', '1');
    if (f.duvida) p.set('duvida', '1');
    if (f.ord !== ORDEM_PADRAO) p.set('ord', f.ord);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function aplicarFiltrosNosControles() {
    const f = estado.filtros;
    el.busca.value = f.q;
    garantirOpcao(el.uf, f.uf);
    garantirOpcao(el.modalidade, f.mod);
    el.uf.value = f.uf;
    el.regiao.value = f.reg;
    el.modalidade.value = f.mod;
    el.abertas.checked = f.abertas;
    el.duvida.checked = f.duvida;
    el.ordem.value = f.ord;
    for (const b of el.abas.querySelectorAll('[data-tipo]')) {
      const ativo = b.dataset.tipo === f.tipo;
      b.setAttribute('aria-selected', String(ativo));
      b.tabIndex = ativo ? 0 : -1;
    }
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

  function mostrarAtualizado(meta) {
    const d = meta?.atualizadoEm ? new Date(meta.atualizadoEm) : null;
    if (!d || Number.isNaN(d.getTime())) {
      el.atualizado.textContent = 'Data da última atualização indisponível.';
      return;
    }
    const partes = [`Atualizado em ${fmtData.format(d)} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`];
    const aprovadas = estado.dados.filter((r) => veredito(r) === 'S').length;
    partes.push(`${plural(aprovadas, 'oportunidade confirmada', 'oportunidades confirmadas')} nos últimos 12 meses`);
    if (typeof meta.totalNovos === 'number' && meta.totalNovos > 0) partes.push(`${plural(meta.totalNovos, 'nova candidata', 'novas candidatas')} na última coleta`);
    el.atualizado.textContent = partes.join(' · ');
    const porFonte = meta.errosPorFonte && typeof meta.errosPorFonte === 'object' ? Object.entries(meta.errosPorFonte) : [];
    if (porFonte.length) {
      const nomes = new Map((meta.fontes ?? []).map((f) => [f.fonte, f.nome]));
      const trechos = porFonte.map(([fonte, e]) => {
        const nome = nomes.get(fonte) ?? fonte;
        if (e.completa) return `${nome} (fora do ar)`;
        return e.total ? `${nome} (${e.falhas} de ${e.total} consultas falharam)` : `${nome} (coleta parcial)`;
      });
      el.atualizado.append(' ');
      el.atualizado.append(h('span', 'aviso-inline', `Na última coleta: ${trechos.join('; ')}. O que falhou é tentado de novo no dia seguinte.`));
    } else if (Array.isArray(meta.erros) && meta.erros.length) {
      el.atualizado.append(' ');
      el.atualizado.append(h('span', 'aviso-inline', 'A última coleta teve falhas parciais; o que falhou é tentado de novo no dia seguinte.'));
    }
  }

  function mostrarFontes(meta) {
    const ativas = Array.isArray(meta?.fontes) ? meta.fontes.filter((f) => f.ativo) : [];
    if (!ativas.length) return; // mantém o texto padrão do HTML
    const nomes = ativas.map((f) => (f.tipo === 'pncp' ? `${f.nome} (contratações de serviço)` : f.bloqueadoNoCI ? `${f.nome} (atualização manual)` : f.nome));
    el.fontesAviso.textContent = `Fontes ativas: ${nomes.join(', ')}. Editais de fomento e prêmios publicados em outros canais (Lei Paulo Gustavo, PNAB estaduais, editais de secretarias sem Mapa Cultural) ainda não aparecem aqui.`;
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
    const { tipo, q, uf, reg, mod, abertas, duvida, ord } = estado.filtros;
    const termos = normalizar(q).split(/\s+/).filter(Boolean);
    const agora = Date.now();

    const semTipo = estado.base.filter((r) => {
      if (!duvida && veredito(r) === 'D') return false;
      if (!passaUf(r, uf)) return false;
      if (reg && (r.regiao ?? (r.uf ? 'Outras' : null)) !== reg) return false;
      if (mod && r.detalhes?.modalidade !== mod) return false;
      if (abertas && !(r._enc !== null && r._enc > agora)) return false;
      if (termos.length && !termos.every((t) => r._busca.includes(t))) return false;
      return true;
    });

    const contagens = { '': semTipo.length, contratacao: 0, fomento: 0 };
    for (const r of semTipo) if (r._grupo in contagens) contagens[r._grupo]++;
    for (const b of el.abas.querySelectorAll('[data-tipo]')) {
      const n = b.querySelector('.aba-n');
      if (n) n.textContent = (contagens[b.dataset.tipo] ?? 0).toLocaleString('pt-BR');
    }

    const lista = tipo ? semTipo.filter((r) => r._grupo === tipo) : semTipo;

    if (ord === 'prazo') {
      // Prazos futuros primeiro (mais próximo no topo); depois os sem prazo ou já encerrados, por publicação.
      lista.sort((a, b) => {
        const fa = a._enc !== null && a._enc > agora;
        const fb = b._enc !== null && b._enc > agora;
        if (fa !== fb) return fa ? -1 : 1;
        if (fa && fb) return a._enc - b._enc;
        return (b._pub ?? 0) - (a._pub ?? 0);
      });
    } else if (ord === 'recentes') {
      lista.sort((a, b) => (b._pub ?? 0) - (a._pub ?? 0));
    } else {
      // relevância: aprovados antes dos em dúvida/não verificados; categoria forte antes de "outro"; depois mais recentes
      const peso = (r) => (veredito(r) === 'S' ? 10 : 0) + (PESO_CATEGORIA[r.categoriaIA] ?? 0);
      lista.sort((a, b) => peso(b) - peso(a) || (b._pub ?? 0) - (a._pub ?? 0));
    }

    estado.filtrados = lista;
    estado.visiveis = 0;
    el.lista.replaceChildren();
    renderizarMais();
    atualizarContagem();
  }

  function atualizarContagem() {
    const n = estado.filtrados.length;
    const total = estado.base.filter((r) => estado.filtros.duvida || veredito(r) !== 'D').length;
    el.contagem.textContent = n === total
      ? plural(n, 'oportunidade', 'oportunidades')
      : `${plural(n, 'oportunidade encontrada', 'oportunidades encontradas')} de ${total.toLocaleString('pt-BR')}`;
    const f = estado.filtros;
    const temFiltro = Boolean(f.tipo || f.q || f.reg || f.mod || f.abertas || f.duvida) || f.uf !== UF_PADRAO || f.ord !== ORDEM_PADRAO;
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
    box.append(h('p', '', 'Nenhuma oportunidade corresponde aos filtros.'));
    box.append(h('p', 'dica', 'Tente outras palavras, troque a UF para "Todas" ou desligue "Só com prazo aberto".'));
    return box;
  }

  // ------------------------------------------------------------ card

  function criarCard(r, agora) {
    const card = h('article', `card tipo-${r._grupo}`);
    const enc = r._enc;
    const aberto = enc !== null && enc > agora;
    const diasRestantes = aberto ? Math.ceil((enc - agora) / DIA_MS) : null;
    const urgente = aberto && diasRestantes <= DIAS_URGENTE;
    if (urgente) card.classList.add('urgente');
    const fomento = r._grupo === 'fomento';

    // linha superior: tipo, fonte, situação e estado do prazo
    const topo = h('div', 'card-topo');
    topo.append(h('span', `pill pill-tipo pill-tipo-${r.tipo}`, TIPO_ROTULO[r.tipo] ?? r.tipo));
    topo.append(h('span', 'pill pill-fonte', nomeFonte(r)));
    if (r.detalhes?.modalidade) topo.append(h('span', 'pill', r.detalhes.modalidade));
    if (r.detalhes?.situacao) topo.append(h('span', 'pill', r.detalhes.situacao));
    if (r.detalhes?.fluxoContinuo) topo.append(h('span', 'pill pill-aberta', 'Fluxo contínuo'));
    if (urgente) {
      topo.append(h('span', 'pill pill-urgente', diasRestantes <= 1 ? 'Encerra em menos de 1 dia' : `Encerra em ${diasRestantes} dias`));
    } else if (aberto) {
      topo.append(h('span', 'pill pill-aberta', fomento ? 'Inscrições abertas' : 'Propostas abertas'));
    }
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

    // título (+ texto completo ou resumo, com "ver mais"). No Diário Oficial o título vem da IA e o resumo é o destaque.
    const diario = r.fonte === 'querido-diario' || r.fonte === 'dom-bh' || /^html:|^minc$|^funarte$|^secult/.test(r.fonte); // fontes em que a IA extraiu o conteúdo
    const completo = r.detalhes?.objetoCompleto && r.detalhes.objetoCompleto.length > (r.titulo ?? '').length - 1 ? r.detalhes.objetoCompleto : null;
    const titulo = h('h2', 'titulo', completo ?? r.titulo ?? '(sem título)');
    card.append(titulo);
    if (completo && completo.length > LIMITE_TRUNCAR) adicionarVerMais(card, titulo);
    if (r.resumo && !completo) {
      const resumo = h('p', diario ? 'resumo resumo-destaque' : 'resumo', r.resumo);
      card.append(resumo);
      if (r.resumo.length > LIMITE_TRUNCAR) adicionarVerMais(card, resumo);
    }

    // órgão e local
    const orgao = h('p', 'orgao');
    orgao.append(h('strong', '', r.orgao ?? 'Órgão não informado'));
    const local = [r.municipio, r.uf].filter(Boolean).join(' / ') || (r.uf ? r.uf : 'Abrangência nacional');
    orgao.append(h('span', 'local', local));
    card.append(orgao);

    // dados em grade
    const dl = h('dl', 'dados');
    if (r.valor) adicionarDado(dl, 'Valor estimado', fmtMoeda.format(r.valor));
    adicionarDado(dl, 'Publicado em', r._pub !== null ? fmtData.format(r._pub) : 'Não informado');
    if (fomento && r.abertura) adicionarDado(dl, 'Inscrições de', fmtData.format(paraMs(r.abertura)));
    adicionarDado(
      dl,
      fomento ? 'Inscrições até' : 'Propostas até',
      enc !== null ? (r.encerramento.length === 10 ? fmtData.format(enc) : fmtDataHora.format(enc)) : (r.detalhes?.fluxoContinuo ? 'Fluxo contínuo' : diario ? '⚠ prazo não identificado' : 'Não informado'),
      enc !== null && !aberto ? 'encerrado' : urgente ? 'destaque' : (enc === null && diario ? 'alerta' : ''),
    );
    if (r.detalhes?.amparoLegal) adicionarDado(dl, 'Amparo legal', r.detalhes.amparoLegal);
    if (r.detalhes?.areas?.length) adicionarDado(dl, 'Áreas (segundo a fonte)', r.detalhes.areas.slice(0, 4).join(', '));
    card.append(dl);

    // categoria da IA + palavras-chave que bateram
    const ul = h('ul', 'tags');
    ul.setAttribute('aria-label', 'Categoria e palavras-chave');
    if (r.categoriaIA) ul.append(h('li', 'tag tag-categoria', CATEGORIA_ROTULO[r.categoriaIA] ?? r.categoriaIA));
    for (const t of (r.tags ?? []).filter((t) => !t.startsWith('consulta:'))) ul.append(h('li', 'tag', t)); // as consultas do diário são internas
    if (ul.children.length) card.append(ul);

    // ações
    const acoes = h('div', 'acoes');
    if (ehUrlHttp(r.link)) {
      const rotuloBotao = r.fonte === 'pncp' ? 'Ver no PNCP'
        : r.fonte.startsWith('mapas') ? 'Ver no Mapa Cultural'
          : r.fonte === 'querido-diario' ? 'Ver no Diário Oficial (PDF)'
            : r.fonte === 'dom-bh' ? 'Ver no Diário Oficial'
              : /\.pdf(\?|$)|download=/i.test(r.link) ? 'Abrir edital (PDF)' : 'Ver edital';
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

  function adicionarVerMais(card, alvo) {
    alvo.classList.add('truncado');
    const btn = h('button', 'link-botao ver-mais', 'ver mais');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      const truncado = alvo.classList.toggle('truncado');
      btn.textContent = truncado ? 'ver mais' : 'ver menos';
      btn.setAttribute('aria-expanded', String(!truncado));
    });
    card.append(btn);
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
      abertas: el.abertas.checked,
      duvida: el.duvida.checked,
      ord: ['prazo', 'recentes', 'relevancia'].includes(el.ordem.value) ? el.ordem.value : ORDEM_PADRAO,
    };
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

  function ligarEventos() {
    el.filtros.addEventListener('submit', (e) => e.preventDefault());
    el.busca.addEventListener('input', debounce(aoMudarFiltro, 150));
    for (const c of [el.uf, el.regiao, el.modalidade, el.ordem, el.abertas, el.duvida]) c.addEventListener('change', aoMudarFiltro);
    el.abas.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tipo]');
      if (!b) return;
      estado.filtros.tipo = b.dataset.tipo;
      aplicarFiltrosNosControles();
      gravarFiltrosNaUrl();
      filtrar();
    });
    el.abas.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const abas = [...el.abas.querySelectorAll('[data-tipo]')];
      const i = abas.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      const prox = abas[(i + (e.key === 'ArrowRight' ? 1 : abas.length - 1)) % abas.length];
      prox.focus();
      prox.click();
    });
    el.limpar.addEventListener('click', () => {
      estado.filtros = { tipo: '', q: '', uf: UF_PADRAO, reg: '', mod: '', abertas: false, duvida: false, ord: ORDEM_PADRAO };
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
    ligarEventos();
    mostrarStatus('Carregando oportunidades…');
    try {
      const [meta, dados] = await Promise.all([
        carregarJson('data/meta.json').catch(() => null),
        carregarJson('data/oportunidades.json'),
      ]);
      if (!Array.isArray(dados)) throw new Error('oportunidades.json não é uma lista');

      estado.dados = dados.map(preparar);
      estado.base = estado.dados.filter((r) => veredito(r) !== 'N'); // reprovados pela IA nunca aparecem
      mostrarAtualizado(meta);
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
      el.atualizado.textContent = 'Não foi possível carregar os dados.';
      mostrarStatus('Não foi possível carregar os dados. Se você abriu o arquivo direto do disco, sirva a pasta docs por HTTP (veja o README).', true);
    }
  }

  iniciar();
})();
