import { setIpcTransport } from "./ipc.ts";

/** Everything a test needs to answer — or to inspect — one backend command. */
export type CommandReply = (args: Record<string, unknown> | undefined) => unknown;

export interface SentCommand {
  command: string;
  args?: Record<string, unknown>;
}

export interface TestBackend {
  /** Every command the code under test sent, in order. */
  readonly sent: SentCommand[];
  /** The payload of each call to `command`, in order. */
  argsFor(command: string): (Record<string, unknown> | undefined)[];
  /** Put the real backend (shell or demo fixtures) back. */
  restore(): void;
}

/**
 * Routes `ipc.*` to scripted replies so a test can drive real store actions and
 * render real components without the desktop shell or the demo fixtures.
 *
 * A command with no reply rejects instead of resolving to `undefined`: a test
 * that forgets to script something this way fails on the command, rather than
 * rendering an empty state that looks like a passing assertion.
 *
 * `replies` answers the synchronous case; a reply may also return a promise,
 * which stays as unsettled as the test decides. Cleanup belongs to the caller,
 * so a test can `t.after(backend.restore)` or wrap the body in try/finally.
 *
 *   const backend = installTestBackend({ list_connections: () => [profile] });
 *   await useWorkspace.getState().refreshConnections();
 *   assert.deepEqual(backend.argsFor("list_connections"), [undefined]);
 */
export function installTestBackend(replies: Record<string, CommandReply> = {}): TestBackend {
  const script = new Map(Object.entries(replies));
  const sent: SentCommand[] = [];

  /** Record the call, then replay what the test scripted for that command. */
  async function dispatch<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    sent.push({ command, args });
    const reply = script.get(command);
    if (!reply) throw new Error(`unscripted command: ${command}`);
    // The reply is deliberately untyped: what a command returns is exactly the
    // fact the test is asserting, so casting it here is the whole point.
    return reply(args) as T;
  }

  setIpcTransport(dispatch);

  return {
    sent,
    argsFor: (command) =>
      sent.filter((entry) => entry.command === command).map((entry) => entry.args),
    restore: () => setIpcTransport(null),
  };
}
