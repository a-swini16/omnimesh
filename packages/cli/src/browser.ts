import { spawn } from 'node:child_process';

/** Open a URL in the default browser without going through a shell. Returns false if no browser could be started. */
export function openBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}
