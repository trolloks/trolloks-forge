// A GraphQL document parser: the executable subset gh and github-mcp-server send. Operations (query and
// mutation, named or anonymous), variable definitions with defaults, fields with aliases and arguments,
// inline fragments, fragment definitions and spreads. Literals: ints, floats, strings (with escapes and block
// strings), booleans, null, enum names, lists and input objects. Commas are insignificant; # starts a comment.

export class GraphQLSyntaxError extends Error {}

export type Value =
  | { readonly kind: 'Variable'; readonly name: string }
  | { readonly kind: 'Scalar'; readonly value: string | number | boolean | null }
  | { readonly kind: 'Enum'; readonly value: string }
  | { readonly kind: 'List'; readonly values: Value[] }
  | { readonly kind: 'Object'; readonly fields: Record<string, Value> };

export interface TypeNode {
  readonly name?: string;
  readonly list?: TypeNode;
  readonly nonNull: boolean;
}

export interface Argument {
  readonly name: string;
  readonly value: Value;
}

export interface FieldSelection {
  readonly kind: 'Field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Argument[];
  readonly selection: Selection[];
  readonly line: number;
}

export interface InlineFragment {
  readonly kind: 'InlineFragment';
  readonly typeCondition: string | null;
  readonly selection: Selection[];
}

export interface FragmentSpread {
  readonly kind: 'FragmentSpread';
  readonly name: string;
}

export type Selection = FieldSelection | InlineFragment | FragmentSpread;

export interface VariableDefinition {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: Value | null;
}

export interface Operation {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: VariableDefinition[];
  readonly selection: Selection[];
}

export interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: Selection[];
}

export interface Document {
  readonly operations: Operation[];
  readonly fragments: Map<string, FragmentDefinition>;
}

// ---------------------------------------------------------------- lexer

