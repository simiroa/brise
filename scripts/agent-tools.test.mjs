import { describe, it, expect } from 'vitest';
import { parseRustField, cliType, buildAgentTools, RUST_TYPE_OVERRIDES } from './agent-tools.mjs';

describe('parseRustField', () => {
  it('parses enums and omit default from literal union DSL', () => {
    const res = parseRustField('test_cmd', 'mode', "'or'|'and'|omit=or");
    expect(res.optional).toBe(true);
    expect(res.rust).toBe('String');
    expect(res.enumValues).toEqual(['or', 'and']);
    expect(res.omitDefault).toBe('or');
  });

  it('parses range annotations', () => {
    const res = parseRustField('test_cmd', 'month', 'integer(1..12)?');
    expect(res.optional).toBe(true);
    expect(res.rust).toBe('i64');
    expect(res.range).toEqual({ minimum: 1, maximum: 12 });
  });

  it('parses omit default without enum', () => {
    const res = parseRustField('test_cmd', 'title', 'string|omit=Untitled Note');
    expect(res.optional).toBe(true);
    expect(res.rust).toBe('String');
    expect(res.omitDefault).toBe('Untitled Note');
  });

  it('parses required primitive fields', () => {
    const res = parseRustField('test_cmd', 'id', 'uuid');
    expect(res.optional).toBe(false);
    expect(res.rust).toBe('String');
    expect(res.enumValues).toBeUndefined();
    expect(res.range).toBeUndefined();
    expect(res.omitDefault).toBeUndefined();
  });
});

describe('buildAgentTools validation rules (§3.2)', () => {
  it('Rule 1: throws when agent block is attached to an http: false command', () => {
    const commands = {
      workspace_duplicate: {
        http: false,
        input: { id: 'uuid', name: 'string' },
        agent: {
          kind: 'write',
          description: '노트북 복제',
        },
      },
    };
    expect(() => buildAgentTools(commands)).toThrow(/http:false/);
  });

  it('Rule 2: throws when kind is not read or write', () => {
    const commands = {
      note_purge: {
        input: { id: 'uuid' },
        agent: {
          kind: 'destructive',
          description: '노트 영구 삭제',
        },
      },
    };
    expect(() => buildAgentTools(commands)).toThrow(/must be 'read' or 'write'/);
  });

  it('Rule 3: throws when description is missing, empty, or whitespace', () => {
    const commandsEmpty = {
      note_get: {
        input: { id: 'uuid' },
        agent: {
          kind: 'read',
          description: '   ',
        },
      },
    };
    expect(() => buildAgentTools(commandsEmpty)).toThrow(/description is empty or missing/);

    const commandsMissing = {
      note_get: {
        input: { id: 'uuid' },
        agent: {
          kind: 'read',
        },
      },
    };
    expect(() => buildAgentTools(commandsMissing)).toThrow(/description is empty or missing/);
  });

  it('Rule 4: throws when args or hide contains keys not present in input', () => {
    const badArgs = {
      note_get: {
        input: { id: 'uuid' },
        agent: {
          kind: 'read',
          description: '노트 조회',
          args: { nonexistent: '설명' },
        },
      },
    };
    expect(() => buildAgentTools(badArgs)).toThrow(/args key "nonexistent" does not exist in input/);

    const badHide = {
      note_get: {
        input: { id: 'uuid' },
        agent: {
          kind: 'read',
          description: '노트 조회',
          hide: ['ghost_arg'],
        },
      },
    };
    expect(() => buildAgentTools(badHide)).toThrow(/hide key "ghost_arg" does not exist in input/);
  });

  it('Rule 5: throws when hide points to a required argument', () => {
    const hideRequired = {
      note_get: {
        input: { id: 'uuid' },
        agent: {
          kind: 'read',
          description: '노트 조회',
          hide: ['id'],
        },
      },
    };
    expect(() => buildAgentTools(hideRequired)).toThrow(/cannot hide required argument "id"/);
  });

  it('Rule 6: throws when json type argument is neither hidden nor described', () => {
    const jsonUndescribed = {
      note_query: {
        input: {
          region: 'json?',
        },
        agent: {
          kind: 'read',
          description: '노트 검색',
          // region is neither in hide nor in args
        },
      },
    };
    expect(() => buildAgentTools(jsonUndescribed)).toThrow(/json argument "region" in command "note_query" must be hidden/);
  });

  it('Rule 6 passes when json type argument is hidden (hide)', () => {
    const jsonHidden = {
      note_query: {
        input: {
          region: 'json?',
        },
        agent: {
          kind: 'read',
          description: '노트 검색',
          hide: ['region'],
        },
      },
    };
    const res = buildAgentTools(jsonHidden);
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0].inputSchema.properties.region).toBeUndefined();
  });

  it('Rule 6 passes when json type argument is described (args)', () => {
    const jsonDescribed = {
      note_query: {
        input: {
          region: 'json?',
        },
        agent: {
          kind: 'read',
          description: '노트 검색',
          args: {
            region: '지역 필터 JSON 객체',
          },
        },
      },
    };
    const res = buildAgentTools(jsonDescribed);
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0].inputSchema.properties.region).toBeDefined();
    expect(res.tools[0].inputSchema.properties.region.description).toBe('지역 필터 JSON 객체');
  });
});

