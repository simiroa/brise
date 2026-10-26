import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import {
  handleMessage,
  validateToolArguments,
  createCallTool,
  runStdioServer,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  META_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_SERVER_INFO,
  INSTRUCTIONS,
} from './mcp.mjs';

// 2026-07-28: 모든 요청이 _meta 에 버전·클라이언트 capability 를 싣는다.
const META = { [META_PROTOCOL_VERSION]: PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {} };
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } });
const SERVER_META = { [META_SERVER_INFO]: { name: 'brise', version: '0.5.0' } };

describe('MCP Server - handleMessage (2026-07-28)', () => {
  const mockTools = [
    {
      name: 'note_create',
      description: '새 노트를 만든다.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: '폴더 id' },
          title: { type: 'string', description: '제목' },
          count: { type: 'integer', description: '개수' },
          score: { type: 'number', description: '점수' },
          active: { type: 'boolean', description: '활성 여부' },
          tags: { type: 'array', description: '태그 목록' },
          meta: { type: 'object', description: '메타데이터' },
        },
        required: ['folder_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'workspace_list',
      description: '노트북 목록을 조회한다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  const deps = (callTool = vi.fn()) => ({ tools: mockTools, callTool, version: '0.5.0' });

  it('server/discover returns supported versions, tools capability, instructions and serverInfo', async () => {
    const res = await handleMessage(req('d1', 'server/discover'), deps());
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'd1',
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        _meta: SERVER_META,
      },
    });
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2026-07-28']);
  });

  it('rejects legacy initialize with -32022 naming the supported versions', async () => {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
      deps()
    );
    expect(res.error.code).toBe(-32022);
    expect(res.error.data).toEqual({ supported: ['2026-07-28'], requested: '2025-11-25' });
    expect(res.error.message).toMatch(/2026-07-28/);
  });

  it('rejects requests without the required _meta fields with -32602, before touching tools', async () => {
    const callTool = vi.fn();
    const noMeta = await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_list', arguments: {} } },
      deps(callTool)
    );
    expect(noMeta.error.code).toBe(-32602);
    expect(noMeta.error.message).toMatch(/protocolVersion/);

    const noCaps = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' } } },
      deps(callTool)
    );
    expect(noCaps.error.code).toBe(-32602);
    expect(noCaps.error.message).toMatch(/clientCapabilities/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects an unsupported per-request version with -32022 and the supported list', async () => {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { ...META, [META_PROTOCOL_VERSION]: '2025-11-25' } } },
      deps()
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: -32022,
        message: expect.stringMatching(/2026-07-28/),
        data: { supported: ['2026-07-28'], requested: '2025-11-25' },
      },
    });
  });

  it('does not respond to notifications, and rejects a null request id', async () => {
    const note = await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, deps());
    expect(note).toBeNull();
    const nullId = await handleMessage({ jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: META } }, deps());
    expect(nullId).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must not be null' } });
  });

  it('responds to ping with a complete result', async () => {
    expect(await handleMessage(req(42, 'ping'), deps())).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { resultType: 'complete', _meta: SERVER_META },
    });
  });

  it('returns the registry verbatim on tools/list', async () => {
    expect(await handleMessage(req(10, 'tools/list'), deps())).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: { resultType: 'complete', tools: mockTools, _meta: SERVER_META },
    });
  });

  it('returns -32602 and does not call callTool when the tool is not in the registry', async () => {
    const callTool = vi.fn();
    const res = await handleMessage(req('req-1', 'tools/call', { name: 'note_purge', arguments: {} }), deps(callTool));
    expect(callTool).not.toHaveBeenCalled();
    expect(res).toEqual({ jsonrpc: '2.0', id: 'req-1', error: { code: -32602, message: 'Unknown tool: "note_purge"' } });
  });

  it('validates arguments before the network call: non-object, unknown key, missing required, type mismatch', async () => {
    const callTool = vi.fn();
    const call = (id, args) => handleMessage(req(id, 'tools/call', { name: 'note_create', arguments: args }), deps(callTool));
    const cases = [
      [1, 'invalid-string', /Arguments must be a JSON object/],
      [2, { folder_id: 'f1', unknown_arg: 123 }, /Unknown argument: "unknown_arg"/],
      [3, { title: 'No folder' }, /Missing required argument: "folder_id"/],
      [4, { folder_id: 'f1', count: 'three' }, /Invalid type for argument "count": expected integer, got string/],
      [5, { folder_id: 'f1', active: 1 }, /Invalid type for argument "active": expected boolean, got number/],
    ];
    for (const [id, args, pattern] of cases) {
      const res = await call(id, args);
      expect(res.result.resultType).toBe('complete');
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(pattern);
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it('invokes callTool and returns the result as unindented JSON text', async () => {
    const callTool = vi.fn().mockResolvedValue({ id: 'note-123', title: 'Test Note' });
    const res = await handleMessage(
      req(100, 'tools/call', { name: 'note_create', arguments: { folder_id: 'f-1', title: 'Test Note' } }),
      deps(callTool)
    );
    expect(callTool).toHaveBeenCalledWith('note_create', { folder_id: 'f-1', title: 'Test Note' });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 100,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: '{"id":"note-123","title":"Test Note"}' }],
        isError: false,
        _meta: SERVER_META,
      },
    });
  });

  it('returns isError: true with the message when callTool throws', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('앱이 켜져 있고 설정 > 동기화가 켜져 있어야 한다'));
    const res = await handleMessage(req(101, 'tools/call', { name: 'workspace_list', arguments: {} }), deps(callTool));
    expect(res.result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: '앱이 켜져 있고 설정 > 동기화가 켜져 있어야 한다' }],
      isError: true,
      _meta: SERVER_META,
    });
  });

  it('returns -32601 for unknown methods', async () => {
    expect(await handleMessage(req(999, 'unknown/method'), deps())).toEqual({
      jsonrpc: '2.0',
      id: 999,
      error: { code: -32601, message: 'Method not found: unknown/method' },
    });
  });
});