type Token =
  | { readonly kind: 'punct'; readonly value: string; readonly line: number }
  | { readonly kind: 'name'; readonly value: string; readonly line: number }
  | { readonly kind: 'int'; readonly value: number; readonly line: number }
  | { readonly kind: 'float'; readonly value: number; readonly line: number }
  | { readonly kind: 'string'; readonly value: string; readonly line: number }
  | { readonly kind: 'eof'; readonly value: ''; readonly line: number };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '\n') {
      line += 1;
      pos += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...', line });
      pos += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', pos)) {
        const end = source.indexOf('"""', pos + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        const raw = source.slice(pos + 3, end);
        line += raw.split('\n').length - 1;
        tokens.push({ kind: 'string', value: blockStringValue(raw), line });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      for (;;) {
        if (pos >= source.length || source[pos] === '\n') throw new GraphQLSyntaxError('unterminated string');
        const c = source[pos];
        if (c === '"') {
          pos += 1;
          break;
        }
        if (c === '\\') {
          const esc = source[pos + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
            value += String.fromCharCode(parseInt(hex, 16));
            pos += 6;
            continue;
          }
          if (!(esc in map)) throw new GraphQLSyntaxError('bad escape in string');
          value += map[esc];
          pos += 2;
          continue;
        }
        value += c;
        pos += 1;
      }
      tokens.push({ kind: 'string', value, line });
      continue;
    }
    const numberMatch = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(pos, pos + 64));
    if (numberMatch && (ch === '-' || (ch >= '0' && ch <= '9'))) {
      const text = numberMatch[0];
      pos += text.length;
      if (numberMatch[2] || numberMatch[3]) tokens.push({ kind: 'float', value: Number(text), line });
      else tokens.push({ kind: 'int', value: Number(text), line });
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(pos, pos + 256));
    if (nameMatch) {
      tokens.push({ kind: 'name', value: nameMatch[0], line });
      pos += nameMatch[0].length;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)} on line ${line}`);
  }
  tokens.push({ kind: 'eof', value: '', line });
  return tokens;
}

function blockStringValue(raw: string): string {
  const lines = raw.split('\n');
  let indent = Infinity;
  for (const line of lines.slice(1)) {
    const lead = line.length - line.trimStart().length;
    if (line.trim() !== '' && lead < indent) indent = lead;
  }
  const cleaned = lines.map((line, index) => (index === 0 || indent === Infinity ? line : line.slice(Math.min(indent, line.length))));
  return cleaned.join('\n').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}

// ---------------------------------------------------------------- parser

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token.kind !== 'eof') this.pos += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private isName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw this.error(`expected "${value}"`);
    this.next();
  }

  private error(message: string): GraphQLSyntaxError {
    const token = this.peek();
    const found = token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value);
    return new GraphQLSyntaxError(`Syntax Error: ${message}, found ${found} (line ${token.line})`);
  }

  private name(): string {
    const token = this.peek();
    if (token.kind !== 'name') throw this.error('expected a name');
    this.next();
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.selectionSet() });
      } else if (this.isName('query') || this.isName('mutation')) {
        operations.push(this.operation());
      } else if (this.isName('fragment')) {
        const fragment = this.fragment();
        if (fragments.has(fragment.name)) throw new GraphQLSyntaxError(`There can be only one fragment named "${fragment.name}".`);
        fragments.set(fragment.name, fragment);
      } else if (this.isName('subscription')) {
        throw new GraphQLSyntaxError('subscriptions are not supported');
      } else {
        throw this.error('expected an operation or fragment');
      }
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('the document holds no operation');
    return { operations, fragments };
  }

  private operation(): Operation {
    const operation = this.name() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.name();
    const variables: VariableDefinition[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.name();
        this.expectPunct(':');
        const type = this.typeNode();
        let defaultValue: Value | null = null;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.value(true);
        }
        variables.push({ name: varName, type, defaultValue });
      }
      this.next();
    }
    return { operation, name, variables, selection: this.selectionSet() };
  }

  private fragment(): FragmentDefinition {
    this.name();
    const name = this.name();
    if (name === 'on') throw this.error('a fragment cannot be named on');
    if (!this.isName('on')) throw this.error('expected "on"');
    this.next();
    const typeCondition = this.name();
    return { name, typeCondition, selection: this.selectionSet() };
  }

  private typeNode(): TypeNode {
    let node: TypeNode;
    if (this.isPunct('[')) {
      this.next();
      const inner = this.typeNode();
      this.expectPunct(']');
      node = { list: inner, nonNull: false };
    } else {
      node = { name: this.name(), nonNull: false };
    }
    if (this.isPunct('!')) {
      this.next();
      node = { ...node, nonNull: true };
    }
    return node;
  }

  private selectionSet(): Selection[] {
    this.expectPunct('{');
    const selection: Selection[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw this.error('expected "}"');
      selection.push(this.selection());
    }
    this.next();
    if (selection.length === 0) throw this.error('a selection set cannot be empty');
    return selection;
  }

  private selection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on') || this.isPunct('{')) {
        let typeCondition: string | null = null;
        if (this.isName('on')) {
          this.next();
          typeCondition = this.name();
        }
        return { kind: 'InlineFragment', typeCondition, selection: this.selectionSet() };
      }
      return { kind: 'FragmentSpread', name: this.name() };
    }
    const line = this.peek().line;
    let alias: string | null = null;
    let name = this.name();
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.name();
    }
    const args = this.isPunct('(') ? this.argumentList() : [];
    const selection = this.isPunct('{') ? this.selectionSet() : [];
    return { kind: 'Field', alias, name, args, selection, line };
  }

  private argumentList(): Argument[] {
    this.expectPunct('(');
    const args: Argument[] = [];
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw this.error('expected ")"');
      const name = this.name();
      this.expectPunct(':');
      args.push({ name, value: this.value(false) });
    }
    this.next();
    return args;
  }

  private value(constant: boolean): Value {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      if (constant) throw this.error('variables are not allowed here');
      this.next();
      return { kind: 'Variable', name: this.name() };
    }
    if (token.kind === 'int' || token.kind === 'float') {
      this.next();
      return { kind: 'Scalar', value: token.value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'Scalar', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'Scalar', value: true };
      if (token.value === 'false') return { kind: 'Scalar', value: false };
      if (token.value === 'null') return { kind: 'Scalar', value: null };
      return { kind: 'Enum', value: token.value };
    }
    if (this.isPunct('[')) {
      this.next();
      const values: Value[] = [];
      while (!this.isPunct(']')) {
        if (this.peek().kind === 'eof') throw this.error('expected "]"');
        values.push(this.value(constant));
      }
      this.next();
      return { kind: 'List', values };
    }
    if (this.isPunct('{')) {
      this.next();
      const fields: Record<string, Value> = {};
      while (!this.isPunct('}')) {
        if (this.peek().kind === 'eof') throw this.error('expected "}"');
        const name = this.name();
        this.expectPunct(':');
        fields[name] = this.value(constant);
      }
      this.next();
      return { kind: 'Object', fields };
    }
    throw this.error('expected a value');
  }
}

/** Parse a document, or throw GraphQLSyntaxError with a GitHub-style message. */
export function parseDocument(source: string): Document {
  if (source.length > 256 * 1024) throw new GraphQLSyntaxError('the document is too large');
  return new Parser(lex(source)).parseDocument();
}
