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
      role: 'Hosts your backend (512 MB; sleeps after 1 hour idle, wakes in seconds)',
      link: 'https://app.koyeb.com/user/settings/api',
      steps: ['Sign up free at koyeb.com (GitHub login works).', 'Open Settings → API → "Create API token".', 'Copy the token and paste it here.'],
    },
    {
      id: 'render',
      name: 'Render',
      color: '#4c6fff',
      role: 'Hosts your backend (512 MB; sleeps after 15 min idle, wakes in about a minute)',
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
      cardSteps: ['For Oracle, add three permissions to this token before creating it: Account → Cloudflare Tunnel → Edit, Zone → Zone → Read, Zone → DNS → Edit.'],
    },
    {
      id: 'oracle',
      name: 'Oracle',
      color: '#c74634',
      needsCard: true,
      role: 'Always Free Arm server: 2 CPUs, 12 GB RAM, always on (the strongest free server)',
      link: 'https://www.oracle.com/cloud/free/',
      steps: [
        'Sign up at oracle.com/cloud/free (a card is needed to verify you). Choose your home region carefully: Always Free servers run only there.',
        'In the Oracle Console: Profile menu (top right) → User settings → API Keys → Add API Key → Download Private Key → Add.',
        'Copy the "Configuration File Preview" it shows and paste it below, then choose the private key file you downloaded.',
        'Pick a server name under a domain you have on Cloudflare, for example oracle.yourdomain.com. OmniMesh connects it through a private Cloudflare Tunnel, so the server opens no ports.',
      ],
    },
  ];
  let hasCard = false;

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

  /** Oracle needs three things instead of one token: the config preview, the private key file and a server name. */
  function oracleFields(saved) {
    const keyText = el('textarea', { id: 'oci-key', spellcheck: false, placeholder: saved.oracle ? 'Saved on this computer. Choose a file or paste to replace it.' : '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----', style: { minHeight: '80px' } });
    const file = el('input', {
      type: 'file',
      accept: '.pem,.key,.txt',
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) f.text().then((t) => (keyText.value = t.trim()));
      },
    });
    return [
      el('label', { for: 'oci-config', text: 'Configuration File Preview' }),
      el('textarea', { id: 'oci-config', spellcheck: false, placeholder: saved.oracle ? 'Saved on this computer. Paste a new one to replace it.' : '[DEFAULT]\nuser=ocid1.user.oc1..…\nfingerprint=…\ntenancy=ocid1.tenancy.oc1..…\nregion=…' }),
      el('label', { for: 'oci-key', text: 'Private key (.pem)' }),
      el('div', { class: 'file-row' }, file, el('span', { text: 'or paste it:' })),
      keyText,
      el('label', { for: 'oci-host', text: 'Server name on your Cloudflare domain' }),
      el('input', { id: 'oci-host', autocomplete: 'off', spellcheck: false, value: saved.oracleHostname || '', placeholder: 'oracle.yourdomain.com' }),
    ];
  }

  function renderProviders(saved) {
    const box = $('providers');
    box.replaceChildren();
    $('clouds-pill').textContent = hasCard ? 'all free; Oracle verifies with your card' : 'all free, no card';
    // With a card, Oracle (always on, the most capacity) comes first
    const list = hasCard ? PROVIDERS.filter((p) => p.needsCard).concat(PROVIDERS.filter((p) => !p.needsCard)) : PROVIDERS;
    for (const p of list) {
      if (p.needsCard && !hasCard) continue;
      const input = el('input', { id: 'tok-' + p.id, type: 'password', autocomplete: 'off', spellcheck: false, placeholder: saved[p.id] ? 'Saved on this computer. Paste a new one to replace it.' : 'Paste your ' + p.name + ' API token' });
      const steps = p.steps.concat(hasCard && p.cardSteps ? p.cardSteps : []);
      box.append(
        el('div', { class: 'provider' },
          el('div', { class: 'provider-top' },
            el('div', { class: 'tile', text: p.name.slice(0, 2).toUpperCase(), style: { background: p.color } }),
            el('div', null, el('div', { class: 'provider-name', text: p.name }), el('div', { class: 'provider-role', text: p.role })),
            el('span', { class: 'spacer' }),
            saved[p.id] ? el('span', { class: 'badge saved', text: 'Connected ✓' }) : p.required ? el('span', { class: 'badge required', text: 'Required' }) : p.needsCard ? el('span', { class: 'badge card', text: 'Card needed' }) : null,
            el('a', { href: p.link, target: '_blank', rel: 'noopener noreferrer', text: p.id === 'oracle' ? 'Sign up ↗' : 'Get token ↗' })
          ),
          el('ol', { class: 'howto' }, steps.map((s) => el('li', { text: s }))),
          p.id === 'oracle' ? oracleFields(saved) : [el('label', { for: input.id, text: p.name + ' API token' }), input]
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
  function checkForm(repo, tokens, oracle, watcher) {
    if (!repo) return ['Paste the GitHub link of your backend first.', 'repo'];
    if (!/github\.com\/[\w.-]+\/[\w.-]+|^[\w.-]+\/[\w.-]+$/.test(repo)) return ['That does not look like a GitHub repository link. Example: https://github.com/you/your-backend', 'repo'];
    if (!tokens.cloudflare && !savedTokens.cloudflare) return ['Paste your Cloudflare token. Cloudflare runs the router that gives your app one URL.', 'tok-cloudflare'];
    const oracleStarted = oracle && (oracle.config || oracle.privateKey || oracle.hostname);
    if (oracleStarted && !savedTokens.oracle && (!oracle.config || !oracle.privateKey)) return ['For Oracle, paste the Configuration File Preview and the private key, or clear the Oracle fields to skip it.', oracle.config ? 'oci-key' : 'oci-config'];
    if (oracleStarted && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(oracle.hostname)) return ['For Oracle, enter a server name under your Cloudflare domain, like oracle.yourdomain.com.', 'oci-host'];
    const hosts = [tokens.koyeb || savedTokens.koyeb, tokens.render || savedTokens.render, oracleStarted || (hasCard && savedTokens.oracle)].filter(Boolean).length;
    if (!hosts) return [hasCard ? 'Connect Oracle, Koyeb or Render so there is a cloud to host your backend (two or more is best).' : 'Paste a Koyeb or Render token so there is a cloud to host your backend (both is best).', 'tok-koyeb'];
    if (watcher && !tokens.github && !savedTokens.github) return ['Paste a GitHub token for the watcher, or untick "Add the GitHub watcher".', 'tok-github'];
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
    hasCard = Boolean(savedTokens.oracle);
    for (const r of document.querySelectorAll('input[name="card"]')) {
      r.checked = r.value === (hasCard ? 'yes' : 'no');
      r.addEventListener('change', () => {
        hasCard = r.value === 'yes' && r.checked;
        renderProviders(savedTokens);
      });
    }
    $('watcher').addEventListener('change', () => ($('github-box').hidden = !$('watcher').checked));
    if (state.settings) {
      $('keep-awake').checked = state.settings.keepAwake !== false;
      $('watcher').checked = Boolean(state.settings.watcher);
      $('github-box').hidden = !$('watcher').checked;
    }
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
      for (const p of PROVIDERS) if (!p.needsCard) tokens[p.id] = $('tok-' + p.id).value.trim();
      const watcher = $('watcher').checked;
      tokens.github = watcher ? $('tok-github').value.trim() : '';
      const oracle = hasCard ? { config: $('oci-config').value.trim(), privateKey: $('oci-key').value.trim(), hostname: $('oci-host').value.trim().toLowerCase() } : null;
      const problem = checkForm($('repo').value.trim(), tokens, oracle, watcher);
      if (problem) return showError(problem[0], problem[1]);
      startDeploy({
        repoUrl: $('repo').value.trim(),
        branch: $('branch').value.trim(),
        startCommand: $('start').value.trim(),
        tokens,
        oracle: hasCard ? oracle : null,
        keepAwake: $('keep-awake').checked,
        watcher,
        remember: $('remember').checked,
      });
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
