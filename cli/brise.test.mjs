import { describe, it, expect } from 'vitest';
import { parseArgs } from './brise.mjs';

describe('Brise CLI - parseArgs', () => {
  const mockManifest = {
    test_cmd: {
      group: 'test',
      doc: '테스트 커맨드',
      args: [
        { name: 'required_id', type: 'string', required: true },
        { name: 'optional_title', type: 'string', required: false },
        { name: 'year', type: 'integer', required: false },
        { name: 'score', type: 'number', required: false },
        { name: 'active', type: 'boolean', required: false },
        { name: 'tags', type: 'array', item: 'string', required: false },
        { name: 'nums', type: 'array', item: 'integer', required: false },
        { name: 'payload', type: 'json', required: false },
      ],
    },
  };

  it('throws on commands not in manifest (HTTP surface check)', () => {
    expect(() => {
      parseArgs('unknown_cmd', [], mockManifest);
    }).toThrow(/"unknown_cmd" 는 HTTP 표면 밖이다/);
  });

  it('throws when required argument is missing', () => {
    expect(() => {
      parseArgs('test_cmd', [], mockManifest);
    }).toThrow(/Missing required argument: --required_id/);
  });

  it('parses valid required and optional strings with --flag value and --flag=value', () => {
    const res1 = parseArgs('test_cmd', ['--required_id', 'id-123', '--optional_title', 'hello'], mockManifest);
    expect(res1).toEqual({
      required_id: 'id-123',
      optional_title: 'hello',
    });

    const res2 = parseArgs('test_cmd', ['--required_id=id-456', '--optional_title=world'], mockManifest);
    expect(res2).toEqual({
      required_id: 'id-456',
      optional_title: 'world',
    });
  });

  it('parses integer and number correctly', () => {
    const res = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--year', '2026', '--score', '98.5'],
      mockManifest
    );
    expect(res.year).toBe(2026);
    expect(typeof res.year).toBe('number');
    expect(res.score).toBe(98.5);
    expect(typeof res.score).toBe('number');
  });

  it('throws when integer or number is invalid', () => {
    expect(() => {
      parseArgs('test_cmd', ['--required_id', 'id-1', '--year', 'abc'], mockManifest);
    }).toThrow(/Invalid integer value for --year: "abc"/);

    expect(() => {
      parseArgs('test_cmd', ['--required_id', 'id-1', '--year', '2026.5'], mockManifest);
    }).toThrow(/Invalid integer value for --year: "2026.5"/);

    expect(() => {
      parseArgs('test_cmd', ['--required_id', 'id-1', '--score', 'xyz'], mockManifest);
    }).toThrow(/Invalid number value for --score: "xyz"/);
  });

  it('handles boolean flags: --flag, --flag=true/false, --flag true/false, --no-flag', () => {
    const r1 = parseArgs('test_cmd', ['--required_id', 'id-1', '--active'], mockManifest);
    expect(r1.active).toBe(true);

    const r2 = parseArgs('test_cmd', ['--required_id', 'id-1', '--active=false'], mockManifest);
    expect(r2.active).toBe(false);

    const r3 = parseArgs('test_cmd', ['--required_id', 'id-1', '--active', 'false'], mockManifest);
    expect(r3.active).toBe(false);

    const r4 = parseArgs('test_cmd', ['--required_id', 'id-1', '--no-active'], mockManifest);
    expect(r4.active).toBe(false);
  });

  it('handles array arguments: repeated flags and JSON array string', () => {
    const r1 = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--tags', 'alpha', '--tags', 'beta'],
      mockManifest
    );
    expect(r1.tags).toEqual(['alpha', 'beta']);

    const r2 = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--tags', '["gamma", "delta"]'],
      mockManifest
    );
    expect(r2.tags).toEqual(['gamma', 'delta']);

    const r3 = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--nums', '10', '--nums', '20'],
      mockManifest
    );
    expect(r3.nums).toEqual([10, 20]);
  });

  it('throws on unknown flags and includes allowed flags list in error message', () => {
    expect(() => {
      parseArgs('test_cmd', ['--required_id', 'id-1', '--unknown_flag', 'val'], mockManifest);
    }).toThrow(/Unknown flag: "--unknown_flag". Allowed flags for "test_cmd":.*--required_id.*--year/);
  });

  it('merges escape hatch --args JSON object', () => {
    const res = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--args', '{"optional_title": "merged", "year": 2027}'],
      mockManifest
    );
    expect(res).toEqual({
      required_id: 'id-1',
      optional_title: 'merged',
      year: 2027,
    });
  });

  it('supports "-" for stdin injection with stub function', () => {
    const mockStdin = () => '# Header\nThis is body from stdin';
    const res = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--optional_title', '-'],
      mockManifest,
      mockStdin
    );
    expect(res.optional_title).toBe('# Header\nThis is body from stdin');
  });

  it('parses json type argument', () => {
    const res = parseArgs(
      'test_cmd',
      ['--required_id', 'id-1', '--payload', '{"kind":"preset","id":"tokyo"}'],
      mockManifest
    );
    expect(res.payload).toEqual({ kind: 'preset', id: 'tokyo' });
  });
});
