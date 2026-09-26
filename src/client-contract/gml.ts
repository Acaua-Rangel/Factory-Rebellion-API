import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

// The GameMaker project sits next to the API repository. These helpers read
// its source so the specs can check it. There is no GML runtime here: what is
// checked is the source, and only tiny pure pieces of it are actually executed.
export const GAME_DIR = path.resolve(
  __dirname,
  '../../../Factory Rebellion Game',
);

export function gml(relativePath: string): string {
  const file = path.join(GAME_DIR, relativePath);
  if (!existsSync(file)) {
    // deliberately not a skip: a skipped test is not proof
    throw new Error(
      `the GameMaker project is not next to the API repository (looked for ${file})`,
    );
  }
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// The text of `function name(...) { ... }`, braces balanced.
export function gmlFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`function ${name} not found`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is not closed`);
}

// GameMaker built-ins the checked snippets use.
const shims = {
  clamp: (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
  round: (v: number) => Math.round(v),
  min: Math.min,
  max: Math.max,
};

// Runs a tiny, pure GML function (numbers in, a number out, built-ins above
// only) and returns it as a JavaScript function.
export function pureGmlFunction(
  source: string,
  name: string,
): (...args: number[]) => number {
  const text = gmlFunction(source, name);
  const params = /function\s+\w+\(([^)]*)\)/.exec(text)![1];
  const body = text
    .slice(text.indexOf('{') + 1, text.lastIndexOf('}'))
    .replace(/\bvar\b/g, 'let');
  return new Function(
    ...Object.keys(shims),
    `return function (${params}) {${body}};`,
  )(...Object.values(shims));
}

// Runs a few lines of GML statements that only assign numbers to `global.x`
// and `var` locals, given some starting values. Returns `global`.
export function runGmlLines(
  lines: string[],
  inputs: Record<string, number>,
): Record<string, number> {
  const global: Record<string, number> = {};
  const names = Object.keys(inputs);
  const body = lines.join('\n').replace(/\bvar\b/g, 'let');
  new Function('global', ...Object.keys(shims), ...names, body)(
    global,
    ...Object.values(shims),
    ...Object.values(inputs),
  );
  return global;
}
