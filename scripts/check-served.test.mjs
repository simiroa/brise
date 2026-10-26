import { describe, it, expect } from 'vitest';
import { isEmptyServed, hasRuntimeModuleSyntax } from './check-served.mjs';

describe('isEmptyServed', () => {
  it('blank and sourcemap-only are empty', () => {
    expect(isEmptyServed('')).toBe(true);
    expect(isEmptyServed('\n//# sourceMappingURL=data:application/json;base64,AAA\n')).toBe(true);
  });
  it('real code is not empty', () => {
    expect(isEmptyServed('export const a = 1;')).toBe(false);
  });
});

describe('hasRuntimeModuleSyntax', () => {
  it('runtime exports', () => {
    expect(hasRuntimeModuleSyntax('export const a = 1;')).toBe(true);
    expect(hasRuntimeModuleSyntax('export default function f() {}')).toBe(true);
    expect(hasRuntimeModuleSyntax('const a=1;\nexport { a };')).toBe(true);
    expect(hasRuntimeModuleSyntax("import './x.css';")).toBe(true);
  });
  it('type-only files are excluded', () => {
    expect(hasRuntimeModuleSyntax('export interface A { x: 1 }\nexport type B = A;')).toBe(false);
    expect(hasRuntimeModuleSyntax('export type { A } from "./a";\nimport type { B } from "./b";')).toBe(false);
    expect(hasRuntimeModuleSyntax('// export const a = 1;\n/* export const b */')).toBe(false);
  });
});
