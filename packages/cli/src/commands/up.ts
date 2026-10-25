import { openBrowser } from '../browser.js';
import pc from 'picocolors';
import { startWizard } from '../up/server.js';

export async function runUpCommand(options: { port?: number; open?: boolean; cwd?: string } = {}) {
  const cwd = options.cwd || process.cwd();
  let wizard;
  try {
    wizard = await startWizard({ cwd, port: options.port ?? 4747 });
  } catch {
    wizard = await startWizard({ cwd, port: 0 }); // preferred port busy: pick any free one
  }
  console.log(pc.bold(pc.cyan('\n🌐 OmniMesh: host your backend on multiple clouds\n')));
  console.log(`  Open this link to continue (it only works on this computer):\n`);
  console.log(`  ${pc.bold(pc.green(wizard.url))}\n`);
  console.log(pc.dim('  Keep this terminal open while you deploy. Press Ctrl+C to stop.\n'));
  if (options.open !== false) openBrowser(wizard.url);
  return wizard;
}
