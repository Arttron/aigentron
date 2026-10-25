/**
 * Reading the ways people write an MCP server down, so adding one does not depend on which client's format they copied:
 *
 *  - Claude Desktop / Cursor / LM Studio / Claude Code `.mcp.json`:  `{ "mcpServers": { "name": { "url": …, "headers": {…} } } }`
 *    (VS Code's `mcp.json` calls the map `servers`);
 *  - one server's own object:  `{ "url": … }`, `{ "type": "http", "url": … }`, `{ "command": "npx", "args": […] }`;
 *  - Claude Code's command line:  `claude mcp add --transport http name https://… --header "Authorization: Bearer …"`,
 *    `claude mcp add name -e KEY=v -- npx -y pkg`, `claude mcp add-json name '{…}'`;
 *  - a bare URL.
 *
 * What comes out is the config the Claude Agent SDK takes: `type` is filled in where the format leaves it out (a `url` is `http`, or `sse` when it
 * ends in `/sse`), client-specific spellings (`serverUrl`, `httpUrl`, `transport`, `streamable-http`) are mapped, fields the SDK has no use for
 * (`disabled`, `autoApprove`, …) are dropped. Pure, no I/O: the dashboard shows what it understood, the server applies the same rules again.
 */
export type McpServerConfig = Record<string, unknown>;

export interface ParsedMcpServer {
  /** The name the input gave it (the key of a `mcpServers` map, the argument of `claude mcp add`); undefined for a bare config / URL. */
  name?: string;
  config: McpServerConfig;
}

export interface ParsedMcpInput {
  servers: ParsedMcpServer[];
  /** What was changed or understood, in plain words ("type added: http"). */
  notes: string[];
}

export class McpInputError extends Error {}

/** Keys of a server object (any client) — used to tell a config from a map of configs. */
const CONFIG_KEYS = ['command', 'args', 'url', 'serverUrl', 'httpUrl', 'type', 'transport', 'env', 'headers', 'cwd'];
/** Client settings the SDK ignores; dropped so the stored config says only what matters. */
const NOISE_KEYS = ['disabled', 'autoApprove', 'alwaysAllow', 'timeout', 'description', 'icon', 'enabled', 'disabledTools', 'toolFilter', 'oauth'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeConfig = (v: unknown): v is Record<string, unknown> => isObj(v) && CONFIG_KEYS.some((k) => k in v);

function httpType(raw: unknown, url: string): 'http' | 'sse' {
  const t = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamablehttp' || t === 'streamable') return 'http';
  return /\/sse\/?(\?.*)?$/i.test(url) ? 'sse' : 'http';
}

/** A header / variable value: text, a number or a boolean (as people write them in JSON); an object or a list is a mistake, not `[object Object]`. */
function asText(v: unknown, what: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new McpInputError(`The ${what} must be text.`);
}

/** One server's object → the SDK's config (+ notes). Throws McpInputError when it is neither a URL server nor a command. */
export function normalizeMcpConfig(input: unknown, notes: string[] = []): McpServerConfig {
  if (!isObj(input)) throw new McpInputError('An MCP server config must be an object.');
  const c: McpServerConfig = { ...input };
  for (const k of NOISE_KEYS) {
    if (k === 'disabled' && c.disabled === true) notes.push('the input said "disabled": true — it is added anyway; switch it off by not giving it to an agent');
    delete c[k];
  }
  // client spellings of the address
  const url = [c.url, c.serverUrl, c.httpUrl].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  delete c.serverUrl;
  delete c.httpUrl;
  const transport = c.transport;
  delete c.transport;
  if (url) {
    const href = url.trim();
    // (no URL class in this package's environment: the shape is checked by hand)
    if (!/^https?:\/\/[^\s/?#]+\S*$/i.test(href)) {
      throw new McpInputError(/^[a-z][a-z0-9+.-]*:\/\//i.test(href) ? 'A remote MCP server URL must start with http:// or https://.' : `"${url}" is not a valid URL.`);
    }
    c.url = href;
    const type = httpType(c.type ?? transport, href);
    if (c.type !== type) notes.push(c.type === undefined && transport === undefined ? `type added: ${type}` : `type set to ${type}`);
    c.type = type;
    delete c.command;
    delete c.args;
  } else if (typeof c.command === 'string' && c.command.trim() !== '') {
    c.command = c.command.trim();
    if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((x) => typeof x !== 'string'))) throw new McpInputError('"args" must be a list of strings.');
    if (c.type !== undefined && c.type !== 'stdio') throw new McpInputError(`A server with a "command" is a local program (stdio), not "${String(c.type)}".`);
    delete c.url;
  } else {
    throw new McpInputError('Nothing to connect to: give a "url" (a remote server) or a "command" (a local program).');
  }
  if (c.headers !== undefined) {
    if (!isObj(c.headers)) throw new McpInputError('"headers" must be an object of header names and values.');
    c.headers = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, asText(v, `header "${k}"`)]));
  }
  if (c.env !== undefined) {
    if (!isObj(c.env)) throw new McpInputError('"env" must be an object of names and values.');
    c.env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, asText(v, `variable "${k}"`)]));
  }
  return c;
}

