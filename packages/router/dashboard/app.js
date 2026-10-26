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
    lastSignature: '',
    lastRender: 0,
    pendingBuilderAdd: null,
    // Owner actions in progress, and the last one's result (shown under the status headline)
    checking: false,
    autoChecked: false,
    failoverRunning: false,
    lastAction: '',
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
    help: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01' }]],
    server: [['rect', { x: 2, y: 3, width: 20, height: 8, rx: 2 }], ['rect', { x: 2, y: 13, width: 20, height: 8, rx: 2 }], ['path', { d: 'M6 7h.01M6 17h.01' }]],
    pause: [['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }], ['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }]],
    play: [['path', { d: 'M6 4l14 8-14 8z' }]],
    refresh: [['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
    zap: [['path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' }]],
    shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 6v6l4 2' }]],
    git: [['circle', { cx: 6, cy: 6, r: 2.5 }], ['circle', { cx: 6, cy: 18, r: 2.5 }], ['circle', { cx: 18, cy: 9, r: 2.5 }], ['path', { d: 'M6 8.5v7M18 11.5c0 3-4 3.5-9.5 5' }]],
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
  function catalogEntry(id) {
    return (state.catalog || []).find((p) => p.id === id) || null;
  }
  /** "Koyeb" for a provider id, else the node label */
  function cloudName(n) {
    const p = n.providerId && catalogEntry(n.providerId);
    return p ? p.displayName.split(' ')[0] : n.label;
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

  /**
   * What a server is doing, from the router's own evidence (live traffic or its latest check):
   * serving | standby (online backup) | error (answers 500) | down | quota | paused | unchecked
   */
  function nodeState(n) {
    if (n.state === 'paused') return 'paused';
    if (n.state === 'down') return 'down';
    if (n.quota && n.quota.percentUsed >= 95) return 'quota';
    if (n.state === 'error') return 'error';
    if (n.state === 'healthy') return n.isBackup ? 'standby' : 'serving';
    return 'unchecked';
  }
  const STATE_VIEW = {
    serving: { cls: 'ok', label: 'Online' },
    standby: { cls: 'ok', label: 'Online, backup' },
    error: { cls: 'warn', label: 'Answering with errors' },
    down: { cls: 'bad', label: 'Not answering' },
    quota: { cls: 'warn', label: 'Free limit reached' },
    paused: { cls: 'warn', label: 'Paused by you' },
    unchecked: { cls: 'idle', label: 'Not checked yet' },
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
  function uniqueByUrl(nodes) {
    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.url)) seen.set(n.url, n);
    return [...seen.values()];
  }
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return url;
    }
  }
  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function listWords(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /** The one-sentence answer to "is my app OK?", from real state only. */
  function verdict(s) {
    const nodes = uniqueByUrl(allNodes(s));
    const names = (list) => listWords(list.map((n) => n.label));
    const downPools = s.pools.filter((p) => p.nodes.length && p.nodes.every((n) => n.state === 'down'));
    const down = nodes.filter((n) => n.state === 'down');
    const error = nodes.filter((n) => n.state === 'error');
    const paused = nodes.filter((n) => n.state === 'paused');
    const online = nodes.filter((n) => n.state === 'healthy');
    const unknown = nodes.filter((n) => n.state === 'unknown');

    if (downPools.length) {
      return {
        cls: 'bad',
        icon: 'x',
        title: 'Your app is down',
        text: 'No server for ' + listWords(downPools.map((p) => p.prefix)) + ' is answering, so visitors get an error. ' + down.map((n) => n.label + ': ' + (n.failureReason || 'no answer')).join('. ') + '. Open that cloud’s dashboard and look at your app’s logs.',
      };
    }
    if (online.length === 0 && unknown.length === nodes.length) {
      return {
        cls: 'idle',
        icon: 'clock',
        title: 'Not checked yet',
        text: 'No request has gone through this copy of the router yet, and no health check has run. Press Check now to ask every server.',
      };
    }
    const others = online.length ? names(online) + (online.length === 1 ? ' is' : ' are') + ' answering' : 'the other servers are answering';
    if (down.length) {
      return {
        cls: 'warn',
        icon: 'alert',
        title: 'Your app is up, but ' + names(down) + (down.length === 1 ? ' is' : ' are') + ' not answering',
        text: others + ', so your visitors are not affected. ' + down.map((n) => n.label + ': ' + (n.failureReason || 'no answer')).join('. ') + '.',
      };
    }
    if (error.length) {
      return {
        cls: 'warn',
        icon: 'alert',
        title: 'Your app is up, but ' + names(error) + ' reports a problem',
        text: error.map((n) => n.label + ': ' + (n.failureReason || 'answered 500')).join('. ') + '. The router still uses it, because a 500 is your app’s own answer. Check that app’s logs.',
      };
    }
    if (paused.length && online.length === 0) {
      return {
        cls: 'idle',
        icon: 'clock',
        title: names(paused) + (paused.length === 1 ? ' is' : ' are') + ' paused; the others are not checked yet',
        text: 'Nothing has shown yet whether your other servers answer. Press Check now, or Resume to undo the pause.',
      };
    }
    if (paused.length) {
      return {
        cls: 'ok',
        icon: 'check',
        title: 'Your app is up. ' + names(paused) + (paused.length === 1 ? ' is' : ' are') + ' paused',
        text: others + '. ' + paused.map((n) => n.label + ' comes back at ' + clockTime(n.pausedUntil)).join('. ') + ', or press Resume.',
      };
    }
    const clouds = listWords([...new Set(nodes.map(cloudName))]);
    const tail = unknown.length ? ' ' + names(unknown) + (unknown.length === 1 ? ' has' : ' have') + ' not been checked yet.' : '';
    return {
      cls: 'ok',
      icon: 'check',
      title: 'Your app is up',
      text:
        (nodes.length === 1
          ? 'One server on ' + clouds + ' is answering. Add a second cloud so your app keeps running if it fails.'
          : plural(online.length, 'server') + ' on ' + clouds + (online.length === 1 ? ' is' : ' are') + ' answering. If one fails, the next takes over within ' + ms(s.routerConfig.timeoutMs) + '.') + tail,
    };
  }

  /** Things the owner should know or do, worst first. Each has a plain fix. */
  function todos(s) {
    const nodes = uniqueByUrl(allNodes(s));
    const list = [];
    const down = nodes.filter((n) => n.state === 'down');
    const error = nodes.filter((n) => n.state === 'error');
    const unknown = nodes.filter((n) => n.state === 'unknown');
    if (down.length) {
      list.push({ state: 'bad', title: listWords(down.map((n) => n.label)) + (down.length === 1 ? ' is' : ' are') + ' not answering', detail: down.map((n) => n.label + ': ' + (n.failureReason || 'no answer')).join('. ') + '. Open that cloud’s dashboard, look at the app’s logs, and redeploy with omnimesh deploy if needed.' });
    }
    if (error.length) {
      list.push({ state: 'warn', title: listWords(error.map((n) => n.label)) + ' answered its health check with an error', detail: 'Your app is running there but says something is wrong (for example, it cannot reach its database). Check that app’s logs.' });
    }
    if (!down.length && !error.length) {
      list.push(unknown.length
        ? { state: 'idle', title: 'Every server answers', detail: listWords(unknown.map((n) => n.label)) + ' not checked yet. Press Check now.' }
        : { state: 'ok', title: 'Every server answers', detail: 'Each server answered its latest request or check.' });
    }

    const single = s.pools.filter((p) => p.nodes.length === 1);
    const sameCloud = s.pools.filter((p) => p.nodes.length > 1 && new Set(p.nodes.map((n) => n.providerId || n.url)).size === 1);
    if (single.length) {
      list.push({ state: 'warn', title: 'Only one server for ' + listWords(single.map((p) => p.prefix)), detail: 'If it goes down, your app goes down: there is nothing to fail over to. Run omnimesh up in your project folder and connect a second cloud.' });
    } else if (sameCloud.length) {
      list.push({ state: 'warn', title: 'All servers for ' + listWords(sameCloud.map((p) => p.prefix)) + ' are on one cloud', detail: 'An outage at that cloud takes them all down. Connect another cloud with omnimesh up.' });
    } else {
      list.push({ state: 'ok', title: 'Backup on another cloud', detail: 'Every route has servers on more than one cloud, so one cloud failing does not take your app down.' });
    }

    const open = nodes.filter((n) => n.lock === 'open');
    const lockUnknown = nodes.filter((n) => n.lock === 'unknown');
    if (open.length) {
      list.push({ state: 'warn', title: listWords(open.map((n) => n.label)) + (open.length === 1 ? ' is' : ' are') + ' not locked', detail: 'Anyone who finds ' + (open.length === 1 ? 'its address' : 'their addresses') + ' (' + open.map((n) => hostOf(n.url)).join(', ') + ') can call your app directly and skip the router’s protection. Fix: add gatewayAuth() from @omnimesh/node to your app, then run omnimesh deploy.' });
    } else if (lockUnknown.length) {
      list.push({ state: 'idle', title: 'Servers locked to the router', detail: 'Not known yet for ' + listWords(lockUnknown.map((n) => n.label)) + '. The next health check finds out.' });
    } else {
      list.push({ state: 'ok', title: 'Servers locked to the router', detail: 'Every server refuses requests that did not come through your router.' });
    }

    if (s.sharing.health !== 'shared') {
      list.push({ state: 'warn', title: 'Automatic health checks are off', detail: 'The router has no shared store (Cloudflare KV), so it cannot run or share checks. Run omnimesh up again to set it up.' });
    } else if (!s.checks.lastScheduledAt) {
      list.push({ state: 'idle', title: 'Automatic health checks', detail: 'Have not run yet. They run every 5 minutes once Cloudflare has the schedule (omnimesh up sets it). If this stays for more than 10 minutes, run omnimesh up again.' });
    } else if (Date.now() - Date.parse(s.checks.lastScheduledAt) > 15 * 60_000) {
      list.push({ state: 'warn', title: 'Automatic health checks stopped', detail: 'They last ran ' + ago(Date.parse(s.checks.lastScheduledAt)) + ' but should run every 5 minutes. Run omnimesh up again to restore the schedule.' });
    } else {
      list.push({ state: 'ok', title: 'Automatic health checks', detail: 'Every 5 minutes. Last ran ' + ago(Date.parse(s.checks.lastScheduledAt)) + '.' });
    }

    for (const p of s.pools) {
      const main = p.nodes.find((n) => !n.isBackup);
      if (main && main.sleepsIfIdle && s.routerConfig.strategy !== 'weighted' && !s.keepAlive.enabled) {
        list.push({ state: 'warn', title: main.label + ' is your main server for ' + p.prefix + ', but it sleeps when idle', detail: 'After a quiet spell, the first visitor waits 30–50 s while it wakes up. Put a cloud that stays on (like Koyeb) first, and keep this one as the backup.' });
      }
    }

    const hot = nodes.filter((n) => n.quota && n.quota.percentUsed >= 80);
    for (const n of hot) {
      list.push({ state: n.quota.percentUsed >= 95 ? 'bad' : 'warn', title: n.label + ' has used ' + n.quota.percentUsed + '% of its free requests', detail: n.quota.percentUsed >= 95 ? 'The router has moved traffic to your other servers until the limit resets.' : 'At 95% the router moves traffic to your other servers by itself.' });
    }

    if (s.routerConfig.rateLimit.enabled && s.sharing.rateLimit !== 'shared') {
      list.push({ state: 'idle', title: 'Rate limit counted per router copy', detail: 'A bot spread over many addresses gets more requests through. Add the RATE_LIMITER binding (see packages/router/wrangler.toml.example).' });
    }
    const order = { bad: 0, warn: 1, idle: 2, ok: 3 };
    return list.sort((a, b) => order[a.state] - order[b.state]);
  }
  const needsAttention = (s) => todos(s).filter((t) => t.state === 'bad' || t.state === 'warn');

  const EVENT_TEXT = {
    node_down: (e) => e.node + ' stopped answering' + (e.detail ? ' (' + e.detail + ')' : '') + '. Requests moved to your other servers.',
    node_up: (e) => e.node + ' is answering again.',
    failover: (e) => e.node + ' answered after another server failed (' + (e.detail || 'failover') + '). The visitor still got a reply.',
    outage: (e) => 'No server for ' + e.pool + ' could answer. Visitors got an error.',
    quota_limit: (e) => e.node + ' reached 95% of its free requests. Traffic moved to your other servers.',
    paused: (e) => 'You paused ' + e.node + (e.detail ? ' for ' + e.detail : '') + '. Your other servers took its visitors.',
    resumed: (e) => 'You resumed ' + e.node + '. It gets traffic again.',
  };
  const EVENT_DOT = { node_down: 'bad', node_up: 'ok', failover: 'warn', outage: 'bad', quota_limit: 'warn', paused: '', resumed: 'ok' };
  const EVENT_FILTERS = [
    ['all', 'All'],
    ['node_down', 'Stopped'],
    ['node_up', 'Recovered'],
    ['failover', 'Backup answered'],
    ['outage', 'Outages'],
    ['quota_limit', 'Free limits'],
    ['paused', 'Your actions'],
  ];

  function eventList(events, emptyText) {
    if (!events.length) {
      return h('div', { class: 'empty' }, h('strong', { text: 'Nothing has happened yet' }), emptyText || 'When a server stops, recovers, or a backup answers, it shows up here.');
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
      h('div', { class: 'bar-label' }, h('span', { text: fmt(used) + ' of ' + fmt(limit) + (q.requestsPerDay ? ' today' : ' this month') }), h('span', { text: q.percentUsed + '%' })),
      h('div', { class: 'bar', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': q.percentUsed } }, h('span', { class: cls, style: { width: Math.min(100, q.percentUsed) + '%' } }))
    );
  }

  function card(title, body, extra) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: title }), h('span', { class: 'spacer' }), extra || null), body);
  }

  function kpi(label, value, sub, iconName) {
    return h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, iconName ? icon(iconName, 14) : null, label), h('div', { class: 'kpi-value', text: value }), h('div', { class: 'kpi-sub', text: sub || '' }));
  }

  function checkRow(c) {
    const ic = { ok: 'check', bad: 'x', warn: 'alert', idle: 'minus' }[c.state];
    return h('div', { class: 'check' }, h('span', { class: 'check-icon ' + c.state }, icon(ic, 13)), h('div', null, h('div', { class: 'check-title', text: c.title }), h('div', { class: 'check-detail', text: c.detail })), h('span'));
  }

  const kvList = (rows) => h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));

  // ---------------------------------------------------------------- pages

  const PAGES = {
    overview: {
      title: 'Overview',
      sub: 'Is your app up, and what needs your attention',
      group: 'Your app',
      icon: 'overview',
      render(view, s) {
        const t = s.totals;
        const rate = t.requests ? (t.succeeded / t.requests) * 100 : null;
        const attention = needsAttention(s);
        const servers = uniqueByUrl(allNodes(s));
        append(view, [
          hero(s),
          attention.length
            ? card('Needs your attention', h('div', { class: 'checklist' }, attention.map(checkRow)), h('a', { href: '#/setup', text: 'Full checklist' }))
            : null,
          h(
            'div',
            { class: 'kpis kpis-4', style: { marginTop: '16px' } },
            kpi('Requests', fmt(t.requests), 'since this router copy started ' + duration(s.instance.uptimeSeconds) + ' ago', 'activity'),
            kpi('Answered without error', rate === null ? '–' : rate.toFixed(rate >= 99.95 || rate < 10 ? 1 : 2) + '%', t.requests ? fmt(t.failed) + ' failed' : 'no requests yet', 'check'),
            kpi('Response time', s.latency.samples ? ms(s.latency.p95) : '–', s.latency.samples ? '95% of requests were faster' : 'no requests yet', 'clock'),
            kpi('Backup took over', fmt(t.failovers), t.failovers === 1 ? 'time a server failed and another answered' : 'times a server failed and another answered', 'routing')
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Your servers' }), h('span', { class: 'count', text: s.routerConfig.strategy === 'weighted' ? 'requests are spread across them' : 'the first online one answers; the others wait as backups' }), h('span', { class: 'spacer' }), h('a', { href: '#/servers', text: 'Details' })),
          h('div', { class: 'server-grid' }, servers.map((n) => serverCard(s, n, { compact: true }))),
          h(
            'div',
            { class: 'grid-2', style: { marginTop: '16px' } },
            card('What happened', eventList(s.events.slice(0, 6)), h('a', { href: '#/activity', text: 'All activity' })),
            appCard(s)
          ),
        ]);
      },
    },

    servers: {
      title: 'Servers',
      sub: 'Every copy of your app, on every cloud',
      group: 'Your app',
      icon: 'server',
      badge: (s) => {
        const down = uniqueByUrl(allNodes(s)).filter((n) => n.state === 'down').length;
        return down ? { cls: 'bad', text: String(down) } : null;
      },
      render(view, s) {
        const cfg = s.routerConfig;
        append(view, [
          h(
            'div',
            { class: 'toolbar' },
            checkButton(s),
            failoverButton(s),
            h('span', { class: 'muted small', text: checksLine(s) })
          ),
          meshMap(s),
          s.pools.map((p) => [
            h('div', { class: 'section-title' }, h('h2', { class: 'mono', text: p.prefix }), h('span', { class: 'count', text: (p.prefix === '/' ? 'every request' : 'requests to ' + p.prefix + '…') + ' · ' + plural(p.nodes.length, 'server') + (p.isDefault ? ' · default route' : '') })),
            h('div', { class: 'server-grid' }, p.nodes.map((n) => serverCard(s, Object.assign({ pool: p.prefix }, n), { pool: p }))),
          ]),
          h('div', { class: 'section-title' }, h('h2', { text: 'How the router picks a server' })),
          h(
            'div',
            { class: 'grid-3' },
            kpi('Order', cfg.strategy === 'weighted' ? 'Spread out' : 'Main first', cfg.strategy === 'weighted' ? 'requests are spread across online servers' : 'the first online server answers; the others are backups'),
            kpi('Waits for a server', ms(cfg.timeoutMs), 'then tries the next one (up to ' + cfg.maxAttempts + ' servers, ' + ms(cfg.totalBudgetMs) + ' in total)'),
            kpi('Skips a failed server for', ms(cfg.circuitTtlMs), 'then one request checks if it is back')
          ),
        ]);
      },
    },

    activity: {
      title: 'Activity',
      sub: 'What happened, in plain words',
      group: 'Your app',
      icon: 'activity',
      render(view, s) {
        const counts = {};
        for (const e of s.events) counts[e.kind === 'resumed' ? 'paused' : e.kind] = (counts[e.kind === 'resumed' ? 'paused' : e.kind] || 0) + 1;
        const matches = (e) => state.eventFilter === 'all' || e.kind === state.eventFilter || (state.eventFilter === 'paused' && e.kind === 'resumed');
        const filtered = s.events.filter(matches);
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
          h('div', { class: 'card' }, eventList(filtered, state.eventFilter === 'all' ? undefined : 'Nothing of this kind on this router copy.')),
          h('p', { class: 'muted small', text: 'Shows what this copy of the router saw since it started ' + duration(s.instance.uptimeSeconds) + ' ago (Cloudflare runs several copies; each keeps its own list). Repeats within 5 seconds are grouped as ×N.' }),
        ]);
      },
    },

    traffic: {
      title: 'Traffic',
      sub: 'Requests, speed and protection',
      group: 'Your app',
      icon: 'health',
      render(view, s) {
        const t = s.totals;
        const cfg = s.routerConfig;
        append(view, [
          h(
            'div',
            { class: 'kpis kpis-4' },
            kpi('Requests', fmt(t.requests), fmt(t.succeeded) + ' answered without error'),
            kpi('Failed', fmt(t.failed), t.requests ? ((t.failed / t.requests) * 100).toFixed(2) + '% of requests' : 'no requests yet'),
            kpi('Blocked', fmt(t.rateLimited + t.rejected), fmt(t.rateLimited) + ' too many requests · ' + fmt(t.rejected) + ' too large'),
            kpi('Backup took over', fmt(t.failovers), 'another server answered')
          ),
          h(
            'div',
            { class: 'grid-3', style: { marginTop: '16px' } },
            card('Response time', h('div', { class: 'card-body' }, s.latency.samples ? kvList([['Half of requests under', ms(s.latency.p50)], ['95% under', ms(s.latency.p95)], ['99% under', ms(s.latency.p99)], ['Measured', plural(s.latency.samples, 'request')]]) : h('p', { class: 'muted', style: { margin: 0 }, text: 'No requests yet on this router copy.' }))),
            card('Protection', h('div', { class: 'card-body' }, kvList([['Rate limit', cfg.rateLimit.enabled ? cfg.rateLimit.requestsPerMinute + ' per minute per visitor' : 'off'], ['Largest request', bytes(cfg.maxBodyBytes)], ['Shared rate limit', s.sharing.rateLimit === 'shared' ? 'yes' : 'per router copy']]))),
            card('When a server fails', h('div', { class: 'card-body' }, kvList([['Wait per server', ms(cfg.timeoutMs)], ['Servers tried', 'up to ' + cfg.maxAttempts], ['Longest total wait', ms(cfg.totalBudgetMs)], ['Skip a failed server for', ms(cfg.circuitTtlMs)]])))
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Per server' }), h('span', { class: 'count', text: 'requests this router copy sent to each' })),
          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'table' },
              h('div', { class: 'tr th', style: { gridTemplateColumns: 'minmax(160px,1.4fr) 150px 1fr 1fr 1fr' } }, ['Server', 'Status', 'Requests', 'Errors', 'Last response'].map((x) => h('div', { text: x }))),
              uniqueByUrl(allNodes(s)).map((n) =>
                h(
                  'div',
                  { class: 'tr', style: { gridTemplateColumns: 'minmax(160px,1.4fr) 150px 1fr 1fr 1fr' } },
                  h('div', { class: 'node-cell' }, stateDot(n), h('span', { class: 'node-name', text: n.label })),
                  h('div', null, statePill(n)),
                  h('div', { class: 'num', text: fmt(n.requests) }),
                  h('div', { class: 'num', text: fmt(n.errors) + (n.requests ? ' (' + Math.round((n.errors / n.requests) * 100) + '%)' : '') }),
                  h('div', { class: 'num', text: ms(n.latencyMs) })
                )
              )
            )
          ),
          h('p', { class: 'muted small', text: 'Counts are for this copy of the router since it started ' + duration(s.instance.uptimeSeconds) + ' ago. Cloudflare runs several copies, so totals across all of them are higher.' }),
        ]);
      },
    },

    'free-tiers': {
      title: 'Free limits',
      sub: 'How much of each cloud’s free plan you have used',
      group: 'Your app',
      icon: 'gauge',
      badge: (s) => {
        const hot = uniqueByUrl(allNodes(s)).filter((n) => n.quota && n.quota.percentUsed >= 80).length;
        return hot ? { cls: 'warn', text: String(hot) } : null;
      },
      render(view, s) {
        const servers = uniqueByUrl(allNodes(s));
        append(view, [
          h(
            'div',
            { class: 'grid-2' },
            card(
              'Router: Cloudflare Workers Free',
              h(
                'div',
                { class: 'card-body stack' },
                h('div', null, h('div', { class: 'kpi-value', text: '100,000 / day' }), h('div', { class: 'kpi-sub', text: 'requests, shared by every copy of the router' })),
                h('p', { class: 'muted', style: { margin: 0 }, text: 'Every request to your app runs the router, so this is how many requests your app can take per day for free. After that, Cloudflare answers with error 1027 until midnight UTC. Workers Paid ($5/month) raises it to 10 million per month.' })
              )
            ),
            card(
              'How OmniMesh stays inside free plans',
              h(
                'div',
                { class: 'card-body' },
                h(
                  'ol',
                  { class: 'steps' },
                  h('li', { text: 'Clouds with a request limit are counted as traffic flows.' }),
                  h('li', { text: 'At 80% you get a warning here and on the overview.' }),
                  h('li', { text: 'At 95% the router sends new traffic to your other servers, with no errors for visitors.' }),
                  h('li', { text: 'Clouds limited by hours or bandwidth are switched when they refuse requests (429) or fail.' })
                )
              )
            )
          ),
          h('div', { class: 'section-title' }, h('h2', { text: 'Your clouds' })),
          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'table' },
              servers.map((n) => {
                const p = n.providerId && catalogEntry(n.providerId);
                return h(
                  'div',
                  { class: 'tr', style: { gridTemplateColumns: 'minmax(160px, 1fr) 150px minmax(220px, 2fr)' } },
                  h('div', { class: 'node-cell' }, tile(n.providerId || n.label, n.label, 30), h('div', null, h('div', { class: 'node-name', text: n.label }), p ? h('div', { class: 'muted small', text: p.requiresCard ? 'card on file' : 'no card' }) : null)),
                  h('div', null, statePill(n)),
                  n.quota
                    ? quotaBar(n.quota)
                    : h('div', { class: 'muted', text: p ? (limitsSummary(p.limits) || 'See the cloud’s pricing page') + ' (not counted in requests)' : 'Unknown cloud (no providerId in the config)' })
                );
              })
            )
          ),
          h('p', { class: 'muted small', text: 'Request counts are kept by this router copy. Limits come from each cloud’s pricing page; the date they were last checked is on the Clouds page.' }),
        ]);
      },
    },

    setup: {
      title: 'Checklist',
      sub: 'What is set up, what is missing, and how to fix it',
      group: 'Set up',
      icon: 'setup',
      badge: (s) => {
        const open = needsAttention(s).length;
        return open ? { cls: todos(s)[0].state === 'bad' ? 'bad' : 'warn', text: String(open) } : null;
      },
      keepsInput: true,
      render(view, s) {
        if (!state.builder) state.builder = builderFromStatus(s);
        if (state.pendingBuilderAdd) {
          addBuilderNode(state.pendingBuilderAdd);
          state.pendingBuilderAdd = null;
        }
        const checks = todos(s);
        const done = checks.filter((c) => c.state === 'ok').length;
        append(view, [
          card('Your setup', h('div', { class: 'checklist' }, checks.map(checkRow)), h('span', { class: 'pill ' + (done === checks.length ? 'ok' : 'accent'), text: done + ' of ' + checks.length + ' done' })),
          h(
            'div',
            { style: { marginTop: '16px' } },
            card(
              'Add a cloud, change settings or ship new code',
              h(
                'div',
                { class: 'card-body stack' },
                h('p', { style: { margin: 0 } }, 'In your project folder, run ', h('code', { text: 'omnimesh up' }), ' to add a cloud or change your app’s settings, and ', h('code', { text: 'omnimesh deploy' }), ' to ship your latest code to every cloud.'),
                h('p', { class: 'muted small', style: { margin: 0 }, text: 'This dashboard runs on Cloudflare and never holds your cloud keys, so those changes happen on your computer.' })
              )
            )
          ),
          h('details', { class: 'advanced' }, h('summary', { text: 'Advanced: write the config by hand' }), h('p', { class: 'muted small', text: 'Builds an omnimesh.config.yaml for servers you deployed yourself. Nothing is saved on the router.' }), builderView()),
        ]);
      },
    },

    providers: {
      title: 'Clouds',
      sub: 'Free clouds you can host your backend on',
      group: 'Set up',
      icon: 'providers',
      keepsInput: true,
      render(view, s) {
        if (!state.catalog) {
          view.appendChild(h('div', { class: 'card empty', text: 'Loading the list of clouds…' }));
          return;
        }
        const usage = meshUsage(s);
        const filters = [
          ['all', 'All', () => true],
          ['no-card', 'No card needed', (p) => !p.requiresCard && p.tier === 'free'],
          ['card', 'Needs a card', (p) => p.requiresCard && p.tier === 'free'],
          ['in-mesh', 'You use', (p) => usage.has(p.id)],
        ];
        const search = h('input', {
          type: 'search',
          placeholder: 'Search clouds or roles',
          value: state.providerSearch,
          attrs: { 'aria-label': 'Search clouds' },
          oninput: (e) => {
            state.providerSearch = e.target.value;
            drawGrid();
          },
        });
        const chipBox = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter clouds' } });
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
            gridBox.appendChild(h('div', { class: 'section-title' }, h('h2', { text: title }), h('span', { class: 'count', text: plural(items.length, 'cloud') })));
            gridBox.appendChild(h('div', { class: 'provider-grid' }, items.map((p) => providerCard(p, usage.get(p.id)))));
          }
          if (!any) gridBox.appendChild(h('div', { class: 'card empty' }, h('strong', { text: 'No clouds match' }), 'Try another search or filter.'));
        }

        drawChips();
        drawGrid();
        append(view, [h('div', { class: 'toolbar', style: { marginBottom: '4px' } }, h('div', { class: 'search' }, icon('search', 15), search), chipBox), gridBox]);
        if (state.providerSearch) search.focus();
      },
    },

    settings: {
      title: 'Settings',
      sub: 'Router settings, appearance and sign-in',
      group: 'System',
      icon: 'settings',
      render(view, s) {
        const cfg = s.routerConfig;
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
                kvList([
                  ['Address', s.domain],
                  ['Order', cfg.strategy === 'weighted' ? 'spread out' : 'main first'],
                  ['Default route', cfg.defaultPool || 'none (unknown paths get 404)'],
                  ['Wait per server', ms(cfg.timeoutMs)],
                  ['Longest total wait', ms(cfg.totalBudgetMs)],
                  ['Largest request', bytes(cfg.maxBodyBytes)],
                  ['Keep sleeping servers awake', s.keepAlive.enabled ? 'on' : 'off'],
                ]),
                h('p', { class: 'muted small', style: { margin: 0 }, text: 'These come from the router config. Change them with omnimesh up, or in omnimesh.config.yaml followed by omnimesh deploy.' })
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
                'Sign-in',
                h(
                  'div',
                  { class: 'card-body stack' },
                  h('p', { class: 'muted', style: { margin: 0 }, text: 'Your sign-in key is kept in this browser tab only and is cleared when you sign out or close the tab. To change it, run omnimesh token --rotate in your project folder.' }),
                  h('div', null, h('button', { class: 'btn', type: 'button', onclick: signOut }, icon('logout', 15), 'Sign out'))
                )
              ),
              card('About', h('div', { class: 'card-body' }, kvList([['OmniMesh', 'v' + s.version], ['This router copy started', new Date(s.instance.startedAt).toLocaleString()]])))
            )
          ),
        ]);
      },
    },
  };

  const ROUTE_ORDER = ['overview', 'servers', 'activity', 'traffic', 'free-tiers', 'setup', 'providers', 'settings'];
  /** Old links keep working */
  const ROUTE_ALIASES = { routing: 'servers', health: 'traffic' };

  // ---------------------------------------------------------------- page parts

  function checksLine(s) {
    if (state.checking) return 'Checking every server… a sleeping free server can take up to a minute to wake up.';
    if (!s.checks.lastAt) return 'No health check has run yet.';
    return 'Last health check ' + ago(Date.parse(s.checks.lastAt)) + (s.checks.lastTrigger === 'schedule' ? ' (automatic, every 5 minutes)' : ' (you asked)') + '.';
  }

  function checkButton(s, primary) {
    return h(
      'button',
      { class: 'btn' + (primary ? ' btn-primary' : ''), type: 'button', disabled: state.checking, onclick: () => checkNow() },
      icon('refresh', 15),
      state.checking ? 'Checking…' : 'Check now'
    );
  }

  function failoverButton(s) {
    const possible = s.pools.some((p) => p.nodes.length >= 2);
    return h(
      'button',
      {
        class: 'btn',
        type: 'button',
        disabled: state.failoverRunning,
        title: possible ? 'Pause the server that answers, check another cloud takes over, then resume it' : 'Needs at least two servers',
        onclick: () => openFailoverTest(),
      },
      icon('zap', 15),
      state.failoverRunning ? 'Testing failover…' : 'Test failover'
    );
  }

  function hero(s) {
    const v = verdict(s);
    return h(
      'section',
      { class: 'card hero hero-' + v.cls },
      h('div', { class: 'hero-icon' }, icon(v.icon, 26)),
      h(
        'div',
        { class: 'hero-main' },
        h('h2', { class: 'hero-title', text: v.title }),
        h('p', { class: 'hero-text', text: v.text }),
        h(
          'div',
          { class: 'hero-actions' },
          checkButton(s, v.cls === 'idle'),
          failoverButton(s),
          h('a', { class: 'btn', href: location.origin + '/', target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), 'Open my app'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: openGlossary }, icon('help', 14), 'What do the words mean?')
        ),
        h('div', { class: 'hero-meta muted small', text: checksLine(s) + (state.lastAction ? ' ' + state.lastAction : '') })
      )
    );
  }

  function serverCard(s, n, opts) {
    const st = nodeState(n);
    const v = STATE_VIEW[st];
    const p = n.providerId && catalogEntry(n.providerId);
    const pool = (opts && opts.pool) || s.pools.find((x) => x.nodes.some((m) => m.url === n.url));
    const firstPrimary = pool ? pool.nodes.find((m) => !m.isBackup) : null;
    const roleText = n.isBackup
      ? 'Backup'
      : s.routerConfig.strategy === 'weighted'
        ? 'Shares the load' + (n.weight > 1 ? ' ×' + n.weight : '')
        : firstPrimary && firstPrimary.url === n.url
          ? 'Main server'
          : 'Next in line';
    const lock =
      n.lock === 'locked'
        ? h('span', { class: 'pill ok', title: 'Refuses requests that did not come through your router' }, icon('shield', 12), 'Locked')
        : n.lock === 'open'
          ? h('span', { class: 'pill warn', title: 'Anyone with its address can skip the router. Add gatewayAuth() from @omnimesh/node.' }, icon('alert', 12), 'Not locked')
          : null;
    const check = n.check;
    const lastSeen = n.lastChecked ? ago(n.lastChecked) : 'never';
    const facts = [
      ['Response', ms(n.latencyMs != null ? n.latencyMs : check && check.latencyMs)],
      ['Last seen', lastSeen],
    ];
    if (!(opts && opts.compact)) {
      facts.push(['Requests', fmt(n.requests)], ['Errors', fmt(n.errors)]);
    }
    let note = null;
    if (st === 'down' || st === 'error') note = h('div', { class: 'server-note bad', text: n.failureReason || 'no answer' });
    else if (st === 'paused') note = h('div', { class: 'server-note', text: 'No traffic until ' + clockTime(n.pausedUntil) + '. It still answers if every other server fails.' });
    else if (st === 'unchecked' && n.checkable === false) note = h('div', { class: 'server-note', text: 'Not checked: one check covers your first 20 servers (Cloudflare allows 50 outgoing requests per run). Live traffic still shows if it answers.' });
    else if (st === 'unchecked' && n.sleepsIfIdle) note = h('div', { class: 'server-note', text: 'Free ' + cloudName(n) + ' servers sleep when idle, so automatic checks skip it (they would keep it awake). Check now wakes it.' });

    const actions = [];
    if (st === 'paused') {
      actions.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => resumeNode(pool.prefix, n.label) }, icon('play', 13), 'Resume now'));
    } else if (pool && pool.nodes.some((m) => m.url !== n.url && m.state !== 'paused' && m.state !== 'down')) {
      // Same rule as the router: never offer a pause that would leave the route without a working server
      actions.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => confirmPause(pool.prefix, n) }, icon('pause', 13), 'Pause 60 s'));
    }

    return h(
      'article',
      { class: 'server-card state-' + v.cls },
      h(
        'div',
        { class: 'server-top' },
        tile(n.providerId || n.label, p ? p.displayName : n.label, 36),
        h('div', { class: 'ellipsis' }, h('div', { class: 'node-name', text: n.label }), h('div', { class: 'node-url', text: hostOf(n.url), title: n.url })),
        h('span', { class: 'spacer' }),
        statePill(n)
      ),
      h('div', { class: 'server-tags' }, h('span', { class: 'role', text: roleText }), lock, p ? h('span', { class: 'role', text: p.requiresCard ? 'card on file' : 'free, no card' }) : null),
      h('dl', { class: 'server-facts' }, facts.map(([k, val]) => h('div', null, h('dt', { text: k }), h('dd', { text: val })))),
      n.quota ? quotaBar(n.quota) : null,
      note,
      actions.length ? h('div', { class: 'server-actions' }, actions) : null
    );
  }

  function appCard(s) {
    const a = s.app;
    if (!a) {
      return card(
        'Your app',
        h(
          'div',
          { class: 'card-body stack' },
          kvList([['Address', location.origin], ['Servers', plural(uniqueByUrl(allNodes(s)).length, 'server')]]),
          h('p', { class: 'muted small', style: { margin: 0 }, text: 'These servers were set up by hand, so the router does not know which code they run. Deploy with omnimesh up to see your repository and deploy time here.' })
        )
      );
    }
    const runtime = { node: 'Node.js', python: 'Python', docker: 'Docker' }[a.runtime] || a.runtime;
    return card(
      'Your app',
      h(
        'div',
        { class: 'card-body stack' },
        kvList([
          ['Address', location.origin],
          ['Code', a.repo + ' (' + a.branch + ')'],
          ['Kind', runtime],
          ['Last deployed', a.deployedAt ? new Date(a.deployedAt).toLocaleString() : 'unknown'],
        ]),
        h(
          'div',
          { class: 'toolbar', style: { margin: 0 } },
          a.repoUrl ? h('a', { class: 'btn btn-sm', href: a.repoUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('git', 13), 'Repository') : null,
          h('span', { class: 'muted small' }, 'Ship new code: ', h('code', { text: 'omnimesh deploy' }))
        )
      )
    );
  }

  const GLOSSARY = [
    ['Server', 'One copy of your app, running on one cloud (for example Koyeb or Render). OmniMesh runs the same app on several clouds.'],
    ['Router', 'The small program on Cloudflare that owns your one address and picks a server for every request.'],
    ['Route', 'A part of your app’s address, like / or /api. Each route has its own list of servers.'],
    ['Main server / Backup', 'The main server answers first. A backup answers when the servers before it can’t.'],
    ['Not answering', 'The server did not reply, timed out, or its cloud said it is unavailable. The router skips it and tries it again a little later.'],
    ['Answering with errors', 'The server replied, but its health check said something is wrong (status 500), for example it cannot reach its database.'],
    ['Paused', 'You asked the router to skip this server for a short time (up to 5 minutes). It comes back by itself.'],
    ['Check now', 'Asks every server right away whether it is answering, and whether it is locked.'],
    ['Test failover', 'Pauses the server that is answering, sends real requests to your app, shows which cloud took over, and resumes it.'],
    ['Locked / Not locked', 'A locked server refuses requests that did not come through your router, so nobody can skip its protection.'],
    ['Backup took over', 'How often a server failed and another one answered instead. Your visitors still got a reply.'],
    ['Response time', 'How long requests take. 95% of requests were faster than the number shown.'],
    ['Sign-in key', 'The password for this dashboard (OMNIMESH_STATUS_TOKEN in your project’s .env).'],
  ];

  function openDrawer(title, bodyChildren, opts) {
    const root = $('drawer-root');
    const previouslyFocused = document.activeElement;
    const close = () => {
      clear(root);
      document.removeEventListener('keydown', onKey);
      if (opts && opts.onClose) opts.onClose();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', onclick: close, attrs: { 'aria-label': 'Close' } }, icon('x', 18));
    const body = h('div', { class: 'drawer-body' }, bodyChildren);
    append(clear(root), [
      h('div', { class: 'drawer-scrim', onclick: close }),
      h('aside', { class: 'drawer', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, h('div', { class: 'drawer-head' }, (opts && opts.lead) || null, h('h2', { text: title }), closeBtn), body),
    ]);
    closeBtn.focus();
    return { close, body };
  }

  function openGlossary() {
    openDrawer('What the words mean', h('dl', { class: 'glossary' }, GLOSSARY.map(([term, text]) => [h('dt', { text: term }), h('dd', { text })])));
  }

  function meshMap(s) {
    return h(
      'div',
      { class: 'card card-body mesh' },
      h('div', { class: 'mesh-entry' }, 'Your visitors', icon('arrow', 14), h('span', { class: 'mesh-node-router' }, icon('globe', 14), s.domain), icon('arrow', 14), 'your servers'),
      s.pools.map((p) =>
        h(
          'div',
          { class: 'mesh-row' },
          h('div', null, h('div', { class: 'mesh-prefix', text: p.prefix }), p.isDefault ? h('div', { class: 'muted small', text: 'default' }) : null),
          h('span', { class: 'mesh-arrow' }, icon('arrow', 16)),
          h(
            'div',
            { class: 'mesh-chips' },
            p.nodes.map((n, i) => [
              i > 0 ? h('span', { class: 'mesh-then', text: s.routerConfig.strategy === 'weighted' ? 'or' : 'then' }) : null,
              h('span', { class: 'chip', title: n.url }, stateDot(n), n.label, h('span', { class: 'chip-sub', text: STATE_VIEW[nodeState(n)].label.toLowerCase() })),
            ])
          )
        )
      )
    );
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
      ? h('span', { class: 'pill ' + (use.down ? 'bad' : 'ok') }, use.down ? use.down + ' of ' + use.nodes + ' not answering' : 'You use it · ' + plural(use.nodes, 'server'))
      : h('span', { class: 'pill idle', text: 'Not used' });
    return h(
      'button',
      { class: 'provider', type: 'button', onclick: () => openProvider(p, use), attrs: { 'aria-label': p.displayName + ' details' } },
      h('div', { class: 'provider-top' }, tile(p.id, p.displayName), h('div', { class: 'ellipsis' }, h('div', { class: 'provider-name', text: p.displayName }), h('div', { class: 'muted small', text: p.requiresCard ? 'Card needed for sign-up' : p.tier === 'free' ? 'No card needed' : 'Paid plan' }))),
      h('div', { class: 'provider-limits', text: limitsSummary(p.limits) }),
      h('div', { class: 'provider-foot' }, status, p.roles.slice(0, 3).map((r) => h('span', { class: 'role', text: r })))
    );
  }

  // ---------------------------------------------------------------- owner actions (real API calls)

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    }).then((res) =>
      res.json().then(
        (data) => ({ ok: res.ok, status: res.status, data }),
        () => ({ ok: res.ok, status: res.status, data: {} })
      )
    );
  }

  function noteAction(text) {
    state.lastAction = text;
    toast(text);
  }

  async function checkNow() {
    if (state.checking) return;
    state.checking = true;
    renderPage();
    try {
      const r = await apiPost('/_omnimesh/actions/check');
      if (r.ok) {
        const results = Object.values(r.data.nodes || {});
        const bad = results.filter((x) => x.state !== 'online').length;
        noteAction('Checked ' + plural(results.length, 'server') + (bad ? ': ' + bad + ' with a problem.' : ': all answering.'));
      } else if (r.status === 404) {
        signOut('Your sign-in key is no longer accepted. Run omnimesh open in your project folder.');
        return;
      } else {
        noteAction(r.data.error || 'The check did not run (status ' + r.status + ').');
      }
    } catch (e) {
      noteAction('Could not reach the router: ' + e.message);
    } finally {
      state.checking = false;
    }
    poll();
  }

  function confirmPause(pool, n) {
    const others = (state.status.pools.find((p) => p.prefix === pool) || { nodes: [] }).nodes.filter((m) => m.url !== n.url).map((m) => m.label);
    const go = h('button', { class: 'btn btn-primary', type: 'button' }, icon('pause', 14), 'Pause ' + n.label + ' for 60 s');
    const msg = h('div', { class: 'form-error', attrs: { role: 'alert' } });
    const drawer = openDrawer('Pause ' + n.label + '?', [
      h('p', { style: { margin: 0 } }, 'The router stops sending visitors to ', h('strong', { text: n.label }), ' for 60 seconds. ', h('strong', { text: listWords(others) }), others.length === 1 ? ' answers instead.' : ' answer instead.'),
      h('ul', { class: 'steps' }, h('li', { text: 'Nothing is switched off. ' + n.label + ' keeps running on ' + cloudName(n) + '.' }), h('li', { text: 'If every other server fails meanwhile, ' + n.label + ' still answers, so a pause never takes your app offline.' }), h('li', { text: 'It comes back by itself after 60 seconds, or press Resume now.' })),
      h('div', { class: 'toolbar', style: { margin: 0 } }, go),
      msg,
    ]);
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await apiPost('/_omnimesh/actions/pause', { pool, node: n.label, seconds: 60 }).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
      if (r.ok) {
        drawer.close();
        noteAction('Paused ' + n.label + ' until ' + clockTime(r.data.until) + '.' + (r.data.shared === false ? ' Only this router copy knows (the shared store did not answer).' : ''));
        poll();
      } else {
        msg.textContent = r.data.error || 'The router refused (status ' + r.status + ').';
        go.disabled = false;
      }
    });
  }

  async function resumeNode(pool, label) {
    const r = await apiPost('/_omnimesh/actions/resume', { pool, node: label }).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
    noteAction(r.ok ? label + ' gets traffic again.' : r.data.error || 'Could not resume ' + label + '.');
    poll();
  }

  /** The request path used for a failover test: the server's health path when it belongs to this route. */
  function testPath(prefix, healthPath) {
    if (healthPath && (prefix === '/' || healthPath === prefix || healthPath.startsWith(prefix.replace(/\/$/, '') + '/'))) return healthPath;
    return prefix;
  }

  async function askApp(path) {
    const t0 = performance.now();
    try {
      const res = await fetch(path, { cache: 'no-store', credentials: 'omit' });
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      return { status: res.status, node: res.headers.get('X-Omni-Node'), attempts: Number(res.headers.get('X-Omni-Attempts') || 0), ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { status: 0, node: null, attempts: 0, ms: Math.round(performance.now() - t0) };
    }
  }
  const wait = (msTime) => new Promise((r) => setTimeout(r, msTime));
  const avgMs = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b.ms, 0) / xs.length) : 0);

  function openFailoverTest() {
    const s = state.status;
    const pool = s.pools.slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).find((p) => p.nodes.length >= 2);
    if (!pool) {
      openDrawer('Test failover', [h('p', { style: { margin: 0 }, text: 'Every route has only one server, so there is nothing to fail over to yet.' }), h('p', { class: 'muted', style: { margin: 0 } }, 'Run ', h('code', { text: 'omnimesh up' }), ' in your project folder and connect a second cloud. Then come back and test.')]);
      return;
    }
    const path = testPath(pool.prefix, pool.nodes[0].healthPath);
    const steps = [
      { text: 'Ask your app which server answers', state: 'wait', detail: '' },
      { text: 'Pause that server', state: 'wait', detail: '' },
      { text: 'Wait for another cloud to answer', state: 'wait', detail: '' },
      { text: 'Send a few more requests', state: 'wait', detail: '' },
      { text: 'Put the paused server back', state: 'wait', detail: '' },
    ];
    const list = h('ol', { class: 'run-steps' });
    const verdictBox = h('div', { attrs: { 'aria-live': 'polite' } });
    const start = h('button', { class: 'btn btn-primary', type: 'button' }, icon('zap', 14), 'Start the test');
    const draw = () => {
      clear(list);
      for (const st of steps) {
        const ic = { wait: 'minus', run: 'refresh', ok: 'check', bad: 'x' }[st.state];
        list.appendChild(h('li', { class: 'run-step ' + st.state }, h('span', { class: 'check-icon ' + ({ wait: 'idle', run: 'idle', ok: 'ok', bad: 'bad' }[st.state]) }, icon(ic, 13)), h('div', null, h('div', { class: 'check-title', text: st.text }), st.detail ? h('div', { class: 'check-detail', text: st.detail }) : null)));
      }
    };
    draw();
    openDrawer('Test failover', [
      h('p', { style: { margin: 0 } }, 'This sends real requests to ', h('strong', { text: location.origin + path }), ', pauses the server that answers for up to 60 seconds, and checks that another cloud takes over. Your visitors keep being served the whole time.'),
      h('div', { class: 'toolbar', style: { margin: 0 } }, start),
      list,
      verdictBox,
    ]);

    const set = (i, st, detail) => {
      steps[i].state = st;
      if (detail !== undefined) steps[i].detail = detail;
      draw();
    };
    const finish = (ok, text) => {
      clear(verdictBox).appendChild(h('div', { class: 'banner ' + (ok ? 'ok' : 'bad') }, h('span', { class: 'dot ' + (ok ? 'ok' : 'bad') }), h('span', { text })));
      state.failoverRunning = false;
      clear(start);
      append(start, [icon('zap', 14), 'Run it again']);
      start.disabled = false;
      noteAction(text);
      poll();
    };

    start.addEventListener('click', async () => {
      start.disabled = true;
      state.failoverRunning = true;
      for (const st of steps) {
        st.state = 'wait';
        st.detail = '';
      }
      clear(verdictBox);
      const labels = pool.nodes.map((n) => n.label);
      set(0, 'run');
      const before = [];
      for (let i = 0; i < 3; i++) before.push(await askApp(path));
      const served = before.filter((a) => a.status > 0 && a.status < 500 && a.node && labels.includes(a.node));
      if (!served.length) {
        set(0, 'bad', 'Got ' + before.map((a) => a.status || 'no answer').join(', ') + ' on ' + path + '.');
        return finish(false, 'Your app is not answering through the router right now, so failover cannot be tested. Check now shows which servers have a problem.');
      }
      const counts = {};
      for (const a of served) counts[a.node] = (counts[a.node] || 0) + 1;
      const target = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      set(0, 'ok', target + ' answered ' + served.length + ' of ' + before.length + ' requests (avg ' + avgMs(served) + ' ms).');

      set(1, 'run');
      const pause = await apiPost('/_omnimesh/actions/pause', { pool: pool.prefix, node: target, seconds: 60 }).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
      if (!pause.ok) {
        set(1, 'bad', pause.data.error || 'The router refused (status ' + pause.status + ').');
        return finish(false, pause.status === 409 ? 'Failover would not work right now. ' + (pause.data.error || '') : 'The test could not pause ' + target + '.');
      }
      set(1, 'ok', target + ' gets no traffic until ' + clockTime(pause.data.until) + ' at the latest.');

      let ok = false;
      let text = '';
      try {
        set(2, 'run');
        const t0 = Date.now();
        let first = null;
        let fallback = null;
        while (Date.now() - t0 < 45000) {
          const a = await askApp(path);
          if (a.node && a.node !== target && a.status > 0 && a.status < 500) {
            first = a;
            break;
          }
          if ((a.node === target && a.attempts > 1) || a.status === 0 || a.status >= 500) fallback = a;
          steps[2].detail = 'Still waiting… ' + Math.round((Date.now() - t0) / 1000) + ' s';
          draw();
          await wait(1000);
        }
        if (!first) {
          const why = fallback
            ? fallback.node === target
              ? 'no other server could answer, so the router had to use ' + target + ' anyway'
              : 'requests failed (' + (fallback.status || 'no answer') + ') while ' + target + ' was paused'
            : 'the router kept using ' + target + '; other router copies may not have heard about the pause yet';
          set(2, 'bad', why + '.');
          text = 'Failover did not work: ' + why + '. Check now shows what is wrong with the other servers.';
          return;
        }
        const took = Date.now() - t0;
        set(2, 'ok', first.node + ' answered ' + (took < 1000 ? 'right away' : 'after ' + (took / 1000).toFixed(1) + ' s') + ' (' + first.ms + ' ms).');

        set(3, 'run');
        const during = [first];
        while (during.length < 6) during.push(await askApp(path));
        const good = during.filter((a) => a.status > 0 && a.status < 500 && a.node !== target);
        const by = [...new Set(good.map((a) => a.node))];
        set(3, good.length === during.length ? 'ok' : 'bad', good.length + ' of ' + during.length + ' answered by ' + (by.length ? listWords(by) : 'no other server') + ' (avg ' + avgMs(good) + ' ms).');
        ok = good.length === during.length;
        text = ok
          ? 'Failover works. If ' + target + ' goes down, your visitors are moved to ' + listWords(by) + ' without errors.'
          : 'Failover only partly worked: ' + (during.length - good.length) + ' of ' + during.length + ' requests were not answered by another server.';
      } finally {
        set(4, 'run');
        const r = await apiPost('/_omnimesh/actions/resume', { pool: pool.prefix, node: target }).catch(() => ({ ok: false }));
        set(4, r.ok ? 'ok' : 'bad', r.ok ? target + ' gets traffic again.' : 'Could not resume ' + target + '; the pause ends by itself within 60 s.');
        finish(ok, text);
      }
    });
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
    $('foot-uptime').textContent = 'Router copy up ' + duration(s.instance.uptimeSeconds);
    const list = needsAttention(s);
    const alertBtn = $('alerts');
    alertBtn.hidden = !list.length;
    if (list.length) {
      clear(alertBtn);
      alertBtn.className = 'alert-chip ' + (list.some((t) => t.state === 'bad') ? 'bad' : 'warn');
      append(alertBtn, [icon('alert', 14), h('span', { text: String(list.length) }), h('span', { class: 'alert-text', text: list.length === 1 ? ' thing needs you' : ' things need you' })]);
      alertBtn.title = list.length + (list.length === 1 ? ' thing needs your attention' : ' things need your attention');
    }
  }

  function renderPage() {
    const page = PAGES[state.route];
    $('page-title').textContent = page.title;
    $('page-sub').textContent = page.sub;
    document.title = page.title + ' · OmniMesh';
    updateChrome();
    const view = clear($('view'));
    state.lastRender = Date.now();
    if (!state.status) {
      view.appendChild(h('div', { class: 'card empty', text: 'Loading live data…' }));
      return;
    }
    page.render(view, state.status);
  }

  function routeFromHash() {
    const raw = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    const key = ROUTE_ALIASES[raw] || raw;
    return PAGES[key] ? key : 'overview';
  }

  function onRoute() {
    state.route = routeFromHash();
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
              renderPage();
            },
            () => {}
          );
        }
        // Pages with inputs are only redrawn when first shown, so typing is never interrupted
        // Redraw only when something changed, so buttons stay clickable and nothing flickers
        const signature = JSON.stringify(Object.assign({}, data, { timestamp: 0, instance: 0 }));
        const changed = signature !== state.lastSignature;
        state.lastSignature = signature;
        // "2 min ago" texts go stale, so redraw at least every 30 s even when nothing changed
        const stale = Date.now() - state.lastRender > 30000;
        if (first || ((changed || stale) && !PAGES[state.route].keepsInput)) renderPage();
        else updateChrome();
        // First visit and nothing known yet: ask every server once, so the owner sees a real answer
        if (!state.autoChecked && !data.checks.lastAt && allNodes(data).every((n) => n.state === 'unknown')) {
          state.autoChecked = true;
          checkNow();
        }
        state.autoChecked = true;
        schedule(document.hidden ? POLL_MS * 5 : POLL_MS);
      })
      .catch((err) => {
        if (err.unauthorized) {
          signOut('That sign-in key was not accepted. Copy it again from OMNIMESH_STATUS_TOKEN in your .env, or run omnimesh open.');
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
    state.autoChecked = false;
    state.lastAction = '';
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
    $('help').appendChild(icon('help', 17));
    $('help').addEventListener('click', openGlossary);
    $('menu').addEventListener('click', openSidebar);
    $('scrim').addEventListener('click', closeSidebar);
    $('theme').addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      setTheme(dark ? 'light' : 'dark');
    });
    $('signout').addEventListener('click', () => signOut());
    $('alerts').addEventListener('click', () => (location.hash = '#/setup'));
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

    // `omnimesh open` and `omnimesh up` link here with #token=<key>: the fragment never reaches the
    // server; keep it for this tab and remove it from the address bar and history straight away
    const linkToken = new URLSearchParams(location.hash.replace(/^#\/?/, '')).get('token');
    if (linkToken) {
      setItem('session', TOKEN_KEY, linkToken);
      history.replaceState(null, '', location.pathname + '#/overview');
    }

    state.route = routeFromHash();
    state.token = linkToken || getItem('session', TOKEN_KEY);
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