describe('MCP Server - validateToolArguments', () => {
  it('lets null through for optional arguments (null clears, e.g. note_set_status.status)', () => {
    const tool = { inputSchema: { properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id'] } };
    expect(validateToolArguments(tool, { id: 'n1', status: null })).toBeNull();
    expect(validateToolArguments(tool, { id: null })).toMatch(/Missing required argument: "id"/);
  });
});

describe('MCP Server - Connection caching & retry (createCallTool)', () => {
  it('caches resolveConnection and does not re-resolve on consecutive successful calls', async () => {
    const resolveConnection = vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:7332',
      token: 'tok_1',
    });
    const invokeCommand = vi.fn().mockResolvedValue({ ok: true });

    const callTool = createCallTool({ resolveConnection, invokeCommand });

    const r1 = await callTool('workspace_list', {});
    const r2 = await callTool('workspace_list', {});

    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
  });

  it('invalidates cache and retries once on code === "network" error', async () => {
    let callCount = 0;
    const resolveConnection = vi.fn().mockImplementation(async () => {
      callCount++;
      return { url: `http://127.0.0.1:733${callCount}`, token: 'tok_1' };
    });

    const netErr = new Error('서버 연결 실패');
    netErr.code = 'network';

    const invokeCommand = vi
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ success: true });

    const callTool = createCallTool({ resolveConnection, invokeCommand });

    const result = await callTool('workspace_list', {});

    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true });
  });

  it('invalidates cache and retries once on code === "unauthorized" error', async () => {
    const resolveConnection = vi
      .fn()
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:7332', token: 'old_token' })
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:7332', token: 'new_token' });

    const unauthErr = new Error('unauthorized — 토큰이 앱의 sync_token 과 다르다');
    unauthErr.code = 'unauthorized';

    const invokeCommand = vi
      .fn()
      .mockRejectedValueOnce(unauthErr)
      .mockResolvedValueOnce({ success: true });

    const callTool = createCallTool({ resolveConnection, invokeCommand });

    const result = await callTool('workspace_list', {});

    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true });
  });

  it('does NOT retry on general errors (400, 500, business logic errors without code: network/unauthorized)', async () => {
    const resolveConnection = vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:7332',
      token: 'tok_1',
    });

    const businessErr = new Error('Note not found');
    const invokeCommand = vi.fn().mockRejectedValue(businessErr);

    const callTool = createCallTool({ resolveConnection, invokeCommand });

    await expect(callTool('note_get', { id: 'bad-id' })).rejects.toThrow('Note not found');
    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });
});

describe('MCP Server - runStdioServer stdio parsing', () => {
  it('handles line-by-line JSON-RPC: parse errors, notifications, empty lines and requests', async () => {
    const inputLines = [
      '{ invalid json }\n',
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}\n',
      JSON.stringify(req(1, 'ping')) + '\n',
      '',
    ];
    const input = Readable.from(inputLines);
    const outputChunks = [];
    const output = new Writable({
      write(chunk, encoding, callback) {
        outputChunks.push(chunk.toString());
        callback();
      },
    });

    await runStdioServer({ input, output, tools: [], callTool: vi.fn(), version: '0.5.0', exitOnClose: false });

    const outputLines = outputChunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(outputLines).toHaveLength(2);
    expect(outputLines[0]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(outputLines[1]).toEqual({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', _meta: SERVER_META } });
  });
});