/** A server name from a file: not one that would land on the prototype of the objects the servers are kept in. */
function safeName(name: string): string {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new McpInputError(`"${name}" cannot be used as a server name.`);
  return name;
}

/** Removes a comma that is followed by `}` or `]`, leaving string contents alone. */
function stripTrailingCommas(src: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) out += src[++i];
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === ',' && /^\s*[}\]]/.test(src.slice(i + 1))) {
      // dropped
    } else out += ch;
  }
  return out;
}

/** Split a command line the way a shell would for our purposes: words, single / double quotes, backslash escapes. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i]; // inside double quotes only these four are escapes: a Windows path keeps its backslashes
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) throw new McpInputError('The command has an unclosed quote.');
  if (cur || has) out.push(cur);
  return out;
}

function fromClaudeCli(text: string, notes: string[]): ParsedMcpServer[] {
  // a pasted command may wrap lines with a trailing backslash
  const words = shellWords(text.replace(/\\\r?\n/g, ' '));
  const at = words.findIndex((w, i) => w === 'mcp' && (words[i + 1] === 'add' || words[i + 1] === 'add-json'));
  if (at < 0) throw new McpInputError('Not a "claude mcp add …" command.');
  const json = words[at + 1] === 'add-json';
  const rest = words.slice(at + 2);
  let transport: string | undefined;
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  const positional: string[] = [];
  let after: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w === '--') {
      after = rest.slice(i + 1);
      break;
    }
    const flag = (names: string[]): string | null => {
      for (const n of names) {
        if (w === n) return rest[++i] ?? '';
        if (w.startsWith(`${n}=`)) return w.slice(n.length + 1);
      }
      return null;
    };
    let v: string | null;
    if ((v = flag(['--transport', '-t'])) !== null) transport = v;
    else if ((v = flag(['--header', '-H'])) !== null) {
      const m = /^([^:=]+)[:=]\s*(.*)$/.exec(v);
      if (!m) throw new McpInputError(`Cannot read the header "${v}" (expected Name: value).`);
      headers[m[1]!.trim()] = m[2]!;
    } else if ((v = flag(['--env', '-e'])) !== null) {
      const m = /^([^=]+)=(.*)$/.exec(v);
      if (!m) throw new McpInputError(`Cannot read the variable "${v}" (expected NAME=value).`);
      env[m[1]!] = m[2]!;
    } else if ((v = flag(['--scope', '-s'])) !== null) notes.push(`"--scope ${v}" ignored (servers here are global)`);
    else if (w.startsWith('-') && w.length > 1) notes.push(`option "${w}" ignored`);
    else positional.push(w);
  }
  const name = positional[0];
  if (!name) throw new McpInputError('The command has no server name (claude mcp add <name> …).');
  if (json) {
    const raw = positional.slice(1).join(' ');
    if (!raw) throw new McpInputError('claude mcp add-json needs the server JSON after the name.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new McpInputError('The JSON after the name is not valid JSON.');
    }
    return [{ name, config: normalizeMcpConfig(parsed, notes) }];
  }
  let config: McpServerConfig;
  if (after.length) {
    config = { type: 'stdio', command: after[0]!, ...(after.length > 1 ? { args: after.slice(1) } : {}) };
  } else if (positional[1]) {
    // `--transport` may be absent for a URL: http is the default there
    config = { ...(transport ? { type: transport } : {}), url: positional[1] };
  } else throw new McpInputError('The command has no URL or program to run (… <url>  or  … -- <command> <args>).');
  if (Object.keys(headers).length) config.headers = headers;
  if (Object.keys(env).length) config.env = env;
  return [{ name, config: normalizeMcpConfig(config, notes) }];
}

/** Anything a person pastes → the servers in it. Throws McpInputError with a message to show. */
export function parseMcpInput(text: string): ParsedMcpInput {
  const raw = text.trim();
  if (!raw) throw new McpInputError('Paste a server config, a "claude mcp add …" command or a URL.');
  const notes: string[] = [];

  if (/^(claude\s+)?mcp\s+add(-json)?\b/.test(raw) || /^claude\s+mcp\b/.test(raw)) return { servers: fromClaudeCli(raw, notes), notes };
  if (/^https?:\/\/\S+$/i.test(raw)) return { servers: [{ config: normalizeMcpConfig({ url: raw }, notes) }], notes };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      // tolerate what a copy from documentation brings along: a trailing comma — only when the text is not valid JSON as it stands, and never inside a string
      json = JSON.parse(stripTrailingCommas(raw));
    } catch {
      throw new McpInputError('This is not JSON, a "claude mcp add …" command or a URL.');
    }
  }
  if (!isObj(json)) throw new McpInputError('Expected a JSON object.');

  // a client's file: the map of servers under `mcpServers` / `servers` (possibly one level deeper, e.g. VS Code settings `mcp.servers`)
  const holder = [json.mcpServers, json.servers, isObj(json.mcp) ? json.mcp.servers : undefined].find(isObj);
  if (holder) {
    const servers = Object.entries(holder).map(([name, cfg]) => ({ name: safeName(name), config: normalizeMcpConfig(cfg, notes) }));
    if (!servers.length) throw new McpInputError('The "mcpServers" list is empty.');
    notes.unshift(`${servers.length} server${servers.length === 1 ? '' : 's'} found in "${'mcpServers' in json ? 'mcpServers' : 'servers'}"`);
    return { servers, notes };
  }
  // one server's own object
  if (looksLikeConfig(json)) return { servers: [{ config: normalizeMcpConfig(json, notes) }], notes };
  // a bare map { name: { …config… } }
  const entries = Object.entries(json);
  if (entries.length && entries.every(([, v]) => looksLikeConfig(v))) {
    return { servers: entries.map(([name, cfg]) => ({ name: safeName(name), config: normalizeMcpConfig(cfg, notes) })), notes };
  }
  throw new McpInputError('Could not find a server in this: expected "mcpServers", or an object with "url" or "command".');
}

/** A one-line description for the preview: "arttron — http · https://… · headers: Authorization". */
export function describeMcpServer(s: ParsedMcpServer): string {
  const c = s.config;
  const where = typeof c.url === 'string' ? `${String(c.type)} · ${c.url}` : `stdio · ${String(c.command)}${Array.isArray(c.args) ? ` ${c.args.join(' ')}` : ''}`;
  const hdr = isObj(c.headers) && Object.keys(c.headers).length ? ` · headers: ${Object.keys(c.headers).join(', ')}` : '';
  return `${s.name ? `${s.name} — ` : ''}${where}${hdr}`;
}
