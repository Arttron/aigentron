import { describe, expect, it } from 'vitest';
import { McpInputError, describeMcpServer, normalizeMcpConfig, parseMcpInput, shellWords } from './mcp-config';

const one = (text: string) => {
  const r = parseMcpInput(text);
  expect(r.servers).toHaveLength(1);
  return r.servers[0]!;
};

describe('a client file: { mcpServers: { name: { url, headers } } } (Claude Desktop, Cursor, LM Studio, .mcp.json)', () => {
  const arttron = `{
    "mcpServers": {
      "arttron": {
        "url": "https://arttron.dev/api/mcp",
        "headers": { "Authorization": "Bearer abc123" }
      }
    }
  }`;
  it('takes the name from the key and adds the type the format leaves out', () => {
    const r = parseMcpInput(arttron);
    expect(r.servers).toEqual([{ name: 'arttron', config: { url: 'https://arttron.dev/api/mcp', type: 'http', headers: { Authorization: 'Bearer abc123' } } }]);
    expect(r.notes).toContain('type added: http');
  });
  it('several servers, and VS Code’s "servers" key', () => {
    const r = parseMcpInput('{"servers":{"a":{"url":"https://a.example/mcp"},"b":{"command":"npx","args":["-y","pkg"]}}}');
    expect(r.servers.map((s) => s.name)).toEqual(['a', 'b']);
    expect(r.servers[1]!.config).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
  });
  it('a /sse address is an SSE server; streamable-http and transport spellings are understood', () => {
    expect(one('{"url":"https://x.example/sse"}').config.type).toBe('sse');
    expect(one('{"url":"https://x.example/mcp","type":"streamable-http"}').config.type).toBe('http');
    expect(one('{"serverUrl":"https://x.example/mcp"}').config).toEqual({ url: 'https://x.example/mcp', type: 'http' });
    expect(one('{"httpUrl":"https://x.example/mcp","transport":"http"}').config).toEqual({ url: 'https://x.example/mcp', type: 'http' });
  });
  it('drops client settings the SDK has no use for, keeps readOnlyTools / trustAnnotations', () => {
    const c = one('{"command":"npx","args":["x"],"disabled":false,"autoApprove":["a"],"timeout":60,"readOnlyTools":["*"],"trustAnnotations":true}').config;
    expect(c).toEqual({ command: 'npx', args: ['x'], readOnlyTools: ['*'], trustAnnotations: true });
  });
  it('tolerates a trailing comma from copied documentation', () => {
    expect(one('{"url":"https://x.example/mcp",}').config.url).toBe('https://x.example/mcp');
  });
  it('a bare { name: { … } } map', () => {
    expect(parseMcpInput('{"arttron":{"url":"https://a.example/mcp"}}').servers[0]).toMatchObject({ name: 'arttron' });
  });
});

describe('one server, a URL', () => {
  it('a bare config', () => {
    expect(one('{"url":"https://a.example/mcp","headers":{"X-Key":"k"}}')).toEqual({ config: { url: 'https://a.example/mcp', type: 'http', headers: { 'X-Key': 'k' } } });
  });
  it('a bare URL', () => {
    expect(one('https://a.example/sse').config).toEqual({ url: 'https://a.example/sse', type: 'sse' });
  });
});

describe('claude mcp add …', () => {
  it('--transport http name url --header', () => {
    const s = one('claude mcp add --transport http arttron https://arttron.dev/api/mcp --header "Authorization: Bearer abc123"');
    expect(s).toEqual({ name: 'arttron', config: { type: 'http', url: 'https://arttron.dev/api/mcp', headers: { Authorization: 'Bearer abc123' } } });
  });
  it('options in any order, = form, line continuations', () => {
    const s = one('claude mcp add arttron --transport=sse \\\n  --header=X-Key:k https://a.example/sse --scope user');
    expect(s.config).toEqual({ type: 'sse', url: 'https://a.example/sse', headers: { 'X-Key': 'k' } });
  });
  it('a local program after --, with -e', () => {
    const s = one('claude mcp add github -e GITHUB_TOKEN=ghp_x -- npx -y @modelcontextprotocol/server-github');
    expect(s).toEqual({ name: 'github', config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } } });
  });
  it('no URL given: http by default', () => {
    expect(one('claude mcp add x https://a.example/mcp').config).toEqual({ url: 'https://a.example/mcp', type: 'http' });
  });
  it('add-json', () => {
    expect(one(`claude mcp add-json weather '{"type":"http","url":"https://w.example/mcp"}'`)).toEqual({ name: 'weather', config: { type: 'http', url: 'https://w.example/mcp' } });
  });
  it('says what is wrong', () => {
    expect(() => parseMcpInput('claude mcp add')).toThrow(/server name/);
    expect(() => parseMcpInput('claude mcp add x')).toThrow(/no URL or program/);
    expect(() => parseMcpInput('claude mcp add x --header nocolon https://a.example')).toThrow(/header/);
  });
});

