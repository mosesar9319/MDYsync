// Pulls one top-level declaration -- a `function name(...) { ... }` or a
// single-statement `const name = ...;` -- out of a script's source text, so a
// test can hold a copied function to its original character for character.
// Returned as written, indentation included; `dedent` undoes a nesting level.
export const dedent = (text, spaces) => text.split('\n').map((l) => (l.startsWith(' '.repeat(spaces)) ? l.slice(spaces) : l)).join('\n').trimStart();

export function extractDecl(source, name) {
  const fn = new RegExp(`^[ \\t]*(?:async )?function ${name}\\(`, 'm').exec(source);
  if (fn) {
    const open = source.indexOf('{', source.indexOf(')', fn.index));
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '"' || c === "'" || c === '`') { // a string: skip to its end
        const quote = c;
        for (i += 1; i < source.length && source[i] !== quote; i += 1) if (source[i] === '\\') i += 1;
      } else if (c === '/' && source[i + 1] === '/') { // a line comment
        i = source.indexOf('\n', i) - 1;
      } else if (c === '/' && source[i + 1] === '*') { // a block comment
        i = source.indexOf('*/', i) + 1;
      } else if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) break; }
    }
    return source.slice(fn.index, i + 1);
  }
  const constant = new RegExp(`^[ \\t]*const ${name} = [^\\n]*;`, 'm').exec(source);
  if (constant) return constant[0];
  throw new Error(`${name} not found`);
}
