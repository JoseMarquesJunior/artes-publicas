/* Artes Públicas: busca e filtros no navegador sobre docs/data/contratacoes.json.
   Vanilla JS, sem build, sem dependências. */
(() => {
  'use strict';

  const LOTE = 60;             // cards renderizados por vez
  const DIAS_URGENTE = 7;      // destaque para prazos que encerram em até N dias
  const LIMITE_TRUNCAR = 260;  // objetos maiores que isso ganham "ver mais"
  const DIA_MS = 86_400_000;

  const el = {};
  for (const id of ['busca', 'uf', 'modalidade', 'ordem', 'abertas', 'limpar', 'contagem', 'status', 'lista', 'mais', 'atualizado', 'filtros']) {
    el[id] = document.getElementById(id);
  }

  const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtDataHora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const estado = { dados: [], filtrados: [], visiveis: 0, filtros: lerFiltrosDaUrl() };

  // ------------------------------------------------------------ utilidades

  function normalizar(texto) {
    return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function paraMs(iso) {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
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

  const ehUrlHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

  // ------------------------------------------------------------ URL <-> filtros

  function lerFiltrosDaUrl() {
    const p = new URLSearchParams(location.search);
    return {
      q: p.get('q') ?? '',
      uf: p.get('uf') ?? '',
      mod: p.get('mod') ?? '',
      abertas: p.get('abertas') === '1',
      ord: p.get('ord') === 'prazo' ? 'prazo' : 'recentes',
    };
  }

  function gravarFiltrosNaUrl() {
    const f = estado.filtros;
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.uf) p.set('uf', f.uf);
    if (f.mod) p.set('mod', f.mod);
    if (f.abertas) p.set('abertas', '1');
    if (f.ord !== 'recentes') p.set('ord', f.ord);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function aplicarFiltrosNosControles() {
    const f = estado.filtros;
    el.busca.value = f.q;
    garantirOpcao(el.uf, f.uf);
    garantirOpcao(el.modalidade, f.mod);
    el.uf.value = f.uf;
    el.modalidade.value = f.mod;
    el.abertas.checked = f.abertas;
    el.ordem.value = f.ord;
  }

  /** Se a URL trouxe um valor que não existe nos dados, cria a opção para o select refletir o filtro. */
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
    r._pub = paraMs(r.dataPublicacaoPncp);
    r._enc = paraMs(r.dataEncerramentoProposta);
    r._busca = normalizar([r.objetoCompra, r.orgao, r.unidade, r.municipio, r.uf, r.numeroControlePNCP].filter(Boolean).join(' '));
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
    if (typeof meta.total === 'number') partes.push(`${plural(meta.total, 'contratação', 'contratações')} nos últimos 12 meses`);
    if (typeof meta.totalNovos === 'number' && meta.totalNovos > 0) partes.push(`${plural(meta.totalNovos, 'nova', 'novas')} na última coleta`);
    el.atualizado.textContent = partes.join(' · ');
    if (Array.isArray(meta.erros) && meta.erros.length) {
      el.atualizado.append(' ');
      const aviso = h('span', 'aviso-inline', `(a última coleta falhou em ${plural(meta.erros.length, 'consulta', 'consultas')}; alguns editais podem estar faltando)`);
      el.atualizado.append(aviso);
    }
  }

  // ------------------------------------------------------------ filtro e ordenação

  function filtrar() {
    const { q, uf, mod, abertas, ord } = estado.filtros;
    const termos = normalizar(q).split(/\s+/).filter(Boolean);
    const agora = Date.now();

    const lista = estado.dados.filter((r) => {
      if (uf && r.uf !== uf) return false;
      if (mod && r.modalidadeNome !== mod) return false;
      if (abertas && !(r._enc !== null && r._enc > agora)) return false;
      if (termos.length && !termos.every((t) => r._busca.includes(t))) return false;
      return true;
    });

    if (ord === 'prazo') {
      // Prazos futuros primeiro (mais próximo no topo); depois os sem prazo ou já encerrados, por publicação.
      lista.sort((a, b) => {
        const fa = a._enc !== null && a._enc > agora;
        const fb = b._enc !== null && b._enc > agora;
        if (fa !== fb) return fa ? -1 : 1;
        if (fa && fb) return a._enc - b._enc;
        return (b._pub ?? 0) - (a._pub ?? 0);
      });
    } else {
      lista.sort((a, b) => (b._pub ?? 0) - (a._pub ?? 0));
    }

    estado.filtrados = lista;
    estado.visiveis = 0;
    el.lista.replaceChildren();
    renderizarMais();
    atualizarContagem();
  }

  function atualizarContagem() {
    const n = estado.filtrados.length;
    const total = estado.dados.length;
    el.contagem.textContent = n === total
      ? plural(n, 'contratação', 'contratações')
      : `${plural(n, 'contratação encontrada', 'contratações encontradas')} de ${total.toLocaleString('pt-BR')}`;
    const temFiltro = Object.entries(estado.filtros).some(([k, v]) => (k === 'ord' ? v !== 'recentes' : Boolean(v)));
    el.limpar.hidden = !temFiltro;
  }

  function renderizarMais() {
    const agora = Date.now();
    const fatia = estado.filtrados.slice(estado.visiveis, estado.visiveis + LOTE);
    const frag = document.createDocumentFragment();
    for (const r of fatia) frag.append(criarCard(r, agora));
    el.lista.append(frag);
    estado.visiveis += fatia.length;

    if (estado.filtrados.length === 0) {
      el.lista.append(criarVazio());
    }
    const restam = estado.filtrados.length - estado.visiveis;
    el.mais.hidden = restam <= 0;
    if (restam > 0) el.mais.textContent = `Mostrar mais (${restam.toLocaleString('pt-BR')} restantes)`;
  }

  function criarVazio() {
    const box = h('div', 'vazio');
    box.append(h('p', '', 'Nenhuma contratação corresponde aos filtros.'));
    box.append(h('p', 'dica', 'Tente outras palavras, remova o filtro de UF ou desligue "Só com propostas abertas".'));
    return box;
  }

  // ------------------------------------------------------------ card

  function criarCard(r, agora) {
    const card = h('article', 'card');
    const enc = r._enc;
    const aberto = enc !== null && enc > agora;
    const diasRestantes = aberto ? Math.ceil((enc - agora) / DIA_MS) : null;
    const urgente = aberto && diasRestantes <= DIAS_URGENTE;
    if (urgente) card.classList.add('urgente');

    // linha superior: modalidade, situação e estado do prazo
    const topo = h('div', 'card-topo');
    topo.append(h('span', 'pill pill-modalidade', r.modalidadeNome ?? 'Modalidade não informada'));
    if (r.situacaoCompraNome) topo.append(h('span', 'pill', r.situacaoCompraNome));
    if (urgente) {
      topo.append(h('span', 'pill pill-urgente', diasRestantes <= 1 ? 'Encerra em menos de 1 dia' : `Encerra em ${diasRestantes} dias`));
    } else if (aberto) {
      topo.append(h('span', 'pill pill-aberta', 'Propostas abertas'));
    }
    card.append(topo);

    // objeto, com truncamento
    const objeto = h('p', 'objeto', r.objetoCompra || '(objeto não informado)');
    card.append(objeto);
    if ((r.objetoCompra ?? '').length > LIMITE_TRUNCAR) {
      objeto.classList.add('truncado');
      const btn = h('button', 'link-botao ver-mais', 'ver mais');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const truncado = objeto.classList.toggle('truncado');
        btn.textContent = truncado ? 'ver mais' : 'ver menos';
        btn.setAttribute('aria-expanded', String(!truncado));
      });
      card.append(btn);
    }

    // órgão e local
    const orgao = h('p', 'orgao');
    orgao.append(h('strong', '', r.orgao ?? 'Órgão não informado'));
    const local = [r.municipio, r.uf].filter(Boolean).join(' / ');
    if (local) orgao.append(h('span', 'local', local));
    card.append(orgao);

    // dados em grade
    const dl = h('dl', 'dados');
    adicionarDado(dl, 'Valor estimado', r.valorTotalEstimado ? fmtMoeda.format(r.valorTotalEstimado) : 'Não informado');
    adicionarDado(dl, 'Publicado em', r._pub !== null ? fmtData.format(r._pub) : 'Não informado');
    adicionarDado(
      dl,
      'Encerramento das propostas',
      enc !== null ? fmtDataHora.format(enc) : 'Não informado',
      enc !== null && !aberto ? 'encerrado' : urgente ? 'destaque' : '',
    );
    if (r.amparoLegal) adicionarDado(dl, 'Amparo legal', r.amparoLegal);
    card.append(dl);

    // palavras-chave que bateram
    if (Array.isArray(r.tags) && r.tags.length) {
      const ul = h('ul', 'tags');
      ul.setAttribute('aria-label', 'Palavras-chave encontradas');
      for (const t of r.tags) ul.append(h('li', 'tag', t));
      card.append(ul);
    }

    // ações
    const acoes = h('div', 'acoes');
    if (ehUrlHttp(r.linkPncp)) {
      const a = h('a', 'botao', 'Ver no PNCP');
      a.href = r.linkPncp;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acoes.append(a);
    }
    if (ehUrlHttp(r.linkSistemaOrigem)) {
      const a = h('a', 'link-secundario', 'Sistema de origem');
      a.href = r.linkSistemaOrigem;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acoes.append(a);
    }
    acoes.append(h('span', 'controle', r.numeroControlePNCP));
    card.append(acoes);

    return card;
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
      q: el.busca.value.trim(),
      uf: el.uf.value,
      mod: el.modalidade.value,
      abertas: el.abertas.checked,
      ord: el.ordem.value === 'prazo' ? 'prazo' : 'recentes',
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
    for (const c of [el.uf, el.modalidade, el.ordem, el.abertas]) c.addEventListener('change', aoMudarFiltro);
    el.limpar.addEventListener('click', () => {
      el.busca.value = '';
      el.uf.value = '';
      el.modalidade.value = '';
      el.abertas.checked = false;
      el.ordem.value = 'recentes';
      aoMudarFiltro();
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
    mostrarStatus('Carregando contratações…');
    try {
      const [meta, dados] = await Promise.all([
        carregarJson('data/meta.json').catch(() => null),
        carregarJson('data/contratacoes.json'),
      ]);
      if (!Array.isArray(dados)) throw new Error('contratacoes.json não é uma lista');

      estado.dados = dados.map(preparar);
      mostrarAtualizado(meta);

      const ufs = [...new Set(estado.dados.map((r) => r.uf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      const modalidades = [...new Set(estado.dados.map((r) => r.modalidadeNome).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      preencherSelect(el.uf, ufs);
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
