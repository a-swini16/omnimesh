// omnimesh up wizard. Talks only to this local server; values are rendered as text, never as HTML.
(function () {
  'use strict';

  // The one-time key arrives in the link; keep it for this tab only so a page refresh still works,
  // and take it out of the address bar, history and screenshots
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('key');
  let stored = null;
  try {
    if (fromLink) sessionStorage.setItem('omnimesh.wizardKey', fromLink);
    stored = sessionStorage.getItem('omnimesh.wizardKey');
  } catch (e) {
    /* storage blocked: the link still works until refresh */
  }
  const key = fromLink || stored;
  if (fromLink) history.replaceState(null, '', location.pathname);

  const PROVIDERS = [
    {
      id: 'koyeb',
      name: 'Koyeb',
      color: '#2fb5a8',
      role: 'Hosts your backend (always on)',
      link: 'https://app.koyeb.com/user/settings/api',
      steps: ['Sign up free at koyeb.com (GitHub login works).', 'Open Settings → API → "Create API token".', 'Copy the token and paste it here.'],
    },
    {
      id: 'render',
      name: 'Render',
      color: '#4c6fff',
      role: 'Hosts your backend (backup; sleeps after 15 min idle)',
      link: 'https://dashboard.render.com/u/settings#api-keys',
      steps: ['Sign up free at render.com.', 'Open Account Settings → API Keys → "Create API Key".', 'Copy the key and paste it here.'],
    },
    {
      id: 'cloudflare',
      name: 'Cloudflare',
      color: '#f38020',
      role: 'Runs the router: your one URL, failover and dashboard',
      required: true,
      link: 'https://dash.cloudflare.com/profile/api-tokens',
      steps: ['Sign up free at cloudflare.com, then open Workers & Pages once to choose your workers.dev name.', 'Open My Profile → API Tokens → "Create Token" → use the "Edit Cloudflare Workers" template.', 'Create it, copy the token and paste it here.'],
    },
  ];

  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = String(v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(e.style, v);
      else e[k] = v;
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return e;
  }

  async function api(path, init) {
    const res = await fetch(path, Object.assign({}, init, { headers: Object.assign({ 'X-OmniMesh-Key': key || '', 'Content-Type': 'application/json' }, (init || {}).headers) }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
    return body;
  }

  function copyButton(text, label) {
    return el('button', {
      class: 'btn',
      type: 'button',
      text: label || 'Copy',
      onclick: (e) => {
        navigator.clipboard.writeText(text).then(() => {
          e.target.textContent = 'Copied ✓';
          setTimeout(() => (e.target.textContent = label || 'Copy'), 1500);
        });
      },
    });
  }

  function renderProviders(saved) {
    const box = $('providers');
    box.replaceChildren();
    for (const p of PROVIDERS) {
      const input = el('input', { id: 'tok-' + p.id, type: 'password', autocomplete: 'off', spellcheck: false, placeholder: saved[p.id] ? 'Saved on this computer. Paste a new one to replace it.' : 'Paste your ' + p.name + ' API token' });
      box.append(
        el('div', { class: 'provider' },
          el('div', { class: 'provider-top' },
            el('div', { class: 'tile', text: p.name.slice(0, 2).toUpperCase(), style: { background: p.color } }),
            el('div', null, el('div', { class: 'provider-name', text: p.name }), el('div', { class: 'provider-role', text: p.role })),
            el('span', { class: 'spacer' }),
            saved[p.id] ? el('span', { class: 'badge saved', text: 'Connected ✓' }) : p.required ? el('span', { class: 'badge required', text: 'Required' }) : null,
            el('a', { href: p.link, target: '_blank', rel: 'noopener noreferrer', text: 'Get token ↗' })
          ),
          el('ol', { class: 'howto' }, p.steps.map((s) => el('li', { text: s }))),
          el('label', { for: input.id, text: p.name + ' API token' }),
          input
        )
      );
    }
  }

  function renderDone(info, fresh) {
    const box = $('done');
    const parts = [
      el('h2', { text: fresh ? '🎉 Your backend is live on ' + info.nodes.length + (info.nodes.length === 1 ? ' cloud' : ' clouds') : 'Your backend is deployed' }),
      el('p', { class: 'muted', text: 'Use this one URL everywhere (your frontend, mobile app, webhooks). OmniMesh sends each request to a healthy cloud.' }),
      el('div', { class: 'big-url' }, el('a', { href: info.appUrl, target: '_blank', rel: 'noopener noreferrer', text: info.appUrl }), copyButton(info.appUrl)),
      el('div', { class: 'rows' },
        info.nodes.map((n) => el('div', { class: 'row' }, el('span', { class: 'dot' }), el('strong', { text: n.provider }), el('span', { class: 'muted', text: n.url })))
      ),
      el('h3', { text: 'Manage it' }),
      el('p', { class: 'muted', text: 'Open the dashboard to watch traffic, failovers and free-tier usage. Sign in with your dashboard token:' }),
      el('div', { class: 'big-url' },
        el('code', { text: info.statusToken || 'see OMNIMESH_STATUS_TOKEN in .env' }),
        info.statusToken ? copyButton(info.statusToken, 'Copy token') : null
      ),
      info.warnings && info.warnings.length ? el('ul', { class: 'warn' }, info.warnings.map((w) => el('li', { text: w }))) : null,
      info.failed && info.failed.length ? el('ul', { class: 'warn' }, info.failed.map((f) => el('li', { text: f.error }))) : null,
      el('div', { class: 'actions' },
        el('a', { class: 'btn primary', href: info.dashboardUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open dashboard' }),
        el('button', { class: 'btn', type: 'button', text: 'Redeploy latest code', onclick: () => startDeploy({ repoUrl: info.repoUrl }) }),
        el('button', { class: 'btn', type: 'button', text: 'Change settings', onclick: () => { $('done').hidden = true; $('form').hidden = false; } }),
        fresh ? el('button', { class: 'btn', type: 'button', text: 'Show deploy log', onclick: () => { $('progress').hidden = !$('progress').hidden; } }) : null
      ),
    ];
    // replaceChildren() would print "null" for empty slots, so drop them first
    box.replaceChildren(...parts.filter(Boolean));
    box.hidden = false;
    if (fresh) {
      $('progress').hidden = true;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  let savedTokens = {};

  /** Show an error where the user is looking, and put the cursor on the field to fix. */
  function showError(message, focusId) {
    const box = $('form-error');
    box.textContent = message;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focusId) setTimeout(() => $(focusId).focus({ preventScroll: true }), 300);
  }

  /** Catch the common mistakes before anything is sent. */
  function checkForm(repo, tokens) {
    if (!repo) return ['Paste the GitHub link of your backend first.', 'repo'];
    if (!/github\.com\/[\w.-]+\/[\w.-]+|^[\w.-]+\/[\w.-]+$/.test(repo)) return ['That does not look like a GitHub repository link. Example: https://github.com/you/your-backend', 'repo'];
    if (!tokens.cloudflare && !savedTokens.cloudflare) return ['Paste your Cloudflare token. Cloudflare runs the router that gives your app one URL.', 'tok-cloudflare'];
    if (!tokens.koyeb && !savedTokens.koyeb && !tokens.render && !savedTokens.render) return ['Paste a Koyeb or Render token so there is a cloud to host your backend (both is best).', 'tok-koyeb'];
    return null;
  }

  let polling = null;
  async function startDeploy(payload) {
    $('form-error').textContent = '';
    try {
      await api('/api/deploy', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      $('form').hidden = false;
      showError(e.message);
      return;
    }
    $('form').hidden = true;
    $('done').hidden = true;
    $('already').hidden = true;
    $('progress').hidden = false;
    $('spinner').className = 'spinner';
    $('progress-title').textContent = 'Deploying… (keep this page open)';
    clearInterval(polling);
    polling = setInterval(poll, 1500);
    poll();
  }

  async function poll() {
    let job;
    try {
      job = await api('/api/progress');
    } catch (e) {
      return;
    }
    $('log').replaceChildren(...job.log.map((l) => el('li', { class: l.text.startsWith('✖') ? 'bad' : l.text.startsWith('✔') ? 'ok' : '', text: l.text })));
    $('log').scrollTop = $('log').scrollHeight;
    if (job.running) return;
    clearInterval(polling);
    $('spinner').className = 'spinner stop';
    if (job.error) {
      $('progress-title').textContent = 'Deploy stopped: fix the problem below and try again';
      $('form').hidden = false;
      showError(job.error);
    } else if (job.result) {
      $('progress-title').textContent = 'Done';
      const state = await api('/api/state');
      renderDone(Object.assign({}, job.result, { repoUrl: state.deployed && state.deployed.repoUrl }), true);
    }
  }

  async function init() {
    if (!key) {
      $('locked').hidden = false;
      return;
    }
    let state;
    try {
      state = await api('/api/state');
    } catch (e) {
      $('locked').hidden = false;
      return;
    }
    savedTokens = state.savedTokens || {};
    renderProviders(savedTokens);
    if (state.deployed) {
      $('repo').value = state.deployed.repoUrl;
      renderDone(Object.assign({ warnings: [] }, state.deployed), false);
    } else {
      $('form').hidden = false;
    }
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const tokens = {};
      for (const p of PROVIDERS) tokens[p.id] = $('tok-' + p.id).value.trim();
      const problem = checkForm($('repo').value.trim(), tokens);
      if (problem) return showError(problem[0], problem[1]);
      startDeploy({ repoUrl: $('repo').value.trim(), branch: $('branch').value.trim(), startCommand: $('start').value.trim(), tokens, remember: $('remember').checked });
    });
    // Resume the progress view if a deploy is already running (e.g. after a page reload)
    const job = await api('/api/progress').catch(() => null);
    if (job && job.running) {
      $('form').hidden = true;
      $('progress').hidden = false;
      polling = setInterval(poll, 1500);
    }
  }

  init();
})();
