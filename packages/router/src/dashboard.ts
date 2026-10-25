/**
 * Operator dashboard served by the router at /_omnimesh/dashboard.
 * Self-contained (no external requests, so it works under a strict CSP). It holds no data itself:
 * it polls /_omnimesh/status with the status token the operator enters, and renders every value
 * with textContent so nothing from the API can inject markup.
 */
export function renderDashboard(nonce: string): string {
  return PAGE.split('__NONCE__').join(nonce);
}

// Note: the script below avoids backticks and template placeholders because it lives inside a TS template literal.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OmniMesh Dashboard</title>
<style nonce="__NONCE__">
:root {
  --bg: #0d1117; --panel: #151b23; --panel-2: #1b222c; --border: #2a3340; --text: #e6edf3; --muted: #8b98a8;
  --ok: #3fb950; --ok-bg: rgba(63,185,80,.14); --bad: #f85149; --bad-bg: rgba(248,81,73,.14);
  --warn: #d29922; --warn-bg: rgba(210,153,34,.16); --idle: #6e7681; --accent: #58a6ff; --bar: #263040;
  --radius: 10px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f6f8fa; --border: #d8dee4; --text: #1f2328; --muted: #59636e;
    --ok: #1a7f37; --ok-bg: #dafbe1; --bad: #cf222e; --bad-bg: #ffebe9; --warn: #9a6700; --warn-bg: #fff8c5;
    --idle: #818b98; --accent: #0969da; --bar: #e6eaef; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px 48px; }
header { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; flex-wrap: wrap; }
.mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), var(--ok)); flex: none; }
.brand { font-weight: 650; font-size: 16px; }
.domain { color: var(--muted); font-family: var(--mono); font-size: 13px; }
.spacer { flex: 1; }
.live { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-bg); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
button { font: inherit; color: var(--text); background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; width: 100%; padding: 10px; }
.hidden { display: none !important; }