describe('buildAgentTools feature mappings (§3.3, §3.4)', () => {
  it('correctly maps enumValues, range, and omitDefault', () => {
    const commands = {
      note_query: {
        input: {
          month: 'integer(1..12)?|omit=오늘(로컬) 월',
          tag_mode: "'or'|'and'|omit=or",
          title: 'string|omit=Untitled Note',
        },
        agent: {
          kind: 'read',
          description: '필터 쿼리',
          args: {
            month: '월 필터',
          },
        },
      },
    };
    const manifest = buildAgentTools(commands);
    const tool = manifest.tools[0];

    // Range + omitDefault combined with args description
    expect(tool.inputSchema.properties.month).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 12,
      description: '월 필터 (생략 시: 오늘(로컬) 월)',
    });

    // Enum + omitDefault without args description
    expect(tool.inputSchema.properties.tag_mode).toEqual({
      type: 'string',
      enum: ['or', 'and'],
      description: '(생략 시: or)',
    });

    // String + omitDefault without args description
    expect(tool.inputSchema.properties.title).toEqual({
      type: 'string',
      description: '(생략 시: Untitled Note)',
    });
  });

  it('maps MCP annotations for read and write tools', () => {
    const commands = {
      read_cmd: {
        input: {},
        agent: {
          kind: 'read',
          description: '읽기 도구',
        },
      },
      write_cmd: {
        input: {},
        agent: {
          kind: 'write',
          description: '쓰기 도구',
        },
      },
    };
    const manifest = buildAgentTools(commands);
    const readTool = manifest.tools.find(t => t.name === 'read_cmd');
    const writeTool = manifest.tools.find(t => t.name === 'write_cmd');

    expect(readTool.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(writeTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('sorts tools alphabetically by name and ignores commands without agent block', () => {
    const commands = {
      zebra_tool: {
        input: {},
        agent: { kind: 'read', description: 'Zebra' },
      },
      apple_tool: {
        input: {},
        agent: { kind: 'read', description: 'Apple' },
      },
      unexposed_tool: {
        input: {},
        // no agent block
      },
      banana_tool: {
        input: {},
        agent: { kind: 'read', description: 'Banana' },
      },
    };
    const manifest = buildAgentTools(commands);
    expect(manifest.tools.map(t => t.name)).toEqual(['apple_tool', 'banana_tool', 'zebra_tool']);
  });

  it('correctly maps array types and required properties', () => {
    const commands = {
      batch_tags: {
        input: {
          note_id: 'uuid',
          tags: 'string[]',
          optional_tags: 'string[]?',
        },
        agent: {
          kind: 'write',
          description: '태그 일괄 설정',
        },
      },
    };
    const manifest = buildAgentTools(commands);
    const tool = manifest.tools[0];

    expect(tool.inputSchema.required).toEqual(['note_id', 'tags']);
    expect(tool.inputSchema.properties.tags).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(tool.inputSchema.properties.optional_tags).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});
