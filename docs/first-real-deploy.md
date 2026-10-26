# Your first real deploy, step by step

This takes about 30 minutes the first time, mostly creating accounts. Every step uses your own accounts; nothing here costs money.

## 0. What you need

- A computer with Node.js 22 or newer, pnpm and git.
- Your backend in a **public** GitHub repo. It must listen on the `PORT` environment variable (for example `app.listen(process.env.PORT)`). Node.js, Python and Docker apps are detected automatically.
- Recommended: add `gatewayAuth()` from `@omnimesh/node` to your app, so it only accepts requests that come through your router. Without it the dashboard shows "Not locked".

Get the OmniMesh command (it is not on npm yet):

```bash
git clone https://github.com/a-swini16/omnimesh.git ~/omnimesh && cd ~/omnimesh && pnpm install
```

```bash
alias omnimesh="node $HOME/omnimesh/packages/cli/bin/omnimesh.js"
```

## 1. Create the accounts and keys

Answer one question first: **do you have a credit or debit card?**

| You need | No card | With a card |
| :--- | :---: | :---: |
| Cloudflare (runs the router) | ✔ | ✔ |
| Koyeb | ✔ | ✔ (optional) |
| Render | ✔ | ✔ (optional) |
| Oracle Always Free (+ a domain on Cloudflare) | | ✔ |
| GitHub token (only for the watcher) | optional | optional |

**Cloudflare**
1. Sign up at cloudflare.com. Open **Workers & Pages** once and choose your `workers.dev` name.
2. My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers**.
3. With Oracle only: before creating it, add **Account → Cloudflare Tunnel → Edit**, **Zone → Zone → Read** and **Zone → DNS → Edit**. Your domain must already be on Cloudflare (free plan).

**Koyeb**: sign up (GitHub login works) → Settings → API → Create API token.

**Render**: sign up → Account Settings → API Keys → Create API Key.

**Oracle (card only)**
1. Sign up at oracle.com/cloud/free. Oracle asks for a card to verify you and says it is not charged unless you upgrade your account. Choose your **home region** carefully: Always Free servers run only there.
2. Console → Profile menu (top right) → **User settings** → **API Keys** → **Add API Key** → **Download Private Key** → **Add**.
3. Keep the **Configuration File Preview** text and the downloaded `.pem` file. You paste both on the setup page.

**GitHub (for the watcher)**: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Repository access: only your backend repo. Permissions: **Contents**, **Workflows** and **Secrets**, each "Read and write".

## 2. Deploy

Make an empty folder for this deployment. Your keys are saved here (in `.env` and `.omnimesh/`, readable only by you), never in your backend repo.

```bash
mkdir -p ~/my-api-mesh && cd ~/my-api-mesh
```

```bash
omnimesh up
```

The setup page opens on your computer only. Fill it in:

1. **Your backend**: the GitHub link.
2. **Card**: "No card" or "Yes, I have a card".
3. **Connect your clouds**: paste each key. With a card, Oracle is first. Paste its Configuration File Preview, choose the `.pem` file, and type a server name under your Cloudflare domain, for example `oracle.yourdomain.com`.
4. **Keep it running**: leave **Keep my servers awake** on (free Koyeb and Render servers sleep otherwise). Tick **Add the GitHub watcher** if you made the GitHub token.
5. Press **Deploy my backend** and keep the page open: 3 to 10 minutes, and up to 15 with Oracle.

When it finishes you get **one URL** for your app and a button to the dashboard.

## 3. Test failover for real

In the same folder:

```bash
omnimesh chaos
```

It pauses the server that is answering (for at most 60 seconds), sends real requests to your app, tells you which cloud took over and how fast, and puts the server back. If failover would not work, it says why and does not pause anything that would take your app offline.

## 4. The dashboard

```bash
omnimesh open
```

It opens already signed in. You will see:
- **The headline**: "Your app is up", "…but render is not answering", or "Your app is down", with the reason.
- **Needs your attention**: things to fix, each with how to fix it (for example "Not locked").
- **Check now**: asks every server right away. **Test failover**: the same test as `omnimesh chaos`, in the browser.
- **Servers**: one card per cloud, with **Pause 60 s** and **Resume now**.
- **Activity**, **Traffic**, **Free limits**, **Checklist** (this shows whether automatic checks and the GitHub watcher are running).

## 5. Shipping new code

Push to GitHub, then run:

```bash
omnimesh deploy
```

The Oracle server also pulls new commits by itself every 5 minutes.

## When something goes wrong

- **"Oracle: no free Arm capacity"**: common on Always Free. Your other clouds are deployed; run `omnimesh up` again later to add Oracle.
- **"workers.dev subdomain"**: open Workers & Pages in Cloudflare once, choose a name, deploy again.
- **"is not under a domain in your Cloudflare account"**: the Oracle server name must be under a domain already on Cloudflare.
- **Watcher "stopped"**: GitHub turns off scheduled workflows in public repos after 60 days without commits. Open your repo → Actions → OmniMesh watcher → Enable workflow.
- **Oracle server stopped**: Oracle can stop Always Free servers that stay almost idle for 7 days. The watcher starts it again.