.login { max-width: 400px; margin: 12vh auto 0; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 28px; }
.login h1 { font-size: 20px; margin: 14px 0 6px; }
.login p { color: var(--muted); margin: 0 0 18px; }
label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; }
input { width: 100%; font: inherit; font-family: var(--mono); color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.error { color: var(--bad); font-size: 13px; margin: -6px 0 12px; min-height: 1em; }
.hint { color: var(--muted); font-size: 12px; margin-top: 14px; }
code { font-family: var(--mono); font-size: 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

.banner { border-radius: var(--radius); padding: 10px 14px; margin-bottom: 10px; display: flex; gap: 10px; align-items: center; border: 1px solid transparent; }
.banner.bad { background: var(--bad-bg); color: var(--bad); border-color: var(--bad); }
.banner.warn { background: var(--warn-bg); color: var(--warn); border-color: var(--warn); }
.banner.info { background: var(--panel); color: var(--muted); border-color: var(--border); }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0 24px; }
.kpi { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.kpi .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.kpi .v { font-size: 26px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
.kpi .s { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

h2 { font-size: 15px; margin: 0; }
.section { margin-bottom: 24px; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }

.pool { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; overflow: hidden; }
.pool-head { display: flex; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.pool-head .prefix { font-family: var(--mono); font-weight: 600; }
.row { display: grid; grid-template-columns: minmax(150px, 1.3fr) 110px 80px 80px 80px minmax(170px, 1.5fr); gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: 0; }
.row.head { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; padding-top: 8px; padding-bottom: 8px; background: var(--panel-2); }
.num { font-variant-numeric: tabular-nums; }
.node { display: flex; gap: 10px; align-items: center; min-width: 0; }
.node-name { font-weight: 600; }
.node-url { color: var(--muted); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-text { min-width: 0; }
.pill { display: inline-block; font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.ok { color: var(--ok); background: var(--ok-bg); }
.pill.bad { color: var(--bad); background: var(--bad-bg); }
.pill.idle { color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); }
.reason { color: var(--bad); font-size: 11px; font-family: var(--mono); }
.quota-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.bar { height: 6px; background: var(--bar); border-radius: 999px; overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--ok); border-radius: 999px; }
.bar > span.warn { background: var(--warn); }
.bar > span.bad { background: var(--bad); }
.muted { color: var(--muted); }

.events { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.event { display: flex; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); align-items: baseline; }
.event:last-child { border-bottom: 0; }
.event .when { color: var(--muted); font-size: 12px; width: 76px; flex: none; font-variant-numeric: tabular-nums; }
.event .what { flex: 1; min-width: 0; }
.event .count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.empty { padding: 18px 16px; color: var(--muted); }
footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); padding-top: 14px; margin-top: 8px; }

@media (max-width: 760px) {
  .row.head { display: none; }
  .row { grid-template-columns: 1fr 1fr; }
  .row > :first-child, .row > :last-child { grid-column: 1 / -1; }
  .cell-label { display: inline; color: var(--muted); font-size: 11px; margin-right: 6px; }
}
@media (min-width: 761px) { .cell-label { display: none; } }
</style>
</head>
<body>
<div class="wrap">
  <section id="login" class="login hidden" aria-labelledby="login-title">
    <div class="mark" aria-hidden="true"></div>
    <h1 id="login-title">OmniMesh operator sign-in</h1>
    <p>Enter the router's status token to see live node health, failovers and quotas.</p>
    <form id="login-form" autocomplete="off">
      <label for="token">Status token</label>
      <input id="token" type="password" required minlength="16" spellcheck="false" autocomplete="off">
      <div id="login-error" class="error" role="alert"></div>
      <button class="primary" type="submit">Connect</button>
    </form>
    <p class="hint">The token is <code>OMNIMESH_STATUS_TOKEN</code> on the router (<code>npx wrangler secret put OMNIMESH_STATUS_TOKEN</code>). It stays in this browser tab only.</p>
  </section>

  <main id="app" class="hidden">
    <header>
      <div class="mark" aria-hidden="true"></div>
      <div>
        <div class="brand">OmniMesh</div>
        <div id="domain" class="domain"></div>
      </div>
      <div class="spacer"></div>
      <span class="live" aria-live="polite"><span id="live-dot" class="dot"></span><span id="live-text">Connecting…</span></span>
      <button id="signout" type="button">Sign out</button>
    </header>

    <div id="banners"></div>

    <div class="kpis">
      <div class="kpi"><div class="k">Requests</div><div id="k-requests" class="v">–</div><div id="k-requests-s" class="s"></div></div>
      <div class="kpi"><div class="k">Success rate</div><div id="k-success" class="v">–</div><div id="k-success-s" class="s"></div></div>
      <div class="kpi"><div class="k">Failovers</div><div id="k-failovers" class="v">–</div><div class="s">served by a backup node</div></div>
      <div class="kpi"><div class="k">Latency p95</div><div id="k-p95" class="v">–</div><div id="k-p95-s" class="s"></div></div>
      <div class="kpi"><div class="k">Nodes up</div><div id="k-nodes" class="v">–</div><div id="k-nodes-s" class="s"></div></div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Pools and nodes</h2><span id="strategy" class="tag"></span></div>
      <div id="pools"></div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Recent events</h2><span class="tag">newest first</span></div>
      <div id="events" class="events"></div>
    </div>

    <footer>
      Numbers come from the router instance that answered this page; on Cloudflare each instance counts on its own, while node health is shared through KV.
      The Workers Free plan allows 100,000 requests per day across all instances.
    </footer>
  </main>
</div>

<script nonce="__NONCE__">
(function () {
  'use strict';
  var KEY = 'omnimesh.statusToken';
  var POLL_MS = 3000;
  var token = null;
  var timer = null;
  var failures = 0;
  var lastOk = 0;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function store(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function load() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function ms(n) { if (n === null || n === undefined) return '–'; return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms'; }
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function uptime(s) {
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function showLogin(message) {
    stop();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('login-error').textContent = message || '';
    $('token').value = '';
    $('token').focus();
  }
  function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } }
  function schedule(delay) { stop(); timer = setTimeout(poll, delay); }

  function setLive(state, text) {
    $('live-dot').className = 'dot ' + state;
    $('live-text').textContent = text;
  }

  function poll() {
    fetch('/_omnimesh/status', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (res) {
        if (res.status === 404 || res.status === 401) {
          store(null);
          showLogin('That token was not accepted. Check OMNIMESH_STATUS_TOKEN on the router.');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        failures = 0;
        lastOk = Date.now();
        showApp();
        render(data);
        setLive('ok', 'Live · updated just now');
        schedule(POLL_MS);
      })
      .catch(function () {
        failures += 1;
        var wait = Math.min(30000, POLL_MS * Math.pow(2, failures));
        setLive('bad', 'Router unreachable · retrying in ' + Math.round(wait / 1000) + 's' + (lastOk ? ' · last data ' + ago(lastOk) : ''));
        schedule(wait);
      });
  }

  function render(d) {
    $('domain').textContent = (d.domain || '') + ' · instance up ' + uptime(d.instance.uptimeSeconds);
    var t = d.totals;
    $('k-requests').textContent = fmt(t.requests);
    $('k-requests-s').textContent = fmt(t.rateLimited) + ' rate-limited · ' + fmt(t.rejected) + ' rejected';
    var rate = t.requests ? (t.succeeded / t.requests) * 100 : 100;
    $('k-success').textContent = (t.requests ? rate.toFixed(rate >= 99.95 || rate < 10 ? 1 : 2) : '–') + (t.requests ? '%' : '');
    $('k-success-s').textContent = fmt(t.failed) + ' failed';
    $('k-failovers').textContent = fmt(t.failovers);
    $('k-p95').textContent = ms(d.latency.samples ? d.latency.p95 : null);
    $('k-p95-s').textContent = d.latency.samples ? 'p50 ' + ms(d.latency.p50) + ' · p99 ' + ms(d.latency.p99) : 'no requests yet';
    $('strategy').textContent = (d.routerConfig.strategy === 'weighted' ? 'weighted load balancing' : 'priority failover') +
      ' · timeout ' + ms(d.routerConfig.timeoutMs) + ' · budget ' + ms(d.routerConfig.totalBudgetMs);

    var total = 0, up = 0, serving = 0, alerts = [];
    d.pools.forEach(function (p) {
      p.nodes.forEach(function (n) {
        total += 1;
        if (n.state === 'healthy') serving += 1;
        if (n.state === 'down') {
          alerts.push({ cls: 'bad', text: n.label + ' is down in ' + p.prefix + (n.failureReason ? ' (' + n.failureReason + ')' : '') + '. Traffic is going to the other nodes.' });
        } else {
          up += 1;
        }
        if (n.quota && n.quota.percentUsed >= 95) {
          alerts.push({ cls: 'warn', text: n.label + ' reached its free quota (' + n.quota.percentUsed + '%). Traffic moved to the next free tier.' });
        } else if (n.quota && n.quota.percentUsed >= 80) {
          alerts.push({ cls: 'warn', text: n.label + ' has used ' + n.quota.percentUsed + '% of its free quota. Traffic moves to the next node at 95%.' });
        }
      });
    });
    $('k-nodes').textContent = up + ' / ' + total;
    $('k-nodes-s').textContent = (total - up ? (total - up) + ' down · ' : '') + serving + ' serving · ' + (up - serving) + ' on standby';

    var banners = $('banners');
    clear(banners);
    alerts.forEach(function (a) {
      var b = el('div', 'banner ' + a.cls);
      b.setAttribute('role', 'status');
      b.appendChild(el('span', 'dot ' + a.cls));
      b.appendChild(el('span', null, a.text));
      banners.appendChild(b);
    });

    renderPools(d.pools);
    renderEvents(d.events);
  }

  function cell(label, value, cls) {
    var c = el('div', cls || 'num');
    c.appendChild(el('span', 'cell-label', label));
    c.appendChild(document.createTextNode(value));
    return c;
  }

  function renderPools(pools) {
    var root = $('pools');
    clear(root);
    pools.forEach(function (p) {
      var card = el('div', 'pool');
      var head = el('div', 'pool-head');
      head.appendChild(el('span', 'prefix', p.prefix));
      if (p.isDefault) head.appendChild(el('span', 'tag', 'default pool'));
      var up = p.nodes.filter(function (n) { return n.state !== 'down'; }).length;
      head.appendChild(el('span', 'muted', up + ' of ' + p.nodes.length + ' nodes healthy'));
      card.appendChild(head);

      var h = el('div', 'row head');
      ['Node', 'Status', 'Role', 'Latency', 'Errors', 'Free-tier quota'].forEach(function (x) { h.appendChild(el('div', null, x)); });
      card.appendChild(h);

      p.nodes.forEach(function (n) {
        var row = el('div', 'row');
        var node = el('div', 'node');
        var state = n.state === 'down' ? 'bad' : n.quota && n.quota.percentUsed >= 95 ? 'warn' : n.state === 'healthy' ? 'ok' : '';
        node.appendChild(el('span', 'dot ' + state));
        var txt = el('div', 'node-text');
        txt.appendChild(el('div', 'node-name', n.label));
        var u = el('div', 'node-url', n.url);
        u.title = n.url;
        txt.appendChild(u);
        if (n.failureReason) txt.appendChild(el('div', 'reason', n.failureReason));
        node.appendChild(txt);
        row.appendChild(node);

        var status = el('div');
        var full = n.quota && n.quota.percentUsed >= 95;
        var pill = n.state === 'down' ? ['bad', 'Down'] : full ? ['warn', 'Quota reached'] : n.state === 'healthy' ? ['ok', 'Serving'] : ['idle', 'Standby'];
        status.appendChild(el('span', 'pill ' + pill[0], pill[1]));
        row.appendChild(status);
        row.appendChild(cell('Role', n.isBackup ? 'Backup' : 'Primary' + (n.weight > 1 ? ' ×' + n.weight : ''), 'muted'));
        row.appendChild(cell('Latency', ms(n.latencyMs)));
        var errRate = n.requests ? Math.round((n.errors / n.requests) * 100) : 0;
        row.appendChild(cell('Errors', fmt(n.errors) + (n.requests ? ' (' + errRate + '%)' : '')));

        var q = el('div');
        if (n.quota) {
          var limit = n.quota.requestsPerDay || n.quota.requestsPerMonth;
          var used = n.quota.requestsPerDay ? n.quota.usedToday : n.quota.usedThisMonth;
          var lbl = el('div', 'quota-label');
          lbl.appendChild(el('span', null, fmt(used) + ' / ' + fmt(limit) + (n.quota.requestsPerDay ? ' per day' : ' per month')));
          lbl.appendChild(el('span', null, n.quota.percentUsed + '%'));
          q.appendChild(lbl);
          var bar = el('div', 'bar');
          var fill = el('span', n.quota.percentUsed >= 95 ? 'bad' : n.quota.percentUsed >= 80 ? 'warn' : '');
          fill.style.width = Math.min(100, n.quota.percentUsed) + '%';
          bar.appendChild(fill);
          q.appendChild(bar);
        } else {
          q.appendChild(el('span', 'muted', 'No request quota (limited by hours or bandwidth)'));
        }
        row.appendChild(q);
        card.appendChild(row);
      });
      root.appendChild(card);
    });
  }

  var LABELS = {
    node_down: function (e) { return e.node + ' went down in ' + e.pool + (e.detail ? ': ' + e.detail : ''); },
    node_up: function (e) { return e.node + ' recovered in ' + e.pool; },
    failover: function (e) { return 'Failover: ' + e.node + ' answered for ' + e.pool + (e.detail ? ' (' + e.detail + ')' : ''); },
    outage: function (e) { return 'No node could answer in ' + e.pool + '; clients got a clean 503'; },
    quota_limit: function (e) { return e.node + ' reached 95% of its free quota in ' + e.pool + '; traffic moved to the next free tier'; }
  };
  var DOTS = { node_down: 'bad', node_up: 'ok', failover: 'warn', outage: 'bad', quota_limit: 'warn' };

  function renderEvents(events) {
    var root = $('events');
    clear(root);
    if (!events.length) {
      root.appendChild(el('div', 'empty', 'No incidents on this router instance. Failovers and outages will appear here.'));
      return;
    }
    events.forEach(function (e) {
      var row = el('div', 'event');
      row.appendChild(el('span', 'when', ago(e.at)));
      row.appendChild(el('span', 'dot ' + (DOTS[e.kind] || '')));
      row.appendChild(el('span', 'what', (LABELS[e.kind] || function () { return e.kind; })(e)));
      if (e.count > 1) row.appendChild(el('span', 'count', '×' + fmt(e.count)));
      root.appendChild(row);
    });
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    token = $('token').value.trim();
    if (!token) return;
    store(token);
    $('login-error').textContent = '';
    setLive('', 'Connecting…');
    poll();
  });
  $('signout').addEventListener('click', function () { store(null); token = null; showLogin(''); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && token) poll(); });

  token = load();
  if (token) { showApp(); poll(); } else { showLogin(''); }
})();
</script>
</body>
</html>`;