describe('what is refused, with a reason', () => {
  it.each([
    ['', /Paste/],
    ['hello', /not JSON/],
    ['[]', /JSON object/],
    ['{}', /Could not find a server/],
    ['{"mcpServers":{}}', /empty/],
    ['{"url":"ftp://x.example"}', /http/],
    ['{"url":"not a url"}', /valid URL/],
    ['{"type":"http"}', /Nothing to connect to/],
    ['{"command":"x","args":"a b"}', /list of strings/],
    ['{"command":"x","type":"http"}', /local program/],
    ['{"url":"https://a.example","headers":["x"]}', /headers/],
  ])('%s', (text, re) => {
    expect(() => parseMcpInput(text)).toThrow(McpInputError);
    expect(() => parseMcpInput(text)).toThrow(re);
  });
});

describe('review findings', () => {
  it('a trailing comma is dropped only outside strings (a header value keeps its comma and bracket)', () => {
    const s = one('{"url":"https://a.example/mcp","headers":{"X":"a, }","Y":"b,]"},}');
    expect(s.config.headers).toEqual({ X: 'a, }', Y: 'b,]' });
  });
  it('a Windows path in double quotes keeps its backslashes', () => {
    const s = one('claude mcp add x -- node "C:\\tools\\s.js"');
    expect(s.config.args).toEqual(['C:\\tools\\s.js']);
    expect(shellWords('a "C:\\x\\y" "q\\"r"')).toEqual(['a', 'C:\\x\\y', 'q"r']);
  });
  it('args must be strings; header / env values must be text, never [object Object]', () => {
    expect(() => parseMcpInput('{"command":"x","args":["a",1]}')).toThrow(/list of strings/);
    expect(() => parseMcpInput('{"url":"https://a.example","headers":{"X":{"a":1}}}')).toThrow(/header "X" must be text/);
    expect(() => parseMcpInput('{"command":"x","env":{"K":["v"]}}')).toThrow(/variable "K" must be text/);
    expect(one('{"command":"x","env":{"PORT":8080,"DEBUG":true}}').config.env).toEqual({ PORT: '8080', DEBUG: 'true' });
  });
  it('a server called __proto__ / constructor is refused', () => {
    expect(() => parseMcpInput('{"mcpServers":{"__proto__":{"url":"https://a.example"}}}')).toThrow(/cannot be used as a server name/);
    expect(() => parseMcpInput('{"constructor":{"url":"https://a.example"}}')).toThrow(/cannot be used/);
  });
});

describe('helpers', () => {
  it('shellWords handles quotes and escapes', () => {
    expect(shellWords(`a "b c" 'd e' f\\ g ""`)).toEqual(['a', 'b c', 'd e', 'f g', '']);
    expect(() => shellWords('a "b')).toThrow(/quote/);
  });
  it('normalize is idempotent', () => {
    const once = normalizeMcpConfig({ url: 'https://a.example/mcp' });
    expect(normalizeMcpConfig(once)).toEqual(once);
  });
  it('describes a server in one line, without showing header values', () => {
    expect(describeMcpServer({ name: 'arttron', config: { url: 'https://a.example/mcp', type: 'http', headers: { Authorization: 'Bearer secret' } } })).toBe('arttron — http · https://a.example/mcp · headers: Authorization');
    expect(describeMcpServer({ config: { command: 'npx', args: ['-y', 'p'] } })).toBe('stdio · npx -y p');
  });
});
