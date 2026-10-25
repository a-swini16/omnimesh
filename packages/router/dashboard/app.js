// OmniMesh operator dashboard. Plain browser JavaScript, no dependencies, no network calls except
// to this router's own /_omnimesh API. Every value is rendered as text (textContent); no HTML strings are ever parsed.
(function () {
  'use strict';

  const TOKEN_KEY = 'omnimesh.statusToken';
  const THEME_KEY = 'omnimesh.theme';
  const POLL_MS = 3000;

  const state = {
    token: null,
    status: null,
    catalog: null,
    route: 'overview',
    failures: 0,
    lastOk: 0,
    timer: null,
    eventFilter: 'all',
    providerFilter: 'all',
    providerSearch: '',
    builder: null,
    pendingBuilderAdd: null,
  };

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);

  function storage(kind) {
    try {
      return kind === 'session' ? window.sessionStorage : window.localStorage;
    } catch (e) {
      return null;
    }
  }
  function getItem(kind, key) {
    try {
      const s = storage(kind);
      return s ? s.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }
  function setItem(kind, key, value) {
    try {
      const s = storage(kind);
      if (!s) return;
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    } catch (e) {
      /* storage blocked: the dashboard still works for this page view */
    }
  }

  /** h('div', { class: 'x', text: 'y', onclick: fn, attrs: {...} }, ...children) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'attrs') for (const [ak, av] of Object.entries(v)) el.setAttribute(ak, String(av));
        else if (k === 'style') Object.assign(el.style, v);
        else el[k] = v;
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    overview: [['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
    routing: [['circle', { cx: 5, cy: 12, r: 2 }], ['circle', { cx: 19, cy: 6, r: 2 }], ['circle', { cx: 19, cy: 18, r: 2 }], ['path', { d: 'M7 12h4l6-5M11 12l6 5' }]],
    gauge: [['path', { d: 'M12 14l4-4' }], ['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }]],
    health: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    activity: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
    providers: [['rect', { x: 2, y: 3, width: 20, height: 8, rx: 2 }], ['rect', { x: 2, y: 13, width: 20, height: 8, rx: 2 }], ['path', { d: 'M6 7h.01M6 17h.01' }]],
    setup: [['path', { d: 'M9 11l3 3L22 4' }], ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }]],
    settings: [['path', { d: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' }]],
    moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z' }]],
    logout: [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9' }]],
    menu: [['path', { d: 'M3 6h18M3 12h18M3 18h18' }]],
    copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
    check: [['path', { d: 'M20 6L9 17l-5-5' }]],
    x: [['path', { d: 'M18 6L6 18M6 6l12 12' }]],
    external: [['path', { d: 'M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M21 21l-4.35-4.35' }]],
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }], ['path', { d: 'M12 9v4M12 17h.01' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }]],
    minus: [['path', { d: 'M5 12h14' }]],
  };
  function icon(name, size) {
    const s = size || 16;
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
      svg.setAttribute(k, String(v));
    }
    for (const [tag, attrs] of ICONS[name] || []) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
      svg.appendChild(child);
    }
    return svg;
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const plural = (n, word) => fmt(n) + ' ' + word + (n === 1 ? '' : 's');
  const gb = (n) => (n >= 1000 && n % 1000 === 0 ? n / 1000 + ' TB' : n + ' GB');
  function minutes(m) {
    if (m >= 1440 && m % 1440 === 0) return plural(m / 1440, 'day');
    if (m >= 60 && m % 60 === 0) return plural(m / 60, 'hour');
    return m + ' min';
  }
  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'k';
    return String(n);
  }
  function ms(n) {
    if (n === null || n === undefined) return '–';
    return n >= 1000 ? (n / 1000).toFixed(2).replace(/\.?0+$/, '') + ' s' : Math.round(n) + ' ms';
  }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function duration(s) {
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
  }
  function bytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 1800);
  }

  function copyText(text) {
    const done = () => toast('Copied to clipboard');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const ta = h('textarea', { value: text, attrs: { readonly: '' }, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      toast('Select the text and copy it manually');
    }
    ta.remove();
  }

  // ---------------------------------------------------------------- domain helpers

  function providerColor(id) {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return 'hsl(' + hash + ' 62% 48%)';
  }
  function monogram(name) {
    const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + ((words[1] || words[0] || '?')[words[1] ? 0 : 1] || '')).toUpperCase();
  }
  function tile(id, name, size) {
    return h('div', { class: 'mono-tile', text: monogram(name), style: { background: providerColor(id), width: size ? size + 'px' : '', height: size ? size + 'px' : '' } });
  }

  function limitsSummary(l) {
    if (!l) return '';
    const parts = [];
    if (l.requestsPerDay) parts.push(compact(l.requestsPerDay) + ' requests/day');
    else if (l.requestsPerMonth) parts.push(compact(l.requestsPerMonth) + ' requests/month');
    if (l.bandwidthGbPerMonth) parts.push(gb(l.bandwidthGbPerMonth) + '/month');
    if (l.ramMb) parts.push(l.ramMb >= 1024 ? l.ramMb / 1024 + ' GB RAM' : l.ramMb + ' MB RAM');
    if (l.storageMb && parts.length < 3) parts.push(l.storageMb >= 1024 ? l.storageMb / 1024 + ' GB storage' : l.storageMb + ' MB storage');
    if (l.sleepsIfIdle) parts.push(l.idleSleepMinutes ? 'sleeps after ' + minutes(l.idleSleepMinutes) + ' idle' : 'sleeps when idle');
    return parts.slice(0, 3).join(' · ');
  }

  /** serving | standby | down | quota */
  function nodeState(n) {
    if (n.state === 'down') return 'down';
    if (n.quota && n.quota.percentUsed >= 95) return 'quota';
    if (n.state === 'healthy') return 'serving';
    return 'standby';
  }
  const STATE_VIEW = {
    serving: { cls: 'ok', label: 'Serving' },
    standby: { cls: 'idle', label: 'Standby' },
    down: { cls: 'bad', label: 'Down' },
    quota: { cls: 'warn', label: 'Quota reached' },
  };
  function statePill(n) {
    const v = STATE_VIEW[nodeState(n)];
    return h('span', { class: 'pill ' + v.cls, text: v.label });
  }
  function stateDot(n) {
    const v = STATE_VIEW[nodeState(n)];
    return h('span', { class: 'dot ' + (v.cls === 'idle' ? '' : v.cls) });
  }

  function allNodes(status) {
    const out = [];
    for (const p of status.pools) for (const n of p.nodes) out.push(Object.assign({ pool: p.prefix }, n));
    return out;
  }

  function alerts(status) {
    const list = [];
    const seenQuota = new Set();
    for (const n of allNodes(status)) {
      if (n.state === 'down') {
        list.push({ cls: 'bad', text: n.label + ' is down in ' + n.pool + (n.failureReason ? ' (' + n.failureReason + ')' : '') + '. Traffic is going to the other nodes.' });
      }
      if (n.quota && !seenQuota.has(n.label)) {
        if (n.quota.percentUsed >= 95) {
          seenQuota.add(n.label);
          list.push({ cls: 'warn', text: n.label + ' reached its free quota (' + n.quota.percentUsed + '%). Traffic moved to the next free tier.' });
        } else if (n.quota.percentUsed >= 80) {
          seenQuota.add(n.label);
          list.push({ cls: 'warn', text: n.label + ' has used ' + n.quota.percentUsed + '% of its free quota. Traffic moves on at 95%.' });
        }
      }
    }
    return list;
  }

  function banners(status) {
    const list = alerts(status);
    if (!list.length) return null;
    return h('div', { class: 'stack' }, list.map((a) => h('div', { class: 'banner ' + a.cls, attrs: { role: 'status' } }, h('span', { class: 'dot ' + a.cls }), h('span', { text: a.text }))));
  }

  const EVENT_TEXT = {
    node_down: (e) => e.node + ' went down in ' + e.pool + (e.detail ? ': ' + e.detail : ''),
    node_up: (e) => e.node + ' recovered in ' + e.pool,
    failover: (e) => 'Failover: ' + e.node + ' answered for ' + e.pool + (e.detail ? ' (' + e.detail + ')' : ''),
    outage: (e) => 'No node could answer in ' + e.pool + '; clients got a clean 503',
    quota_limit: (e) => e.node + ' reached 95% of its free quota in ' + e.pool + '; traffic moved to the next free tier',
  };
  const EVENT_DOT = { node_down: 'bad', node_up: 'ok', failover: 'warn', outage: 'bad', quota_limit: 'warn' };
  const EVENT_FILTERS = [
    ['all', 'All'],
    ['node_down', 'Down'],
    ['node_up', 'Recovered'],
    ['failover', 'Failovers'],
    ['quota_limit', 'Quota'],
    ['outage', 'Outages'],
  ];

  function eventList(events, emptyText) {
    if (!events.length) {
      return h('div', { class: 'empty' }, h('strong', { text: 'All quiet' }), emptyText || 'Failovers, outages and quota switches will appear here.');
    }
    return h(
      'div',
      { class: 'events' },
      events.map((e) =>
        h(
          'div',
          { class: 'event' },
          h('span', { class: 'when', text: ago(e.at), title: new Date(e.at).toLocaleString() }),
          h('span', { class: 'dot ' + (EVENT_DOT[e.kind] || '') }),
          h('span', { text: (EVENT_TEXT[e.kind] || ((x) => x.kind))(e) }),
          e.count > 1 ? h('span', { class: 'count', text: '×' + fmt(e.count) }) : h('span')
        )
      )
    );
  }

  function quotaBar(q) {
    const limit = q.requestsPerDay || q.requestsPerMonth;
    const used = q.requestsPerDay ? q.usedToday : q.usedThisMonth;
    const cls = q.percentUsed >= 95 ? 'bad' : q.percentUsed >= 80 ? 'warn' : '';
    return h(
      'div',
      null,
      h('div', { class: 'bar-label' }, h('span', { text: fmt(used) + ' / ' + fmt(limit) + (q.requestsPerDay ? ' per day' : ' per month') }), h('span', { text: q.percentUsed + '%' })),
      h('div', { class: 'bar', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': q.percentUsed } }, h('span', { class: cls, style: { width: Math.min(100, q.percentUsed) + '%' } }))
    );
  }

  function card(title, body, extra) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: title }), h('span', { class: 'spacer' }), extra || null), body);
  }

  function kpi(label, value, sub, iconName) {
    return h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, iconName ? icon(iconName, 14) : null, label), h('div', { class: 'kpi-value', text: value }), h('div', { class: 'kpi-sub', text: sub || '' }));
  }

  // ---------------------------------------------------------------- pages

  const PAGES = {
    overview: {
      title: 'Overview',
      sub: 'Live state of your free-tier mesh',
      group: 'Monitor',
      icon: 'overview',
      render(view, s) {
        const t = s.totals;
        const nodes = allNodes(s);
        const down = nodes.filter((n) => n.state === 'down').length;
        const serving = nodes.filter((n) => nodeState(n) === 'serving').length;
        const atQuota = nodes.filter((n) => nodeState(n) === 'quota').length;
        const rate = t.requests ? (t.succeeded / t.requests) * 100 : null;

        append(view, [
          banners(s),
          h(
            'div',
            { class: 'kpis', style: { marginTop: alerts(s).length ? '16px' : '0' } },
            kpi('Requests', fmt(t.requests), fmt(t.rateLimited) + ' rate-limited · ' + fmt(t.rejected) + ' rejected', 'activity'),
            kpi('Success rate', rate === null ? '–' : rate.toFixed(rate >= 99.95 || rate < 10 ? 1 : 2) + '%', fmt(t.failed) + ' failed', 'check'),
            kpi('Failovers', fmt(t.failovers), 'answered by another node', 'routing'),
            kpi('Latency p95', s.latency.samples ? ms(s.latency.p95) : '–', s.latency.samples ? 'p50 ' + ms(s.latency.p50) + ' · p99 ' + ms(s.latency.p99) : 'no requests yet', 'health'),
            kpi('Nodes up', nodes.length - down + ' / ' + nodes.length, [down && down + ' down', serving + ' serving', atQuota && atQuota + ' at quota', nodes.length - down - serving - atQuota + ' standby'].filter(Boolean).join(' · '), 'providers')
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Mesh map' }), h('span', { class: 'count', text: s.routerConfig.strategy === 'weighted' ? 'weighted load balancing' : 'priority failover' })),
          meshMap(s),
          h(
            'div',
            { class: 'grid-2', style: { marginTop: '16px' } },
            card('Recent incidents', eventList(s.events.slice(0, 6), 'No incidents on this router instance.'), h('a', { href: '#/activity', text: 'View all' })),
            card('Free-tier usage', freeTierSummary(s), h('a', { href: '#/free-tiers', text: 'Details' }))
          ),
        ]);
      },
    },

    routing: {
      title: 'Routing',
      sub: 'Pools, nodes and how traffic is spread',
      group: 'Monitor',
      icon: 'routing',
      badge: (s) => {
        const down = allNodes(s).filter((n) => n.state === 'down').length;
        return down ? { cls: 'bad', text: String(down) } : null;
      },
      render(view, s) {
        const cfg = s.routerConfig;
        append(view, [
          h(
            'div',
            { class: 'grid-3', style: { marginBottom: '16px' } },
            kpi('Strategy', cfg.strategy === 'weighted' ? 'Weighted' : 'Priority', cfg.strategy === 'weighted' ? 'load spread by weight across healthy nodes' : 'first healthy node in order; others are failover'),
            kpi('Per-node timeout', ms(cfg.timeoutMs), 'up to ' + cfg.maxAttempts + ' attempts within ' + ms(cfg.totalBudgetMs)),
            kpi('Dead-node pause', ms(cfg.circuitTtlMs), 'then one probe request checks if it is back')
          ),
          s.pools.map((p) => poolCard(p)),
        ]);
      },
    },

    'free-tiers': {
      title: 'Free tiers',
      sub: 'How much of each free quota is used',
      group: 'Monitor',
      icon: 'gauge',
      badge: (s) => {
        const hot = allNodes(s).filter((n) => n.quota && n.quota.percentUsed >= 80).length;
        return hot ? { cls: 'warn', text: String(hot) } : null;
      },
      render(view, s) {
        const quotaNodes = uniqueByLabel(allNodes(s).filter((n) => n.quota));
        const others = uniqueByLabel(allNodes(s).filter((n) => !n.quota));
        const catalogById = new Map((state.catalog || []).map((p) => [p.id, p]));

        append(view, [
          banners(s),
          h(
            'div',
            { class: 'grid-2', style: { marginTop: alerts(s).length ? '16px' : '0' } },
            card(
              'Router ceiling',
              h(
                'div',
                { class: 'card-body stack' },
                h('div', null, h('div', { class: 'kpi-value', text: '100,000 / day' }), h('div', { class: 'kpi-sub', text: 'Cloudflare Workers Free, shared by all router instances' })),
                h('p', { class: 'muted', style: { margin: 0 }, text: 'Every request runs the router, including cached ones, so this is the real free ceiling of the mesh. After it, Cloudflare answers with error 1027 until midnight UTC. Adding providers adds CPU and RAM, not requests.' }),
                h('div', { class: 'muted small', text: 'This router instance has handled ' + fmt(s.totals.requests) + ' requests since it started ' + duration(s.instance.uptimeSeconds) + ' ago.' })
              )
            ),
            card(
              'How switching works',
              h(
                'div',
                { class: 'card-body' },
                h(
                  'ol',
                  { class: 'steps' },
                  h('li', { text: 'Each provider with a request quota is counted as traffic flows.' }),
                  h('li', { text: 'At 80% you get a warning here and on the overview.' }),
                  h('li', { text: 'At 95% the router stops sending new traffic there and moves to the next free tier, with no errors for users.' }),
                  h('li', { text: 'Providers limited by hours or bandwidth are switched when they answer 429 or fail.' })
                )
              )
            )
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Request quotas' }), h('span', { class: 'count', text: quotaNodes.length + ' providers' })),
          quotaNodes.length
            ? h(
                'div',
                { class: 'card' },
                h(
                  'div',
                  { class: 'table' },
                  quotaNodes.map((n) =>
                    h(
                      'div',
                      { class: 'tr', style: { gridTemplateColumns: 'minmax(160px, 1fr) 120px minmax(220px, 2fr)' } },
                      h('div', { class: 'node-cell' }, tile(n.providerId || n.label, n.label, 30), h('div', null, h('div', { class: 'node-name', text: n.label }), h('div', { class: 'muted small', text: 'pools ' + poolsOf(s, n.label).join(', ') }))),
                      h('div', null, statePill(n)),
                      quotaBar(n.quota)
                    )
                  )
                )
              )
            : h('div', { class: 'card empty' }, h('strong', { text: 'No request quotas configured' }), 'Run omnimesh init, or add requestsPerDay / requestsPerMonth to a node in the config.'),
          others.length
            ? [
                h('div', { class: 'section-title' }, h('h2', { text: 'Other free-tier limits' }), h('span', { class: 'count', text: 'not counted by requests' })),
                h(
                  'div',
                  { class: 'card' },
                  h(
                    'div',
                    { class: 'table' },
                    others.map((n) => {
                      const p = catalogById.get(n.providerId);
                      return h(
                        'div',
                        { class: 'tr', style: { gridTemplateColumns: 'minmax(160px, 1fr) 120px minmax(220px, 2fr)' } },
                        h('div', { class: 'node-cell' }, tile(n.providerId || n.label, n.label, 30), h('div', { class: 'node-name', text: n.label })),
                        h('div', null, statePill(n)),
                        h('div', { class: 'muted', text: p ? limitsSummary(p.limits) || 'See the provider pricing page' : 'Unknown provider (no providerId in config)' })
                      );
                    })
                  )
                ),
              ]
            : null,
        ]);
      },
    },

    health: {
      title: 'Health',
      sub: 'Latency, failures and shared state',
      group: 'Monitor',
      icon: 'health',
      render(view, s) {
        const t = s.totals;
        const cfg = s.routerConfig;
        const kv = (rows) => h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
        append(view, [
          h(
            'div',
            { class: 'kpis' },
            kpi('Uptime', duration(s.instance.uptimeSeconds), 'this router instance'),
            kpi('Version', 'v' + s.version, s.profile + ' profile'),
            kpi('Requests', fmt(t.requests), fmt(t.succeeded) + ' succeeded'),
            kpi('Failed', fmt(t.failed), t.requests ? ((t.failed / t.requests) * 100).toFixed(2) + '% of requests' : 'no requests yet'),
            kpi('Failovers', fmt(t.failovers), 'answered by another node')
          ),
          h(
            'div',
            { class: 'grid-3', style: { marginTop: '16px' } },
            card('Latency', h('div', { class: 'card-body' }, kv([['p50', ms(s.latency.p50)], ['p95', ms(s.latency.p95)], ['p99', ms(s.latency.p99)], ['Samples', fmt(s.latency.samples)]]))),
            card('Protection', h('div', { class: 'card-body' }, kv([['Rate limit', cfg.rateLimit.enabled ? cfg.rateLimit.requestsPerMinute + ' / min per IP and caller' : 'off'], ['Rate-limited', fmt(t.rateLimited)], ['Max body', bytes(cfg.maxBodyBytes)], ['Rejected bodies', fmt(t.rejected)]]))),
            card('Failover settings', h('div', { class: 'card-body' }, kv([['Timeout per node', ms(cfg.timeoutMs)], ['Max attempts', String(cfg.maxAttempts)], ['Total budget', ms(cfg.totalBudgetMs)], ['Dead-node pause', ms(cfg.circuitTtlMs)]])))
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Shared state' }), h('span', { class: 'count', text: 'what every router instance agrees on' })),
          h('div', { class: 'card' }, h('div', { class: 'checklist' }, sharedChecks(s).map(checkRow))),
          h('div', { class: 'section-title' }, h('h2', { text: 'Node error rates' })),
          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'table' },
              h('div', { class: 'tr th', style: { gridTemplateColumns: 'minmax(160px,1.4fr) 120px 1fr 1fr 1fr' } }, ['Node', 'Status', 'Requests', 'Errors', 'Last latency'].map((x) => h('div', { text: x }))),
              uniqueByLabel(allNodes(s)).map((n) =>
                h(
                  'div',
                  { class: 'tr', style: { gridTemplateColumns: 'minmax(160px,1.4fr) 120px 1fr 1fr 1fr' } },
                  h('div', { class: 'node-cell' }, stateDot(n), h('span', { class: 'node-name', text: n.label })),
                  h('div', null, statePill(n)),
                  h('div', { class: 'num', text: fmt(n.requests) }),
                  h('div', { class: 'num', text: fmt(n.errors) + (n.requests ? ' (' + Math.round((n.errors / n.requests) * 100) + '%)' : '') }),
                  h('div', { class: 'num', text: ms(n.latencyMs) })
                )
              )
            )
          ),
        ]);
      },
    },

    activity: {
      title: 'Activity',
      sub: 'Failures, recoveries, failovers and quota switches',
      group: 'Monitor',
      icon: 'activity',
      render(view, s) {
        const counts = {};
        for (const e of s.events) counts[e.kind] = (counts[e.kind] || 0) + 1;
        const filtered = state.eventFilter === 'all' ? s.events : s.events.filter((e) => e.kind === state.eventFilter);
        append(view, [
          h(
            'div',
            { class: 'toolbar' },
            h(
              'div',
              { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter events' } },
              EVENT_FILTERS.map(([key, label]) =>
                h(
                  'button',
                  {
                    class: 'fchip',
                    type: 'button',
                    attrs: { 'aria-pressed': state.eventFilter === key },
                    onclick: () => {
                      state.eventFilter = key;
                      renderPage();
                    },
                  },
                  label,
                  h('span', { class: 'n', text: key === 'all' ? s.events.length : counts[key] || 0 })
                )
              )
            )
          ),
          h('div', { class: 'card' }, eventList(filtered, state.eventFilter === 'all' ? undefined : 'No events of this kind on this router instance.')),
          h('p', { class: 'muted small', text: 'Repeats within 5 seconds are grouped (×N). The last 50 events of this router instance are kept.' }),
        ]);
      },
    },

    providers: {
      title: 'Providers',
      sub: 'Free tiers you can add to the mesh',
      group: 'Build',
      icon: 'providers',
      keepsInput: true,
      render(view, s) {
        if (!state.catalog) {
          view.appendChild(h('div', { class: 'card empty', text: 'Loading the provider catalog…' }));
          return;
        }
        const usage = meshUsage(s);
        const filters = [
          ['all', 'All', () => true],
          ['no-card', 'No card needed', (p) => !p.requiresCard && p.tier === 'free'],
          ['card', 'Needs a card', (p) => p.requiresCard && p.tier === 'free'],
          ['in-mesh', 'In your mesh', (p) => usage.has(p.id)],
        ];
        const search = h('input', {
          type: 'search',
          placeholder: 'Search providers or roles',
          value: state.providerSearch,
          attrs: { 'aria-label': 'Search providers' },
          oninput: (e) => {
            state.providerSearch = e.target.value;
            drawGrid();
          },
        });
        const chipBox = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter providers' } });
        const gridBox = h('div');

        function drawChips() {
          clear(chipBox);
          for (const [key, label, test] of filters) {
            chipBox.appendChild(
              h(
                'button',
                {
                  class: 'fchip',
                  type: 'button',
                  attrs: { 'aria-pressed': state.providerFilter === key },
                  onclick: () => {
                    state.providerFilter = key;
                    drawChips();
                    drawGrid();
                  },
                },
                label,
                h('span', { class: 'n', text: state.catalog.filter(test).length })
              )
            );
          }
        }
        function drawGrid() {
          clear(gridBox);
          const test = filters.find((f) => f[0] === state.providerFilter)[2];
          const q = state.providerSearch.trim().toLowerCase();
          const shown = state.catalog.filter((p) => test(p) && (!q || (p.displayName + ' ' + p.id + ' ' + p.roles.join(' ')).toLowerCase().includes(q)));
          const groups = [
            ['No card needed', (p) => !p.requiresCard && p.tier === 'free'],
            ['Needs a card', (p) => p.requiresCard && p.tier === 'free'],
            ['Paid only', (p) => p.tier !== 'free'],
          ];
          let any = false;
          for (const [title, test2] of groups) {
            const items = shown.filter(test2);
            if (!items.length) continue;
            any = true;
            gridBox.appendChild(h('div', { class: 'section-title' }, h('h2', { text: title }), h('span', { class: 'count', text: items.length + ' providers' })));
            gridBox.appendChild(h('div', { class: 'provider-grid' }, items.map((p) => providerCard(p, usage.get(p.id)))));
          }
          if (!any) gridBox.appendChild(h('div', { class: 'card empty' }, h('strong', { text: 'No providers match' }), 'Try another search or filter.'));
        }

        drawChips();
        drawGrid();
        append(view, [h('div', { class: 'toolbar', style: { marginBottom: '4px' } }, h('div', { class: 'search' }, icon('search', 15), search), chipBox), gridBox]);
        if (state.providerSearch) search.focus();
      },
    },

    setup: {
      title: 'Setup',
      sub: "What's done, what's missing, and your config file",
      group: 'Build',
      icon: 'setup',
      badge: (s) => {
        const open = setupChecks(s).filter((c) => c.state === 'bad').length;
        return open ? { cls: 'bad', text: String(open) } : null;
      },
      keepsInput: true,
      render(view, s) {
        if (!state.builder) state.builder = builderFromStatus(s);
        if (state.pendingBuilderAdd) {
          addBuilderNode(state.pendingBuilderAdd);
          state.pendingBuilderAdd = null;
        }
        const checks = setupChecks(s);
        const done = checks.filter((c) => c.state === 'ok').length;
        append(view, [
          card('Getting started', h('div', { class: 'checklist' }, checks.map(checkRow)), h('span', { class: 'pill ' + (done === checks.length ? 'ok' : 'accent'), text: done + ' of ' + checks.length + ' done' })),
          h('div', { class: 'section-title' }, h('h2', { text: 'Config builder' }), h('span', { class: 'count', text: 'creates omnimesh.config.yaml; nothing is saved on the router' })),
          builderView(),
        ]);
      },
    },

    settings: {
      title: 'Settings',
      sub: 'Router configuration, appearance and session',
      group: 'System',
      icon: 'settings',
      render(view, s) {
        const cfg = s.routerConfig;
        const kv = (rows) => h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
        const theme = getItem('local', THEME_KEY) || 'system';
        append(view, [
          h(
            'div',
            { class: 'grid-2' },
            card(
              'Router',
              h(
                'div',
                { class: 'card-body stack' },
                kv([
                  ['Domain', s.domain],
                  ['Profile', s.profile],
                  ['Strategy', cfg.strategy],
                  ['Default pool', cfg.defaultPool || 'none (unmatched paths get 404)'],
                  ['Timeout per node', ms(cfg.timeoutMs)],
                  ['Total budget', ms(cfg.totalBudgetMs)],
                  ['Max body', bytes(cfg.maxBodyBytes)],
                  ['Keep-alive pings', s.keepAlive.enabled ? 'on' : 'off'],
                ]),
                h('p', { class: 'muted small', style: { margin: 0 }, text: 'These come from the router config (OMNIMESH_CONFIG_YAML). Change them with the Setup page builder or in omnimesh.config.yaml, then redeploy the router.' })
              )
            ),
            h(
              'div',
              { class: 'stack' },
              card(
                'Appearance',
                h(
                  'div',
                  { class: 'card-body' },
                  h(
                    'div',
                    { class: 'seg', attrs: { role: 'group', 'aria-label': 'Theme' } },
                    [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([key, label]) =>
                      h('button', { type: 'button', text: label, attrs: { 'aria-pressed': theme === key }, onclick: () => setTheme(key) })
                    )
                  )
                )
              ),
              card(
                'Session',
                h(
                  'div',
                  { class: 'card-body stack' },
                  h('p', { class: 'muted', style: { margin: 0 }, text: 'Your status token is kept in this browser tab only and is cleared when you sign out or close the tab.' }),
                  h('div', null, h('button', { class: 'btn', type: 'button', onclick: signOut }, icon('logout', 15), 'Sign out'))
                )
              ),
              card('About', h('div', { class: 'card-body' }, kv([['OmniMesh', 'v' + s.version], ['Instance started', new Date(s.instance.startedAt).toLocaleString()]])))
            )
          ),
        ]);
      },
    },
  };

  const ROUTE_ORDER = ['overview', 'routing', 'free-tiers', 'health', 'activity', 'providers', 'setup', 'settings'];

  // ---------------------------------------------------------------- page parts

  function meshMap(s) {
    return h(
      'div',
      { class: 'card card-body mesh' },
      h('div', { class: 'mesh-entry' }, 'Clients', icon('arrow', 14), h('span', { class: 'mesh-node-router' }, icon('globe', 14), s.domain), icon('arrow', 14), 'pools'),
      s.pools.map((p) =>
        h(
          'div',
          { class: 'mesh-row' },
          h('div', null, h('div', { class: 'mesh-prefix', text: p.prefix }), p.isDefault ? h('div', { class: 'muted small', text: 'default' }) : null),
          h('span', { class: 'mesh-arrow' }, icon('arrow', 16)),
          h(
            'div',
            { class: 'mesh-chips' },
            p.nodes.map((n) => h('span', { class: 'chip', title: n.url }, stateDot(n), n.label, h('span', { class: 'chip-sub', text: STATE_VIEW[nodeState(n)].label.toLowerCase() + (n.isBackup ? ' · backup' : '') })))
          )
        )
      )
    );
  }

  function freeTierSummary(s) {
    const list = uniqueByLabel(allNodes(s).filter((n) => n.quota)).sort((a, b) => b.quota.percentUsed - a.quota.percentUsed).slice(0, 4);
    if (!list.length) return h('div', { class: 'empty' }, h('strong', { text: 'No request quotas tracked' }), 'Nodes created by omnimesh init carry their provider’s free quota.');
    return h('div', { class: 'card-body stack' }, list.map((n) => h('div', null, h('div', { class: 'node-name', style: { marginBottom: '4px' }, text: n.label }), quotaBar(n.quota))));
  }

  function poolCard(p) {
    const up = p.nodes.filter((n) => n.state !== 'down').length;
    return h(
      'section',
      { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('h2', { class: 'mono', text: p.prefix }), p.isDefault ? h('span', { class: 'pill idle', text: 'default pool' }) : null, h('span', { class: 'spacer' }), h('span', { class: 'muted small', text: up + ' of ' + p.nodes.length + ' nodes up' })),
      h(
        'div',
        { class: 'table nodes' },
        h('div', { class: 'tr th' }, ['Node', 'Status', 'Role', 'Latency', 'Errors', 'Free-tier quota'].map((x) => h('div', { text: x }))),
        p.nodes.map((n) =>
          h(
            'div',
            { class: 'tr' },
            h('div', { class: 'node-cell' }, stateDot(n), h('div', { class: 'ellipsis' }, h('div', { class: 'node-name', text: n.label }), h('div', { class: 'node-url', text: n.url, title: n.url }), n.failureReason && n.state === 'down' ? h('div', { class: 'reason', text: n.failureReason }) : null)),
            h('div', null, statePill(n)),
            h('div', { class: 'muted' }, h('span', { class: 'cell-label', text: 'Role' }), n.isBackup ? 'Backup' : 'Primary' + (n.weight > 1 ? ' ×' + n.weight : '')),
            h('div', { class: 'num' }, h('span', { class: 'cell-label', text: 'Latency' }), ms(n.latencyMs)),
            h('div', { class: 'num' }, h('span', { class: 'cell-label', text: 'Errors' }), fmt(n.errors) + (n.requests ? ' (' + Math.round((n.errors / n.requests) * 100) + '%)' : '')),
            n.quota ? quotaBar(n.quota) : h('div', { class: 'muted small', text: 'Limited by hours or bandwidth, not requests' })
          )
        )
      )
    );
  }

  function uniqueByLabel(nodes) {
    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.label)) seen.set(n.label, n);
    return [...seen.values()];
  }
  function poolsOf(s, label) {
    return s.pools.filter((p) => p.nodes.some((n) => n.label === label)).map((p) => p.prefix);
  }

  function meshUsage(s) {
    const map = new Map();
    for (const n of allNodes(s)) {
      if (!n.providerId) continue;
      const u = map.get(n.providerId) || { nodes: 0, down: 0, pools: new Set() };
      u.nodes += 1;
      if (n.state === 'down') u.down += 1;
      u.pools.add(n.pool);
      map.set(n.providerId, u);
    }
    return map;
  }

  function providerCard(p, use) {
    const status = use
      ? h('span', { class: 'pill ' + (use.down ? 'bad' : 'ok') }, use.down ? use.down + ' of ' + use.nodes + ' down' : 'In mesh · ' + use.nodes + (use.nodes === 1 ? ' node' : ' nodes'))
      : h('span', { class: 'pill idle', text: 'Not added' });
    return h(
      'button',
      { class: 'provider', type: 'button', onclick: () => openProvider(p, use), attrs: { 'aria-label': p.displayName + ' details' } },
      h('div', { class: 'provider-top' }, tile(p.id, p.displayName), h('div', { class: 'ellipsis' }, h('div', { class: 'provider-name', text: p.displayName }), h('div', { class: 'muted small', text: p.requiresCard ? 'Card needed for sign-up' : p.tier === 'free' ? 'No card needed' : 'Paid plan' }))),
      h('div', { class: 'provider-limits', text: limitsSummary(p.limits) }),
      h('div', { class: 'provider-foot' }, status, p.roles.slice(0, 3).map((r) => h('span', { class: 'role', text: r })))
    );
  }

  const HOST_HINTS = {
    koyeb: 'https://your-app.koyeb.app',
    render: 'https://your-app.onrender.com',
    vercel: 'https://your-app.vercel.app',
    netlify: 'https://your-site.netlify.app',
    'deno-deploy': 'https://your-app.deno.dev',
    oracle: 'https://oracle.your-domain.com',
    railway: 'https://your-app.up.railway.app',
    flyio: 'https://your-app.fly.dev',
  };
  const isCompute = (p) => p.roles.includes('compute');

  function connectSteps(p) {
    const card = p.requiresCard ? ' (a card is needed to verify your identity; the free tier is not charged)' : ' (no card needed)';
    if (p.id === 'cloudflare') {
      return ['Add your domain to Cloudflare (free plan).', 'In packages/router, copy wrangler.toml.example to wrangler.toml and fill in your KV id.', 'Set secrets: npx wrangler secret put GATEWAY_SECRET, OMNIMESH_STATUS_TOKEN and OMNIMESH_CONFIG_YAML.', 'Deploy the router: npx wrangler deploy.'];
    }
    if (p.id === 'oracle') {
      return ['Create an Oracle Cloud account' + card + ' and an Always Free ARM VM with Docker.', 'In Cloudflare, create a Tunnel and copy its token. The VM needs no open ports.', 'On the VM, set GATEWAY_SECRET, JWT_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD and CF_TUNNEL_TOKEN, then run docker compose up -d with packages/providers/src/oracle/docker-compose.yml.', 'Add the tunnel address to a pool (Setup → Config builder) and run omnimesh doctor.'];
    }
    if (isCompute(p)) {
      return [
        'Create a ' + p.displayName + ' account' + card + '.',
        'Deploy your app from GitHub in the ' + p.displayName + ' dashboard. Use @omnimesh/node so it checks GATEWAY_SECRET and serves /health.',
        'Set GATEWAY_SECRET (and JWT_SECRET, UPSTASH_REDIS_REST_URL / _TOKEN if you use them) in the service environment.',
        'Add the app URL to a pool with the Config builder, then run omnimesh doctor.',
      ].concat(p.tier !== 'free' ? ['This provider has no permanent free tier; it is supported as a paid node.'] : []);
    }
    const env = p.roles.includes('cache') ? 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN' : p.roles.includes('database') ? 'DATABASE_URL (use the pooled connection string)' : 'its URL and keys';
    return ['Create a ' + p.displayName + ' account' + card + '.', 'Create the ' + p.roles.join(' / ') + ' in its dashboard. There is nothing to deploy.', 'Put ' + env + ' in every compute node’s environment.'];
  }

  function nodeSnippet(p) {
    const lines = ['  - url: ' + (HOST_HINTS[p.id] || 'https://your-app.example.com'), '    providerId: ' + p.id];
    if (p.limits.requestsPerDay) lines.push('    requestsPerDay: ' + p.limits.requestsPerDay);
    if (p.limits.requestsPerMonth) lines.push('    requestsPerMonth: ' + p.limits.requestsPerMonth);
    return 'pools:\n  /api:\n' + lines.join('\n');
  }

  function openProvider(p, use) {
    const root = $('drawer-root');
    const previouslyFocused = document.activeElement;
    const close = () => {
      clear(root);
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);

    const l = p.limits;
    const rows = [
      ['Requests per day', l.requestsPerDay && fmt(l.requestsPerDay)],
      ['Requests per month', l.requestsPerMonth && fmt(l.requestsPerMonth)],
      ['Bandwidth per month', l.bandwidthGbPerMonth && gb(l.bandwidthGbPerMonth)],
      ['RAM', l.ramMb && (l.ramMb >= 1024 ? l.ramMb / 1024 + ' GB' : l.ramMb + ' MB')],
      ['vCPU', l.vCpu],
      ['Storage', l.storageMb && (l.storageMb >= 1024 ? l.storageMb / 1024 + ' GB' : l.storageMb + ' MB')],
      ['CPU time per request', l.maxCpuExecutionMs && l.maxCpuExecutionMs + ' ms'],
      ['Sleeps when idle', l.sleepsIfIdle ? (l.idleSleepMinutes ? 'after ' + minutes(l.idleSleepMinutes) : 'yes') : null],
    ].filter((r) => r[1]);
    const safeSource = typeof l.sourceUrl === 'string' && /^https:\/\//.test(l.sourceUrl) ? l.sourceUrl : null;
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', onclick: close, attrs: { 'aria-label': 'Close' } }, icon('x', 18));

    append(root, [
      h('div', { class: 'drawer-scrim', onclick: close }),
      h(
        'aside',
        { class: 'drawer', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': p.displayName } },
        h('div', { class: 'drawer-head' }, tile(p.id, p.displayName), h('h2', { text: p.displayName }), closeBtn),
        h(
          'div',
          { class: 'drawer-body' },
          h(
            'div',
            { class: 'provider-foot' },
            h('span', { class: 'pill ' + (p.requiresCard ? 'warn' : 'ok'), text: p.requiresCard ? 'Card needed' : 'No card needed' }),
            h('span', { class: 'pill idle', text: p.tier === 'free' ? 'Free tier' : p.tier === 'paid' ? 'Paid only' : 'Trial credit' }),
            use ? h('span', { class: 'pill ' + (use.down ? 'bad' : 'accent'), text: 'In ' + [...use.pools].join(', ') }) : null,
            p.roles.map((r) => h('span', { class: 'role', text: r }))
          ),
          rows.length ? h('div', null, h('h3', { text: 'Free-tier limits' }), h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))) : null,
          h(
            'div',
            { class: 'muted small' },
            'Last verified ' + (l.lastVerified || 'unknown') + '. ',
            safeSource ? h('a', { href: safeSource, target: '_blank', rel: 'noopener noreferrer' }, 'Official pricing ', icon('external', 12)) : null
          ),
          h('div', null, h('h3', { text: 'How to connect' }), h('ol', { class: 'steps' }, connectSteps(p).map((t) => h('li', { text: t })))),
          isCompute(p)
            ? h(
                'div',
                null,
                h('h3', { text: 'Config snippet' }),
                codeBlock(nodeSnippet(p)),
                h(
                  'div',
                  { style: { marginTop: '12px' } },
                  h(
                    'button',
                    {
                      class: 'btn btn-primary',
                      type: 'button',
                      onclick: () => {
                        state.pendingBuilderAdd = p.id;
                        close();
                        location.hash = '#/setup';
                      },
                    },
                    icon('plus', 15),
                    'Add to config builder'
                  )
                )
              )
            : null
        )
      ),
    ]);
    closeBtn.focus();
  }

  function codeBlock(text) {
    return h('div', { class: 'code-block' }, h('pre', { text }), h('button', { class: 'btn btn-sm copy', type: 'button', onclick: () => copyText(text) }, icon('copy', 13), 'Copy'));
  }

  // ---------------------------------------------------------------- setup checks

  function setupChecks(s) {
    const nodes = allNodes(s);
    const down = nodes.filter((n) => n.state === 'down');
    const untested = nodes.filter((n) => n.state === 'unknown');
    return [
      { state: 'ok', title: 'Router is online', detail: 'Serving ' + s.domain + ', instance up ' + duration(s.instance.uptimeSeconds) + '.' },
      { state: 'ok', title: 'Dashboard token works', detail: 'OMNIMESH_STATUS_TOKEN is set on the router.' },
      {
        state: s.pools.every((p) => p.nodes.length > 0) ? 'ok' : 'bad',
        title: 'Every pool has nodes',
        detail: plural(s.pools.length, 'pool') + ', ' + plural(uniqueByLabel(nodes).length, 'distinct node') + '. Placeholder URLs are refused at startup, so these are real.',
      },
      down.length
        ? { state: 'bad', title: 'All nodes answer', detail: down.map((n) => n.label + ' (' + (n.failureReason || 'down') + ')').join(', ') + ' failing. Check the service, its GATEWAY_SECRET, and its /health route.' }
        : untested.length
          ? { state: 'idle', title: 'All nodes answer', detail: plural(untested.length, 'node') + ' had no traffic yet: ' + uniqueByLabel(untested).map((n) => n.label).join(', ') + '. They are tried when earlier nodes fail.' }
          : { state: 'ok', title: 'All nodes answer', detail: 'Every node has served traffic successfully.' },
    ].concat(sharedChecks(s));
  }

  function sharedChecks(s) {
    return [
      s.sharing.health === 'shared'
        ? { state: 'ok', title: 'Shared node health (Cloudflare KV)', detail: 'Every router instance skips a dead node as soon as one of them sees it fail.' }
        : { state: 'warn', title: 'Shared node health (Cloudflare KV)', detail: 'Not connected: each router instance learns about dead nodes on its own. Bind OMNIMESH_KV in wrangler.toml.' },
      s.sharing.rateLimit === 'shared'
        ? { state: 'ok', title: 'Shared rate limiter', detail: 'Per-IP and per-caller limits are counted across router instances.' }
        : { state: s.routerConfig.rateLimit.enabled ? 'warn' : 'idle', title: 'Shared rate limiter', detail: s.routerConfig.rateLimit.enabled ? 'Counting per instance only, so a distributed bot gets more. Add the RATE_LIMITER binding from wrangler.toml.example.' : 'Rate limiting is off in the config.' },
    ];
  }

  function checkRow(c) {
    const ic = { ok: 'check', bad: 'x', warn: 'alert', idle: 'minus' }[c.state];
    return h('div', { class: 'check' }, h('span', { class: 'check-icon ' + c.state }, icon(ic, 13)), h('div', null, h('div', { class: 'check-title', text: c.title }), h('div', { class: 'check-detail', text: c.detail })), h('span'));
  }

  // ---------------------------------------------------------------- config builder

  const PROFILE_DEFAULTS = {
    'no-card': { '/api': ['koyeb', 'render', 'vercel'], '/auth': ['deno-deploy', 'vercel', 'netlify'], '/webhooks': ['netlify', 'vercel'] },
    'with-card': { '/api': ['oracle', 'koyeb', 'render', 'vercel'], '/auth': ['deno-deploy', 'vercel', 'oracle'], '/webhooks': ['netlify', 'oracle'] },
  };

  function builderFromStatus(s) {
    const pools = {};
    for (const p of s.pools) {
      pools[p.prefix] = p.nodes.map((n) => ({ provider: n.providerId || '', url: n.url, backup: n.isBackup, weight: n.weight }));
    }
    return { profile: s.profile === 'with-card' ? 'with-card' : 'no-card', domain: s.domain, strategy: s.routerConfig.strategy, pools };
  }
  function builderDefaults(profile, domain, strategy) {
    const pools = {};
    for (const [prefix, list] of Object.entries(PROFILE_DEFAULTS[profile])) pools[prefix] = list.map((provider) => ({ provider, url: '', backup: false, weight: 1 }));
    return { profile, domain: domain || '', strategy: strategy || 'priority', pools };
  }
  function addBuilderNode(providerId) {
    const b = state.builder;
    if (!b.pools['/api']) b.pools['/api'] = [];
    b.pools['/api'].push({ provider: providerId, url: '', backup: false, weight: 1 });
    const p = (state.catalog || []).find((x) => x.id === providerId);
    if (p && p.requiresCard) b.profile = 'with-card';
    toast('Added ' + (p ? p.displayName : providerId) + ' to /api');
  }

  function computeProviders(profile) {
    return (state.catalog || []).filter((p) => isCompute(p) && (profile === 'with-card' || !p.requiresCard));
  }

  function validateBuilder(b) {
    const issues = [];
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(b.domain || '')) issues.push('Set your public domain, e.g. api.yourapp.com.');
    const prefixes = Object.keys(b.pools);
    if (!prefixes.length) issues.push('Add at least one pool.');
    for (const prefix of prefixes) {
      const nodes = b.pools[prefix];
      if (!/^\/[a-z0-9/_-]*$/i.test(prefix)) issues.push(prefix + ': a pool path must start with / (e.g. /api).');
      if (!nodes.length) issues.push(prefix + ': add at least one node.');
      const urls = new Set();
      nodes.forEach((n, i) => {
        const where = prefix + ' node ' + (i + 1) + (n.provider ? ' (' + n.provider + ')' : '');
        let u = null;
        try {
          u = new URL(n.url);
        } catch (e) {
          /* reported below */
        }
        if (!n.url) issues.push(where + ': paste the deployed app URL.');
        else if (!u || u.protocol !== 'https:') issues.push(where + ': the URL must start with https://.');
        else if (u.hostname.endsWith('.invalid') || /your-(app|site|domain)/.test(u.hostname)) issues.push(where + ': replace the example address with your real app URL.');
        const key = (n.url || '').replace(/\/+$/, '');
        if (key && urls.has(key)) issues.push(where + ': this URL is already in the pool.');
        urls.add(key);
        const p = (state.catalog || []).find((x) => x.id === n.provider);
        if (b.profile === 'no-card' && p && p.requiresCard) issues.push(where + ': ' + p.displayName + ' needs a card. Switch the profile to "With card" or remove it.');
      });
      if (nodes.length && nodes.every((n) => n.backup)) issues.push(prefix + ': at least one node should not be a backup.');
    }
    return issues;
  }

  function builderYaml(b) {
    const q = (v) => JSON.stringify(String(v)); // JSON strings are valid YAML, so user input can't break the file
    const lines = ['# Generated by the OmniMesh dashboard. Save as omnimesh.config.yaml, then run: omnimesh doctor', 'profile: ' + b.profile, 'domain: ' + q(b.domain || 'api.yourapp.com'), 'router:', '  strategy: ' + b.strategy, 'pools:'];
    for (const [prefix, nodes] of Object.entries(b.pools)) {
      lines.push('  ' + q(prefix) + ':');
      for (const n of nodes) {
        const p = (state.catalog || []).find((x) => x.id === n.provider);
        lines.push('    - url: ' + q(n.url || (HOST_HINTS[n.provider] || 'https://your-app.example.com')));
        if (n.provider) lines.push('      providerId: ' + q(n.provider));
        if (n.backup) lines.push('      isBackup: true');
        if (b.strategy === 'weighted' && n.weight > 1) lines.push('      weight: ' + n.weight);
        if (p && p.limits.requestsPerDay) lines.push('      requestsPerDay: ' + p.limits.requestsPerDay);
        if (p && p.limits.requestsPerMonth) lines.push('      requestsPerMonth: ' + p.limits.requestsPerMonth);
      }
    }
    lines.push('database:', '  mode: ' + (b.profile === 'with-card' ? 'managed  # Mode B (self-hosted on Oracle) needs a replication decision first' : 'managed'), '  primary: neon');
    lines.push('cache:', '  provider: upstash', 'storage:', '  provider: ' + (b.profile === 'with-card' ? 'r2' : 'supabase'));
    return lines.join('\n') + '\n';
  }

  function builderView() {
    const b = state.builder;
    const out = h('div', { class: 'builder-layout' });
    const form = h('div', { class: 'card card-body stack' });
    const preview = h('div', { class: 'stack' });

    function refreshPreview() {
      clear(preview);
      const issues = validateBuilder(b);
      const yaml = builderYaml(b);
      append(preview, [
        issues.length
          ? h('div', { class: 'banner warn' }, h('span', { class: 'dot warn' }), h('div', null, h('div', { text: issues.length + ' thing' + (issues.length === 1 ? '' : 's') + ' to fix before using this file' }), h('ul', { class: 'issues' }, issues.slice(0, 8).map((i) => h('li', { text: i })))))
          : h('div', { class: 'banner ok' }, h('span', { class: 'dot ok' }), h('span', { text: 'Ready. Save it as omnimesh.config.yaml in your app repo, run omnimesh doctor, then redeploy the router.' })),
        codeBlock(yaml),
      ]);
    }

    function drawForm() {
      clear(form);
      const options = computeProviders(b.profile);
      append(form, [
        h(
          'div',
          { class: 'field' },
          h('label', { text: 'Profile' }),
          h(
            'div',
            { class: 'seg', attrs: { role: 'group', 'aria-label': 'Profile' } },
            [['no-card', 'No card'], ['with-card', 'With card (adds Oracle)']].map(([key, label]) =>
              h('button', {
                type: 'button',
                text: label,
                attrs: { 'aria-pressed': b.profile === key },
                onclick: () => {
                  b.profile = key;
                  drawForm();
                  refreshPreview();
                },
              })
            )
          )
        ),
        h(
          'div',
          { class: 'grid-2', style: { gap: '12px' } },
          h('div', { class: 'field' }, h('label', { text: 'Public domain', attrs: { for: 'b-domain' } }), h('input', { id: 'b-domain', value: b.domain, placeholder: 'api.yourapp.com', oninput: (e) => { b.domain = e.target.value.trim(); refreshPreview(); } })),
          h(
            'div',
            { class: 'field' },
            h('label', { text: 'Routing strategy', attrs: { for: 'b-strategy' } }),
            h(
              'select',
              { id: 'b-strategy', onchange: (e) => { b.strategy = e.target.value; drawForm(); refreshPreview(); } },
              h('option', { value: 'priority', text: 'Priority (failover only)', selected: b.strategy === 'priority' }),
              h('option', { value: 'weighted', text: 'Weighted (spread load)', selected: b.strategy === 'weighted' })
            )
          )
        ),
        Object.entries(b.pools).map(([prefix, nodes]) =>
          h(
            'div',
            { class: 'builder-pool' },
            h(
              'div',
              { class: 'builder-pool-head' },
              h('span', { class: 'mono', style: { fontWeight: 650 }, text: prefix }),
              h('span', { class: 'muted small', text: nodes.length + ' node' + (nodes.length === 1 ? '' : 's') }),
              h('span', { style: { flex: 1 } }),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { delete b.pools[prefix]; drawForm(); refreshPreview(); } }, 'Remove pool')
            ),
            nodes.map((n, i) =>
              h(
                'div',
                { class: 'builder-row' },
                h(
                  'select',
                  { attrs: { 'aria-label': prefix + ' node ' + (i + 1) + ' provider' }, onchange: (e) => { n.provider = e.target.value; refreshPreview(); } },
                  h('option', { value: '', text: 'Other / custom', selected: !n.provider }),
                  options.map((p) => h('option', { value: p.id, text: p.displayName + (p.requiresCard ? ' (card)' : ''), selected: n.provider === p.id }))
                ),
                h('input', { value: n.url, placeholder: HOST_HINTS[n.provider] || 'https://your-app.example.com', spellcheck: false, attrs: { 'aria-label': prefix + ' node ' + (i + 1) + ' URL', inputmode: 'url' }, oninput: (e) => { n.url = e.target.value.trim(); refreshPreview(); } }),
                h('label', { class: 'check-inline' }, h('input', { type: 'checkbox', checked: n.backup, onchange: (e) => { n.backup = e.target.checked; refreshPreview(); } }), 'Backup'),
                h('button', { class: 'icon-btn', type: 'button', attrs: { 'aria-label': 'Remove node' }, onclick: () => { nodes.splice(i, 1); drawForm(); refreshPreview(); } }, icon('x', 15))
              )
            ),
            h('div', null, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { nodes.push({ provider: '', url: '', backup: false, weight: 1 }); drawForm(); refreshPreview(); } }, icon('plus', 13), 'Add node'))
          )
        ),
        h(
          'div',
          { class: 'toolbar', style: { margin: 0 } },
          h('input', { id: 'b-new-pool', placeholder: '/new-pool', style: { maxWidth: '180px' }, attrs: { 'aria-label': 'New pool path' } }),
          h('button', {
            class: 'btn btn-sm',
            type: 'button',
            onclick: () => {
              const input = $('b-new-pool');
              const prefix = (input.value || '').trim();
              if (!prefix) return;
              if (!b.pools[prefix]) b.pools[prefix] = [{ provider: '', url: '', backup: false, weight: 1 }];
              drawForm();
              refreshPreview();
            },
          }, icon('plus', 13), 'Add pool'),
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.builder = builderDefaults(b.profile, b.domain, b.strategy); renderPage(); } }, 'Reset to ' + (b.profile === 'with-card' ? 'with-card' : 'no-card') + ' defaults'),
          state.status ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.builder = builderFromStatus(state.status); renderPage(); } }, 'Load live config') : null
        ),
      ]);
    }

    drawForm();
    refreshPreview();
    return append(out, [form, preview]);
  }

  // ---------------------------------------------------------------- shell, routing, polling

  function buildNav() {
    const nav = clear($('nav'));
    let group = null;
    for (const key of ROUTE_ORDER) {
      const page = PAGES[key];
      if (page.group !== group) {
        group = page.group;
        nav.appendChild(h('div', { class: 'nav-group', text: group }));
      }
      nav.appendChild(h('a', { class: 'nav-link', href: '#/' + key, id: 'nav-' + key }, icon(page.icon, 17), page.title, h('span', { id: 'badge-' + key })));
    }
  }

  function updateChrome() {
    const s = state.status;
    for (const key of ROUTE_ORDER) {
      const link = $('nav-' + key);
      if (link) {
        if (key === state.route) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      const slot = $('badge-' + key);
      if (slot) {
        const badge = s && PAGES[key].badge ? PAGES[key].badge(s) : null;
        slot.className = badge ? 'nav-badge ' + badge.cls : '';
        slot.textContent = badge ? badge.text : '';
      }
    }
    if (!s) return;
    $('brand-version').textContent = 'v' + s.version;
    $('foot-domain').textContent = s.domain;
    $('foot-domain').title = s.domain;
    $('foot-uptime').textContent = 'Instance up ' + duration(s.instance.uptimeSeconds);
    const list = alerts(s);
    const alertBtn = $('alerts');
    alertBtn.hidden = !list.length;
    if (list.length) {
      clear(alertBtn);
      append(alertBtn, [icon('alert', 14), list.length + (list.length === 1 ? ' alert' : ' alerts')]);
    }
  }

  function renderPage() {
    const page = PAGES[state.route];
    $('page-title').textContent = page.title;
    $('page-sub').textContent = page.sub;
    document.title = page.title + ' · OmniMesh';
    updateChrome();
    const view = clear($('view'));
    if (!state.status) {
      view.appendChild(h('div', { class: 'card empty', text: 'Loading live data…' }));
      return;
    }
    page.render(view, state.status);
  }

  function onRoute() {
    const key = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    state.route = PAGES[key] ? key : 'overview';
    closeSidebar();
    renderPage();
    $('view').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function setLive(kind, text) {
    const chip = $('live');
    chip.querySelector('.dot').className = 'dot ' + kind + (kind === 'ok' ? ' live' : '');
    chip.querySelector('.live-text').textContent = text;
    chip.title = text;
  }

  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(poll, delay);
  }

  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store' }).then((res) => {
      if (res.status === 404 || res.status === 401) {
        const err = new Error('unauthorized');
        err.unauthorized = true;
        throw err;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function poll() {
    api('/_omnimesh/status')
      .then((data) => {
        const first = !state.status;
        state.status = data;
        state.failures = 0;
        state.lastOk = Date.now();
        setLive('ok', 'Live');
        showShell();
        if (!state.catalog) {
          api('/_omnimesh/catalog').then(
            (c) => {
              state.catalog = c.providers;
              if (['providers', 'setup', 'free-tiers'].includes(state.route)) renderPage();
            },
            () => {}
          );
        }
        // Pages with inputs are only redrawn when first shown, so typing is never interrupted
        if (first || !PAGES[state.route].keepsInput) renderPage();
        else updateChrome();
        schedule(document.hidden ? POLL_MS * 5 : POLL_MS);
      })
      .catch((err) => {
        if (err.unauthorized) {
          signOut('That token was not accepted. Check OMNIMESH_STATUS_TOKEN on the router.');
          return;
        }
        state.failures += 1;
        const wait = Math.min(30000, POLL_MS * Math.pow(2, state.failures));
        setLive('bad', 'Reconnecting in ' + Math.round(wait / 1000) + 's' + (state.lastOk ? ' · last data ' + ago(state.lastOk) : ''));
        schedule(wait);
      });
  }

  function showShell() {
    $('login').hidden = true;
    $('shell').hidden = false;
  }

  function showLogin(message) {
    clearTimeout(state.timer);
    $('shell').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message || '';
    $('token').value = '';
    $('token').focus();
  }

  function signOut(message) {
    setItem('session', TOKEN_KEY, null);
    state.token = null;
    state.status = null;
    state.catalog = null;
    state.builder = null;
    clear($('drawer-root'));
    showLogin(typeof message === 'string' ? message : '');
  }

  function openSidebar() {
    $('sidebar').classList.add('open');
    $('scrim').hidden = false;
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('scrim').hidden = true;
  }

  function applyTheme() {
    const t = getItem('local', THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const btn = $('theme');
    clear(btn).appendChild(icon(dark ? 'sun' : 'moon', 17));
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }
  function setTheme(t) {
    setItem('local', THEME_KEY, t === 'system' ? null : t);
    applyTheme();
    if (state.route === 'settings') renderPage();
  }

  function init() {
    buildNav();
    applyTheme();
    $('menu').appendChild(icon('menu', 18));
    $('signout').appendChild(icon('logout', 17));
    $('menu').addEventListener('click', openSidebar);
    $('scrim').addEventListener('click', closeSidebar);
    $('theme').addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      setTheme(dark ? 'light' : 'dark');
    });
    $('signout').addEventListener('click', () => signOut());
    $('alerts').addEventListener('click', () => (location.hash = '#/overview'));
    window.addEventListener('hashchange', onRoute);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.token) poll();
    });
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = $('token').value.trim();
      if (!value) return;
      state.token = value;
      setItem('session', TOKEN_KEY, value);
      $('login-error').textContent = '';
      setLive('', 'Connecting…');
      poll();
    });

    const key = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    state.route = PAGES[key] ? key : 'overview';
    state.token = getItem('session', TOKEN_KEY);
    if (state.token) {
      showShell();
      renderPage();
      poll();
    } else {
      showLogin('');
    }
  }

  init();
})();
