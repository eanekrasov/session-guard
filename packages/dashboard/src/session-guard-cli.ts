export type SessionGuardCommand = (args: string[]) => Promise<unknown>;

export function createSessionGuardCommand(
  command = ['session-guard'],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): SessionGuardCommand {
  return async (args) => {
    const child = Bun.spawn([...command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `session-guard exited with code ${exitCode}`);
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `session-guard returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
