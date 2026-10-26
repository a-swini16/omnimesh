/** One watcher run. Returns how many servers stayed down and could not be brought back. */
export function run(log?: (message: string) => void): Promise<{ failed: number; healed: string[] }>;
