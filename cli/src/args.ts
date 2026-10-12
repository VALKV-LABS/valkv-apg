/** Command-line parsing. No dependency: the grammar is small and fixed. */

/** An error whose message is for the person at the terminal. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

const SHORT: Record<string, string> = { f: "file", o: "output", w: "workspace", m: "message", y: "yes", h: "help" };
const BOOLEAN = new Set(["yes", "help", "version", "prune", "cascade", "online", "dry-run", "no-color"]);
const REPEATED = new Set(["file", "header"]);

export interface Args {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Parses `argv` (without the program name). Unknown flags are accepted here and checked by each command. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out.positional.push(arg);
      continue;
    }
    let name: string;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      value = eq < 0 ? undefined : arg.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      if (short.length !== 1 || !SHORT[short]) throw new CliError(`unknown option '${arg}'`);
      name = SHORT[short]!;
    }
    if (BOOLEAN.has(name)) {
      if (value !== undefined && value !== "true" && value !== "false") throw new CliError(`--${name} takes no value`);
      out.flags[name] = value !== "false";
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliError(`--${name} needs a value`);
    }
    if (REPEATED.has(name)) out.flags[name] = [...((out.flags[name] as string[] | undefined) ?? []), value];
    else out.flags[name] = value;
  }
  return out;
}

/** The value of a single-valued flag. */
export function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** The values of a repeatable flag. */
export function flags(args: Args, name: string): string[] {
  const v = args.flags[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

/** Fails when a flag is given that the command does not take. */
export function allow(args: Args, ...names: string[]): void {
  const known = new Set([...names, "url", "token", "context", "workspace", "output", "help", "no-color"]);
  for (const name of Object.keys(args.flags)) {
    if (!known.has(name)) throw new CliError(`unknown option '--${name}' for this command`);
  }
}
