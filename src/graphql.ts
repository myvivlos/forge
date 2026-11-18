import type { IncomingMessage, ServerResponse } from 'node:http';
import { MalformedJsonError, isAuthorized, readJsonBody, sendError, sendJson } from './http.ts';
import { ForgeStore, MethodNotAllowedError, UnprocessableError } from './store.ts';
import type { CommentRecord, IssueRecord, PullFileDiff, PullRecord, RepoRecord, UserRecord } from './types.ts';

// ---------------------------------------------------------------------------
// GraphQL AST & Parser (zero-dependency recursive descent)
// ---------------------------------------------------------------------------

interface SourceLoc {
  readonly line: number;
  readonly column: number;
}

type TokenKind =
  | 'EOF'
  | '!'
  | '$'
  | '&'
  | '('
  | ')'
  | '...'
  | ':'
  | '='
  | '@'
  | '['
  | ']'
  | '{'
  | '|'
  | '}'
  | 'Name'
  | 'Int'
  | 'Float'
  | 'String';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

class GraphQLSyntaxError extends Error {
  readonly loc: SourceLoc;

  constructor(message: string, loc: SourceLoc) {
    super(message);
    this.name = 'GraphQLSyntaxError';
    this.loc = loc;
  }
}

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function stripBlockStringIndentation(raw: string): string {
  const lines = raw.split(/\r\n|[\n\r]/);
  let commonIndent = Infinity;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    let indent = 0;
    while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) {
      indent += 1;
    }
    if (indent < line.length && indent < commonIndent) {
      commonIndent = indent;
    }
  }
  if (Number.isFinite(commonIndent) && commonIndent > 0) {
    for (let i = 1; i < lines.length; i += 1) {
      lines[i] = lines[i]!.slice(commonIndent);
    }
  }
  while (lines.length > 0 && /^[ \t]*$/.test(lines[0]!)) {
    lines.shift();
  }
  while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1]!)) {
    lines.pop();
  }
  return lines.join('\n');
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => pos - lineStart + 1;

  while (pos < source.length) {
    const ch = source[pos]!;

    // Whitespace, BOM, and insignificant commas
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\ufeff') {
      pos += 1;
      continue;
    }
    if (ch === '\r') {
      pos += 1;
      if (source[pos] === '\n') pos += 1;
      line += 1;
      lineStart = pos;
      continue;
    }
    if (ch === '\n') {
      pos += 1;
      line += 1;
      lineStart = pos;
      continue;
    }

    // Comment
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n' && source[pos] !== '\r') {
        pos += 1;
      }
      continue;
    }

    const startLine = line;
    const startCol = col();

    // Spread '...'
    if (ch === '.' && source.slice(pos, pos + 3) === '...') {
      tokens.push({ kind: '...', value: '...', line: startLine, column: startCol });
      pos += 3;
      continue;
    }

    if (PUNCTUATORS.has(ch)) {
      tokens.push({ kind: ch as TokenKind, value: ch, line: startLine, column: startCol });
      pos += 1;
      continue;
    }

    // Name
    if (isNameStart(ch)) {
      const start = pos;
      pos += 1;
      while (pos < source.length && isNameContinue(source[pos]!)) {
        pos += 1;
      }
      tokens.push({ kind: 'Name', value: source.slice(start, pos), line: startLine, column: startCol });
      continue;
    }

    // Number (Int or Float)
    if (ch === '-' || isDigit(ch)) {
      const start = pos;
      let isFloat = false;
      if (source[pos] === '-') pos += 1;
      if (pos >= source.length || !isDigit(source[pos]!)) {
        throw new GraphQLSyntaxError('Invalid number, expected digit after "-"', { line: startLine, column: startCol });
      }
      if (source[pos] === '0') {
        pos += 1;
        if (pos < source.length && isDigit(source[pos]!)) {
          throw new GraphQLSyntaxError('Invalid number, unexpected digit after 0', { line: startLine, column: startCol });
        }
      } else {
        while (pos < source.length && isDigit(source[pos]!)) pos += 1;
      }
      if (source[pos] === '.') {
        isFloat = true;
        pos += 1;
        if (pos >= source.length || !isDigit(source[pos]!)) {
          throw new GraphQLSyntaxError('Invalid number, expected digit after "."', { line: startLine, column: startCol });
        }
        while (pos < source.length && isDigit(source[pos]!)) pos += 1;
      }
      if (source[pos] === 'e' || source[pos] === 'E') {
        isFloat = true;
        pos += 1;
        if (source[pos] === '+' || source[pos] === '-') pos += 1;
        if (pos >= source.length || !isDigit(source[pos]!)) {
          throw new GraphQLSyntaxError('Invalid number, expected digit in exponent', { line: startLine, column: startCol });
        }
        while (pos < source.length && isDigit(source[pos]!)) pos += 1;
      }
      tokens.push({
        kind: isFloat ? 'Float' : 'Int',
        value: source.slice(start, pos),
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Block String """...""" or String "..."
    if (ch === '"') {
      if (source.slice(pos, pos + 3) === '"""') {
        pos += 3;
        let raw = '';
        let closed = false;
        while (pos < source.length) {
          if (source.slice(pos, pos + 4) === '\\"""') {
            raw += '"""';
            pos += 4;
            continue;
          }
          if (source.slice(pos, pos + 3) === '"""') {
            pos += 3;
            closed = true;
            break;
          }
          const c = source[pos]!;
          if (c === '\r') {
            pos += 1;
            if (source[pos] === '\n') pos += 1;
            raw += '\n';
            line += 1;
            lineStart = pos;
          } else if (c === '\n') {
            pos += 1;
            raw += '\n';
            line += 1;
            lineStart = pos;
          } else {
            raw += c;
            pos += 1;
          }
        }
        if (!closed) {
          throw new GraphQLSyntaxError('Unterminated block string', { line: startLine, column: startCol });
        }
        tokens.push({ kind: 'String', value: stripBlockStringIndentation(raw), line: startLine, column: startCol });
        continue;
      }

      pos += 1;
      let val = '';
      let closed = false;
      while (pos < source.length) {
        const c = source[pos]!;
        if (c === '"') {
          pos += 1;
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') {
          throw new GraphQLSyntaxError('Unterminated string literal', { line: startLine, column: startCol });
        }
        if (c === '\\') {
          pos += 1;
          if (pos >= source.length) {
            throw new GraphQLSyntaxError('Unterminated escape sequence', { line: startLine, column: startCol });
          }
          const esc = source[pos]!;
          pos += 1;
          switch (esc) {
            case '"': val += '"'; break;
            case '\\': val += '\\'; break;
            case '/': val += '/'; break;
            case 'b': val += '\b'; break;
            case 'f': val += '\f'; break;
            case 'n': val += '\n'; break;
            case 'r': val += '\r'; break;
            case 't': val += '\t'; break;
            case 'u': {
              if (source[pos] === '{') {
                const closeBrace = source.indexOf('}', pos + 1);
                if (closeBrace < 0) {
                  throw new GraphQLSyntaxError('Invalid unicode escape', { line: startLine, column: startCol });
                }
                const hex = source.slice(pos + 1, closeBrace);
                const cp = Number.parseInt(hex, 16);
                if (!/^[0-9a-fA-F]+$/.test(hex) || cp > 0x10ffff) {
                  throw new GraphQLSyntaxError('Invalid unicode escape', { line: startLine, column: startCol });
                }
                val += String.fromCodePoint(cp);
                pos = closeBrace + 1;
              } else {
                const hex = source.slice(pos, pos + 4);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                  throw new GraphQLSyntaxError('Invalid unicode escape', { line: startLine, column: startCol });
                }
                val += String.fromCharCode(Number.parseInt(hex, 16));
                pos += 4;
              }
              break;
            }
            default:
              throw new GraphQLSyntaxError(`Invalid escape sequence "\\${esc}"`, { line: startLine, column: startCol });
          }
          continue;
        }
        val += c;
        pos += 1;
      }
      if (!closed) {
        throw new GraphQLSyntaxError('Unterminated string literal', { line: startLine, column: startCol });
      }
      tokens.push({ kind: 'String', value: val, line: startLine, column: startCol });
      continue;
    }

    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, { line: startLine, column: startCol });
  }

  tokens.push({ kind: 'EOF', value: '', line, column: col() });
  return tokens;
}

type ValueNode =
  | { readonly kind: 'Variable'; readonly name: string; readonly loc: SourceLoc }
  | { readonly kind: 'IntValue'; readonly value: number; readonly loc: SourceLoc }
  | { readonly kind: 'FloatValue'; readonly value: number; readonly loc: SourceLoc }
  | { readonly kind: 'StringValue'; readonly value: string; readonly loc: SourceLoc }
  | { readonly kind: 'BooleanValue'; readonly value: boolean; readonly loc: SourceLoc }
  | { readonly kind: 'NullValue'; readonly loc: SourceLoc }
  | { readonly kind: 'EnumValue'; readonly value: string; readonly loc: SourceLoc }
  | { readonly kind: 'ListValue'; readonly values: readonly ValueNode[]; readonly loc: SourceLoc }
  | { readonly kind: 'ObjectValue'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[]; readonly loc: SourceLoc };

type TypeNode =
  | { readonly kind: 'NamedType'; readonly name: string }
  | { readonly kind: 'ListType'; readonly type: TypeNode }
  | { readonly kind: 'NonNullType'; readonly type: Exclude<TypeNode, { readonly kind: 'NonNullType' }> };

interface DirectiveNode {
  readonly name: string;
  readonly arguments: readonly ArgumentNode[];
  readonly loc: SourceLoc;
}

interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
  readonly loc: SourceLoc;
}

interface VariableDefinitionNode {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: ValueNode | undefined;
  readonly loc: SourceLoc;
}

interface FieldNode {
  readonly kind: 'Field';
  readonly alias: string | undefined;
  readonly name: string;
  readonly arguments: readonly ArgumentNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: readonly SelectionNode[] | undefined;
  readonly loc: SourceLoc;
}

interface InlineFragmentNode {
  readonly kind: 'InlineFragment';
  readonly typeCondition: string | undefined;
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: readonly SelectionNode[];
  readonly loc: SourceLoc;
}

interface FragmentSpreadNode {
  readonly kind: 'FragmentSpread';
  readonly name: string;
  readonly directives: readonly DirectiveNode[];
  readonly loc: SourceLoc;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationDefinitionNode {
  readonly kind: 'OperationDefinition';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | undefined;
  readonly variableDefinitions: readonly VariableDefinitionNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: readonly SelectionNode[];
  readonly loc: SourceLoc;
}

interface FragmentDefinitionNode {
  readonly kind: 'FragmentDefinition';
  readonly name: string;
  readonly typeCondition: string;
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: readonly SelectionNode[];
  readonly loc: SourceLoc;
}

interface DocumentNode {
  readonly operations: readonly OperationDefinitionNode[];
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>;
}

class Parser {
  private readonly tokens: readonly Token[];
  private idx = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.idx]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.idx]!;
    if (tok.kind !== 'EOF') this.idx += 1;
    return tok;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new GraphQLSyntaxError(`Expected ${kind}, found ${tok.kind} (${JSON.stringify(tok.value)})`, {
        line: tok.line,
        column: tok.column,
      });
    }
    return this.advance();
  }

  private expectKeyword(word: string): Token {
    const tok = this.peek();
    if (tok.kind !== 'Name' || tok.value !== word) {
      throw new GraphQLSyntaxError(`Expected "${word}", found ${JSON.stringify(tok.value || tok.kind)}`, {
        line: tok.line,
        column: tok.column,
      });
    }
    return this.advance();
  }

  private skip(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.advance();
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationDefinitionNode[] = [];
    const fragments = new Map<string, FragmentDefinitionNode>();

    while (this.peek().kind !== 'EOF') {
      const tok = this.peek();
      if (tok.kind === '{') {
        operations.push({
          kind: 'OperationDefinition',
          operation: 'query',
          name: undefined,
          variableDefinitions: [],
          directives: [],
          selectionSet: this.parseSelectionSet(),
          loc: { line: tok.line, column: tok.column },
        });
      } else if (tok.kind === 'Name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        operations.push(this.parseOperationDefinition());
      } else if (tok.kind === 'Name' && tok.value === 'fragment') {
        const frag = this.parseFragmentDefinition();
        fragments.set(frag.name, frag);
      } else {
        throw new GraphQLSyntaxError(`Unexpected token ${JSON.stringify(tok.value || tok.kind)}`, {
          line: tok.line,
          column: tok.column,
        });
      }
    }

    return { operations, fragments };
  }

  private parseOperationDefinition(): OperationDefinitionNode {
    const kw = this.expect('Name');
    const operation = kw.value as 'query' | 'mutation' | 'subscription';
    const name = this.peek().kind === 'Name' ? this.advance().value : undefined;
    const variableDefinitions = this.peek().kind === '(' ? this.parseVariableDefinitions() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'OperationDefinition',
      operation,
      name,
      variableDefinitions,
      directives,
      selectionSet,
      loc: { line: kw.line, column: kw.column },
    };
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    this.expect('(');
    const defs: VariableDefinitionNode[] = [];
    while (this.peek().kind !== ')') {
      const dollar = this.expect('$');
      const name = this.expect('Name').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.skip('=')) {
        defaultValue = this.parseValue(true);
      }
      this.parseDirectives();
      defs.push({ name, type, defaultValue, loc: { line: dollar.line, column: dollar.column } });
    }
    this.expect(')');
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.skip('[')) {
      const inner = this.parseType();
      this.expect(']');
      type = { kind: 'ListType', type: inner };
    } else {
      const name = this.expect('Name').value;
      type = { kind: 'NamedType', name };
    }
    if (this.skip('!')) {
      return { kind: 'NonNullType', type };
    }
    return type;
  }

  private parseFragmentDefinition(): FragmentDefinitionNode {
    const kw = this.expectKeyword('fragment');
    const nameTok = this.expect('Name');
    if (nameTok.value === 'on') {
      throw new GraphQLSyntaxError('Fragment name cannot be "on"', { line: nameTok.line, column: nameTok.column });
    }
    this.expectKeyword('on');
    const typeCondition = this.expect('Name').value;
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'FragmentDefinition',
      name: nameTok.value,
      typeCondition,
      directives,
      selectionSet,
      loc: { line: kw.line, column: kw.column },
    };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === '...') {
        selections.push(this.parseFragment());
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseFragment(): InlineFragmentNode | FragmentSpreadNode {
    const spread = this.expect('...');
    const tok = this.peek();
    if (tok.kind === 'Name' && tok.value !== 'on') {
      const name = this.advance().value;
      const directives = this.parseDirectives();
      return {
        kind: 'FragmentSpread',
        name,
        directives,
        loc: { line: spread.line, column: spread.column },
      };
    }
    let typeCondition: string | undefined;
    if (tok.kind === 'Name' && tok.value === 'on') {
      this.advance();
      typeCondition = this.expect('Name').value;
    }
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'InlineFragment',
      typeCondition,
      directives,
      selectionSet,
      loc: { line: spread.line, column: spread.column },
    };
  }

  private parseField(): FieldNode {
    const first = this.expect('Name');
    let alias: string | undefined;
    let nameTok = first;
    if (this.skip(':')) {
      alias = first.value;
      nameTok = this.expect('Name');
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : undefined;
    return {
      kind: 'Field',
      alias,
      name: nameTok.value,
      arguments: args,
      directives,
      selectionSet,
      loc: { line: nameTok.line, column: nameTok.column },
    };
  }

  private parseArguments(): ArgumentNode[] {
    this.expect('(');
    const args: ArgumentNode[] = [];
    while (this.peek().kind !== ')') {
      const nameTok = this.expect('Name');
      this.expect(':');
      const value = this.parseValue(false);
      args.push({ name: nameTok.value, value, loc: { line: nameTok.line, column: nameTok.column } });
    }
    this.expect(')');
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.peek().kind === '@') {
      const at = this.advance();
      const name = this.expect('Name').value;
      const args = this.peek().kind === '(' ? this.parseArguments() : [];
      dirs.push({ name, arguments: args, loc: { line: at.line, column: at.column } });
    }
    return dirs;
  }

  private parseValue(isConst: boolean): ValueNode {
    const tok = this.peek();
    switch (tok.kind) {
      case '$': {
        if (isConst) {
          throw new GraphQLSyntaxError('Unexpected variable in constant value', { line: tok.line, column: tok.column });
        }
        this.advance();
        const name = this.expect('Name').value;
        return { kind: 'Variable', name, loc: { line: tok.line, column: tok.column } };
      }
      case 'Int': {
        this.advance();
        return { kind: 'IntValue', value: Number.parseInt(tok.value, 10), loc: { line: tok.line, column: tok.column } };
      }
      case 'Float': {
        this.advance();
        return { kind: 'FloatValue', value: Number.parseFloat(tok.value), loc: { line: tok.line, column: tok.column } };
      }
      case 'String': {
        this.advance();
        return { kind: 'StringValue', value: tok.value, loc: { line: tok.line, column: tok.column } };
      }
      case 'Name': {
        this.advance();
        if (tok.value === 'true') return { kind: 'BooleanValue', value: true, loc: { line: tok.line, column: tok.column } };
        if (tok.value === 'false') return { kind: 'BooleanValue', value: false, loc: { line: tok.line, column: tok.column } };
        if (tok.value === 'null') return { kind: 'NullValue', loc: { line: tok.line, column: tok.column } };
        return { kind: 'EnumValue', value: tok.value, loc: { line: tok.line, column: tok.column } };
      }
      case '[': {
        this.advance();
        const values: ValueNode[] = [];
        while (this.peek().kind !== ']') {
          values.push(this.parseValue(isConst));
        }
        this.expect(']');
        return { kind: 'ListValue', values, loc: { line: tok.line, column: tok.column } };
      }
      case '{': {
        this.advance();
        const fields: { name: string; value: ValueNode }[] = [];
        while (this.peek().kind !== '}') {
          const name = this.expect('Name').value;
          this.expect(':');
          const value = this.parseValue(isConst);
          fields.push({ name, value });
        }
        this.expect('}');
        return { kind: 'ObjectValue', fields, loc: { line: tok.line, column: tok.column } };
      }
      default:
        throw new GraphQLSyntaxError(`Unexpected token ${JSON.stringify(tok.value || tok.kind)} in value`, {
          line: tok.line,
          column: tok.column,
        });
    }
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema Definition & Introspection Model
// ---------------------------------------------------------------------------

type TypeRef =
  | { readonly kind: 'NAMED'; readonly name: string }
  | { readonly kind: 'LIST'; readonly ofType: TypeRef }
  | { readonly kind: 'NON_NULL'; readonly ofType: TypeRef };

const named = (name: string): TypeRef => ({ kind: 'NAMED', name });
const listOf = (ofType: TypeRef): TypeRef => ({ kind: 'LIST', ofType });
const nonNull = (ofType: TypeRef): TypeRef => ({ kind: 'NON_NULL', ofType });

interface SchemaInputValue {
  readonly name: string;
  readonly description?: string;
  readonly type: TypeRef;
  readonly defaultValue?: string | null;
}

interface SchemaField {
  readonly name: string;
  readonly description?: string;
  readonly args?: readonly SchemaInputValue[];
  readonly type: TypeRef;
}

type SchemaTypeDef =
  | { readonly kind: 'SCALAR'; readonly name: string; readonly description?: string }
  | {
      readonly kind: 'OBJECT';
      readonly name: string;
      readonly description?: string;
      readonly interfaces?: readonly string[];
      readonly fields: readonly SchemaField[];
    }
  | {
      readonly kind: 'INTERFACE';
      readonly name: string;
      readonly description?: string;
      readonly possibleTypes: readonly string[];
      readonly fields: readonly SchemaField[];
    }
  | {
      readonly kind: 'ENUM';
      readonly name: string;
      readonly description?: string;
      readonly enumValues: readonly string[];
    }
  | {
      readonly kind: 'INPUT_OBJECT';
      readonly name: string;
      readonly description?: string;
      readonly inputFields: readonly SchemaInputValue[];
    };

const SCHEMA_TYPES: readonly SchemaTypeDef[] = [
  // Scalars
  { kind: 'SCALAR', name: 'ID' },
  { kind: 'SCALAR', name: 'String' },
  { kind: 'SCALAR', name: 'Int' },
  { kind: 'SCALAR', name: 'Float' },
  { kind: 'SCALAR', name: 'Boolean' },
  { kind: 'SCALAR', name: 'DateTime' },

  // Enums
  {
    kind: 'ENUM',
    name: 'IssueState',
    enumValues: ['OPEN', 'CLOSED'],
  },
  {
    kind: 'ENUM',
    name: 'PullRequestState',
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  {
    kind: 'ENUM',
    name: 'MergeableState',
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  {
    kind: 'ENUM',
    name: 'PullRequestMergeMethod',
    enumValues: ['MERGE', 'SQUASH', 'REBASE'],
  },
  {
    kind: 'ENUM',
    name: 'RepositoryPermission',
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  {
    kind: 'ENUM',
    name: 'SearchType',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  {
    kind: 'ENUM',
    name: 'IssueOrderField',
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
  {
    kind: 'ENUM',
    name: 'OrderDirection',
    enumValues: ['ASC', 'DESC'],
  },
  {
    kind: 'ENUM',
    name: 'IssueClosedStateReason',
    enumValues: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'],
  },
  {
    kind: 'ENUM',
    name: 'PatchStatus',
    enumValues: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'],
  },
  {
    kind: 'ENUM',
    name: '__TypeKind',
    enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },

  // Interfaces
  {
    kind: 'INTERFACE',
    name: 'Node',
    possibleTypes: ['User', 'Repository', 'Issue', 'PullRequest', 'IssueComment'],
    fields: [{ name: 'id', type: nonNull(named('ID')) }],
  },

  // Input Objects
  {
    kind: 'INPUT_OBJECT',
    name: 'IssueOrder',
    inputFields: [
      { name: 'field', type: nonNull(named('IssueOrderField')) },
      { name: 'direction', type: nonNull(named('OrderDirection')) },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'CreateIssueInput',
    inputFields: [
      { name: 'repositoryId', type: nonNull(named('ID')) },
      { name: 'title', type: nonNull(named('String')) },
      { name: 'body', type: named('String') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'CloseIssueInput',
    inputFields: [
      { name: 'issueId', type: nonNull(named('ID')) },
      { name: 'stateReason', type: named('IssueClosedStateReason') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'CreatePullRequestInput',
    inputFields: [
      { name: 'repositoryId', type: nonNull(named('ID')) },
      { name: 'baseRefName', type: nonNull(named('String')) },
      { name: 'headRefName', type: nonNull(named('String')) },
      { name: 'title', type: nonNull(named('String')) },
      { name: 'body', type: named('String') },
      { name: 'draft', type: named('Boolean') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'MergePullRequestInput',
    inputFields: [
      { name: 'pullRequestId', type: nonNull(named('ID')) },
      { name: 'mergeMethod', type: named('PullRequestMergeMethod') },
      { name: 'commitHeadline', type: named('String') },
      { name: 'commitBody', type: named('String') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'AddCommentInput',
    inputFields: [
      { name: 'subjectId', type: nonNull(named('ID')) },
      { name: 'body', type: nonNull(named('String')) },
      { name: 'clientMutationId', type: named('String') },
    ],
  },

  // Object types
  {
    kind: 'OBJECT',
    name: 'User',
    interfaces: ['Node'],
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'databaseId', type: named('Int') },
      { name: 'login', type: nonNull(named('String')) },
      { name: 'name', type: named('String') },
      { name: 'email', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Ref',
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'name', type: nonNull(named('String')) },
      { name: 'prefix', type: nonNull(named('String')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: [
      { name: 'hasNextPage', type: nonNull(named('Boolean')) },
      { name: 'hasPreviousPage', type: nonNull(named('Boolean')) },
      { name: 'startCursor', type: named('String') },
      { name: 'endCursor', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueComment',
    interfaces: ['Node'],
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'databaseId', type: named('Int') },
      { name: 'body', type: nonNull(named('String')) },
      { name: 'author', type: named('User') },
      { name: 'createdAt', type: nonNull(named('DateTime')) },
      { name: 'updatedAt', type: nonNull(named('DateTime')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueCommentEdge',
    fields: [
      { name: 'node', type: named('IssueComment') },
      { name: 'cursor', type: nonNull(named('String')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueCommentConnection',
    fields: [
      { name: 'nodes', type: listOf(named('IssueComment')) },
      { name: 'edges', type: listOf(named('IssueCommentEdge')) },
      { name: 'pageInfo', type: nonNull(named('PageInfo')) },
      { name: 'totalCount', type: nonNull(named('Int')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Issue',
    interfaces: ['Node'],
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'databaseId', type: named('Int') },
      { name: 'number', type: nonNull(named('Int')) },
      { name: 'title', type: nonNull(named('String')) },
      { name: 'state', type: nonNull(named('IssueState')) },
      { name: 'body', type: nonNull(named('String')) },
      { name: 'closed', type: nonNull(named('Boolean')) },
      { name: 'author', type: named('User') },
      { name: 'createdAt', type: nonNull(named('DateTime')) },
      { name: 'updatedAt', type: nonNull(named('DateTime')) },
      { name: 'closedAt', type: named('DateTime') },
      {
        name: 'comments',
        args: [
          { name: 'first', type: named('Int') },
          { name: 'after', type: named('String') },
          { name: 'last', type: named('Int') },
          { name: 'before', type: named('String') },
        ],
        type: nonNull(named('IssueCommentConnection')),
      },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueEdge',
    fields: [
      { name: 'node', type: named('Issue') },
      { name: 'cursor', type: nonNull(named('String')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: [
      { name: 'nodes', type: listOf(named('Issue')) },
      { name: 'edges', type: listOf(named('IssueEdge')) },
      { name: 'pageInfo', type: nonNull(named('PageInfo')) },
      { name: 'totalCount', type: nonNull(named('Int')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: [
      { name: 'path', type: nonNull(named('String')) },
      { name: 'additions', type: nonNull(named('Int')) },
      { name: 'deletions', type: nonNull(named('Int')) },
      { name: 'changeType', type: nonNull(named('PatchStatus')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileEdge',
    fields: [
      { name: 'node', type: named('PullRequestChangedFile') },
      { name: 'cursor', type: nonNull(named('String')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileConnection',
    fields: [
      { name: 'nodes', type: listOf(named('PullRequestChangedFile')) },
      { name: 'edges', type: listOf(named('PullRequestChangedFileEdge')) },
      { name: 'pageInfo', type: nonNull(named('PageInfo')) },
      { name: 'totalCount', type: nonNull(named('Int')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequest',
    interfaces: ['Node'],
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'databaseId', type: named('Int') },
      { name: 'number', type: nonNull(named('Int')) },
      { name: 'title', type: nonNull(named('String')) },
      { name: 'body', type: nonNull(named('String')) },
      { name: 'headRefName', type: nonNull(named('String')) },
      { name: 'baseRefName', type: nonNull(named('String')) },
      { name: 'mergeable', type: nonNull(named('MergeableState')) },
      { name: 'state', type: nonNull(named('PullRequestState')) },
      { name: 'merged', type: nonNull(named('Boolean')) },
      { name: 'closed', type: nonNull(named('Boolean')) },
      { name: 'author', type: named('User') },
      { name: 'createdAt', type: nonNull(named('DateTime')) },
      { name: 'updatedAt', type: nonNull(named('DateTime')) },
      { name: 'mergedAt', type: named('DateTime') },
      {
        name: 'files',
        args: [
          { name: 'first', type: named('Int') },
          { name: 'after', type: named('String') },
          { name: 'last', type: named('Int') },
          { name: 'before', type: named('String') },
        ],
        type: named('PullRequestChangedFileConnection'),
      },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestEdge',
    fields: [
      { name: 'node', type: named('PullRequest') },
      { name: 'cursor', type: nonNull(named('String')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: [
      { name: 'nodes', type: listOf(named('PullRequest')) },
      { name: 'edges', type: listOf(named('PullRequestEdge')) },
      { name: 'pageInfo', type: nonNull(named('PageInfo')) },
      { name: 'totalCount', type: nonNull(named('Int')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Repository',
    interfaces: ['Node'],
    fields: [
      { name: 'id', type: nonNull(named('ID')) },
      { name: 'databaseId', type: named('Int') },
      { name: 'name', type: nonNull(named('String')) },
      { name: 'nameWithOwner', type: nonNull(named('String')) },
      { name: 'owner', type: nonNull(named('User')) },
      { name: 'defaultBranchRef', type: named('Ref') },
      { name: 'viewerPermission', type: named('RepositoryPermission') },
      { name: 'hasIssuesEnabled', type: nonNull(named('Boolean')) },
      { name: 'description', type: named('String') },
      { name: 'isPrivate', type: nonNull(named('Boolean')) },
      { name: 'createdAt', type: nonNull(named('DateTime')) },
      { name: 'updatedAt', type: nonNull(named('DateTime')) },
      {
        name: 'issue',
        args: [{ name: 'number', type: nonNull(named('Int')) }],
        type: named('Issue'),
      },
      {
        name: 'issues',
        args: [
          { name: 'first', type: named('Int') },
          { name: 'after', type: named('String') },
          { name: 'last', type: named('Int') },
          { name: 'before', type: named('String') },
          { name: 'states', type: listOf(nonNull(named('IssueState'))) },
          { name: 'orderBy', type: named('IssueOrder') },
        ],
        type: nonNull(named('IssueConnection')),
      },
      {
        name: 'pullRequests',
        args: [
          { name: 'first', type: named('Int') },
          { name: 'after', type: named('String') },
          { name: 'last', type: named('Int') },
          { name: 'before', type: named('String') },
          { name: 'states', type: listOf(nonNull(named('PullRequestState'))) },
          { name: 'orderBy', type: named('IssueOrder') },
        ],
        type: nonNull(named('PullRequestConnection')),
      },
      {
        name: 'pullRequest',
        args: [{ name: 'number', type: nonNull(named('Int')) }],
        type: named('PullRequest'),
      },
    ],
  },

  // Mutation payloads
  {
    kind: 'OBJECT',
    name: 'CreateIssuePayload',
    fields: [
      { name: 'issue', type: named('Issue') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'CloseIssuePayload',
    fields: [
      { name: 'issue', type: named('Issue') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'CreatePullRequestPayload',
    fields: [
      { name: 'pullRequest', type: named('PullRequest') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'MergePullRequestPayload',
    fields: [
      { name: 'pullRequest', type: named('PullRequest') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'AddCommentPayload',
    fields: [
      { name: 'commentEdge', type: named('IssueCommentEdge') },
      { name: 'subject', type: named('Node') },
      { name: 'clientMutationId', type: named('String') },
    ],
  },

  // Introspection types
  {
    kind: 'OBJECT',
    name: '__Schema',
    fields: [
      { name: 'types', type: nonNull(listOf(nonNull(named('__Type')))) },
      { name: 'queryType', type: nonNull(named('__Type')) },
      { name: 'mutationType', type: named('__Type') },
      { name: 'subscriptionType', type: named('__Type') },
      { name: 'directives', type: nonNull(listOf(nonNull(named('__Directive')))) },
    ],
  },
  {
    kind: 'OBJECT',
    name: '__Type',
    fields: [
      { name: 'kind', type: nonNull(named('__TypeKind')) },
      { name: 'name', type: named('String') },
      { name: 'description', type: named('String') },
      {
        name: 'fields',
        args: [{ name: 'includeDeprecated', type: named('Boolean'), defaultValue: 'false' }],
        type: listOf(nonNull(named('__Field'))),
      },
      { name: 'interfaces', type: listOf(nonNull(named('__Type'))) },
      { name: 'possibleTypes', type: listOf(nonNull(named('__Type'))) },
      {
        name: 'enumValues',
        args: [{ name: 'includeDeprecated', type: named('Boolean'), defaultValue: 'false' }],
        type: listOf(nonNull(named('__EnumValue'))),
      },
      { name: 'inputFields', type: listOf(nonNull(named('__InputValue'))) },
      { name: 'ofType', type: named('__Type') },
    ],
  },
  {
    kind: 'OBJECT',
    name: '__Field',
    fields: [
      { name: 'name', type: nonNull(named('String')) },
      { name: 'description', type: named('String') },
      { name: 'args', type: nonNull(listOf(nonNull(named('__InputValue')))) },
      { name: 'type', type: nonNull(named('__Type')) },
      { name: 'isDeprecated', type: nonNull(named('Boolean')) },
      { name: 'deprecationReason', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: '__InputValue',
    fields: [
      { name: 'name', type: nonNull(named('String')) },
      { name: 'description', type: named('String') },
      { name: 'type', type: nonNull(named('__Type')) },
      { name: 'defaultValue', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: '__EnumValue',
    fields: [
      { name: 'name', type: nonNull(named('String')) },
      { name: 'description', type: named('String') },
      { name: 'isDeprecated', type: nonNull(named('Boolean')) },
      { name: 'deprecationReason', type: named('String') },
    ],
  },
  {
    kind: 'OBJECT',
    name: '__Directive',
    fields: [
      { name: 'name', type: nonNull(named('String')) },
      { name: 'description', type: named('String') },
      { name: 'locations', type: nonNull(listOf(nonNull(named('String')))) },
      { name: 'args', type: nonNull(listOf(nonNull(named('__InputValue')))) },
    ],
  },

  // Root Query & Mutation
  {
    kind: 'OBJECT',
    name: 'Query',
    fields: [
      { name: 'viewer', type: nonNull(named('User')) },
      {
        name: 'repository',
        args: [
          { name: 'owner', type: nonNull(named('String')) },
          { name: 'name', type: nonNull(named('String')) },
        ],
        type: named('Repository'),
      },
      {
        name: 'node',
        args: [{ name: 'id', type: nonNull(named('ID')) }],
        type: named('Node'),
      },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: [
      {
        name: 'createIssue',
        args: [{ name: 'input', type: nonNull(named('CreateIssueInput')) }],
        type: named('CreateIssuePayload'),
      },
      {
        name: 'closeIssue',
        args: [{ name: 'input', type: nonNull(named('CloseIssueInput')) }],
        type: named('CloseIssuePayload'),
      },
      {
        name: 'createPullRequest',
        args: [{ name: 'input', type: nonNull(named('CreatePullRequestInput')) }],
        type: named('CreatePullRequestPayload'),
      },
      {
        name: 'mergePullRequest',
        args: [{ name: 'input', type: nonNull(named('MergePullRequestInput')) }],
        type: named('MergePullRequestPayload'),
      },
      {
        name: 'addComment',
        args: [{ name: 'input', type: nonNull(named('AddCommentInput')) }],
        type: named('AddCommentPayload'),
      },
    ],
  },
];

const TYPE_MAP = new Map<string, SchemaTypeDef>(SCHEMA_TYPES.map((t) => [t.name, t]));
const FIELD_MAPS = new Map<string, Map<string, SchemaField>>();
for (const t of SCHEMA_TYPES) {
  if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
    FIELD_MAPS.set(t.name, new Map(t.fields.map((f) => [f.name, f])));
  }
}

function unwrapNamedType(ref: TypeRef): string {
  let cur = ref;
  while (cur.kind !== 'NAMED') cur = cur.ofType;
  return cur.name;
}

// ---------------------------------------------------------------------------
// Error types & Validation
// ---------------------------------------------------------------------------

interface GraphQLErrorItem {
  readonly message: string;
  readonly locations?: readonly SourceLoc[];
  readonly path?: readonly (string | number)[];
}

function validateSelectionSet(
  selections: readonly SelectionNode[],
  parentTypeName: string,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visitedFragments: Set<string>,
  errors: GraphQLErrorItem[],
): void {
  const parentDef = TYPE_MAP.get(parentTypeName);
  if (parentDef === undefined) return;
  const fieldMap = FIELD_MAPS.get(parentTypeName);

  for (const sel of selections) {
    if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name);
      if (frag === undefined) {
        errors.push({ message: `Unknown fragment "${sel.name}".`, locations: [sel.loc] });
        continue;
      }
      if (!visitedFragments.has(sel.name)) {
        visitedFragments.add(sel.name);
        validateSelectionSet(frag.selectionSet, frag.typeCondition, fragments, visitedFragments, errors);
      }
      continue;
    }

    if (sel.kind === 'InlineFragment') {
      const targetType = sel.typeCondition ?? parentTypeName;
      if (!TYPE_MAP.has(targetType)) {
        errors.push({ message: `Unknown type "${targetType}".`, locations: [sel.loc] });
        continue;
      }
      validateSelectionSet(sel.selectionSet, targetType, fragments, visitedFragments, errors);
      continue;
    }

    // Field selection
    if (sel.name === '__typename') continue;
    if (parentTypeName === 'Query' && (sel.name === '__type' || sel.name === '__schema')) {
      const returnTypeName = sel.name === '__type' ? '__Type' : '__Schema';
      if (sel.selectionSet !== undefined) {
        validateSelectionSet(sel.selectionSet, returnTypeName, fragments, visitedFragments, errors);
      }
      continue;
    }

    const fieldDef = fieldMap?.get(sel.name);
    if (fieldDef === undefined) {
      errors.push({
        message: `Field '${sel.name}' doesn't exist on type '${parentTypeName}'`,
        locations: [sel.loc],
      });
      continue;
    }

    const childTypeName = unwrapNamedType(fieldDef.type);
    const childDef = TYPE_MAP.get(childTypeName);
    if (childDef !== undefined && (childDef.kind === 'OBJECT' || childDef.kind === 'INTERFACE')) {
      if (sel.selectionSet === undefined || sel.selectionSet.length === 0) {
        errors.push({
          message: `Field "${sel.name}" of type "${childTypeName}" must have a selection of subfields.`,
          locations: [sel.loc],
        });
      } else {
        validateSelectionSet(sel.selectionSet, childTypeName, fragments, visitedFragments, errors);
      }
    } else if (sel.selectionSet !== undefined) {
      errors.push({
        message: `Field "${sel.name}" must not have a selection since type "${childTypeName}" has no subfields.`,
        locations: [sel.loc],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Value evaluation & Relay pagination helpers
// ---------------------------------------------------------------------------

function evalValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
    case 'FloatValue':
    case 'StringValue':
    case 'BooleanValue':
    case 'EnumValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'ListValue':
      return node.values.map((v) => evalValue(v, variables));
    case 'ObjectValue': {
      const obj: Record<string, unknown> = {};
      for (const f of node.fields) {
        const val = evalValue(f.value, variables);
        if (val !== undefined) {
          obj[f.name] = val;
        }
      }
      return obj;
    }
  }
}

function evalArgs(
  argNodes: readonly ArgumentNode[],
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of argNodes) {
    const val = evalValue(a.value, variables);
    if (val !== undefined) {
      out[a.name] = val;
    }
  }
  return out;
}

function coerceVariables(
  operation: OperationDefinitionNode,
  rawVariables: Readonly<Record<string, unknown>>,
  errors: GraphQLErrorItem[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rawVariables };
  for (const def of operation.variableDefinitions) {
    if (out[def.name] === undefined && def.defaultValue !== undefined) {
      out[def.name] = evalValue(def.defaultValue, out);
    }
    if ((out[def.name] === undefined || out[def.name] === null) && def.type.kind === 'NonNullType') {
      errors.push({
        message: `Variable "$${def.name}" of required type was not provided.`,
        locations: [def.loc],
      });
    }
  }
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number(decoded.slice('cursor:'.length));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

interface ConnectionResult<T> {
  readonly nodes: readonly T[];
  readonly edges: readonly { readonly node: T; readonly cursor: string }[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly startCursor: string | null;
    readonly endCursor: string | null;
  };
  readonly totalCount: number;
}

function paginateConnection<T>(items: readonly T[], args: Record<string, unknown>): ConnectionResult<T> {
  const totalCount = items.length;
  let start = 0;
  let end = totalCount;

  const afterIdx = decodeCursor(args.after);
  if (afterIdx !== null) {
    start = Math.min(totalCount, afterIdx + 1);
  }
  const beforeIdx = decodeCursor(args.before);
  if (beforeIdx !== null) {
    end = Math.max(start, Math.min(end, beforeIdx));
  }

  if (typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0) {
    end = Math.min(end, start + args.first);
  } else if (typeof args.last === 'number' && Number.isInteger(args.last) && args.last >= 0) {
    start = Math.max(start, end - args.last);
  }

  const edges: { readonly node: T; readonly cursor: string }[] = [];
  const nodes: T[] = [];
  for (let i = start; i < end; i += 1) {
    const item = items[i]!;
    nodes.push(item);
    edges.push({ node: item, cursor: encodeCursor(i) });
  }

  return {
    nodes,
    edges,
    pageInfo: {
      hasNextPage: end < totalCount,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// Execution Context & Resolvers
// ---------------------------------------------------------------------------

type RuntimeObject =
  | { readonly __typename: 'Query' }
  | { readonly __typename: 'Mutation' }
  | { readonly __typename: 'User'; readonly user: UserRecord }
  | { readonly __typename: 'Repository'; readonly repo: RepoRecord }
  | { readonly __typename: 'Ref'; readonly id: string; readonly name: string; readonly prefix: string }
  | { readonly __typename: 'Issue'; readonly repo: RepoRecord; readonly issue: IssueRecord }
  | { readonly __typename: 'PullRequest'; readonly repo: RepoRecord; readonly pull: PullRecord }
  | { readonly __typename: 'IssueComment'; readonly comment: CommentRecord }
  | { readonly __typename: 'PullRequestChangedFile'; readonly file: PullFileDiff }
  | { readonly __typename: 'PageInfo'; readonly pageInfo: ConnectionResult<unknown>['pageInfo'] }
  | { readonly __typename: 'IssueConnection'; readonly conn: ConnectionResult<RuntimeObject> }
  | { readonly __typename: 'IssueEdge'; readonly node: RuntimeObject; readonly cursor: string }
  | { readonly __typename: 'PullRequestConnection'; readonly conn: ConnectionResult<RuntimeObject> }
  | { readonly __typename: 'PullRequestEdge'; readonly node: RuntimeObject; readonly cursor: string }
  | { readonly __typename: 'PullRequestChangedFileConnection'; readonly conn: ConnectionResult<RuntimeObject> }
  | { readonly __typename: 'PullRequestChangedFileEdge'; readonly node: RuntimeObject; readonly cursor: string }
  | { readonly __typename: 'IssueCommentConnection'; readonly conn: ConnectionResult<RuntimeObject> }
  | { readonly __typename: 'IssueCommentEdge'; readonly node: RuntimeObject; readonly cursor: string }
  | { readonly __typename: 'CreateIssuePayload'; readonly issue: RuntimeObject; readonly clientMutationId: string | null }
  | { readonly __typename: 'CloseIssuePayload'; readonly issue: RuntimeObject; readonly clientMutationId: string | null }
  | { readonly __typename: 'CreatePullRequestPayload'; readonly pullRequest: RuntimeObject; readonly clientMutationId: string | null }
  | { readonly __typename: 'MergePullRequestPayload'; readonly pullRequest: RuntimeObject; readonly clientMutationId: string | null }
  | {
      readonly __typename: 'AddCommentPayload';
      readonly commentEdge: RuntimeObject;
      readonly subject: RuntimeObject;
      readonly clientMutationId: string | null;
    }
  | { readonly __typename: '__Schema' }
  | { readonly __typename: '__Type'; readonly typeRef: TypeRef }
  | { readonly __typename: '__Field'; readonly field: SchemaField }
  | { readonly __typename: '__InputValue'; readonly input: SchemaInputValue }
  | { readonly __typename: '__EnumValue'; readonly name: string }
  | { readonly __typename: '__Directive' };

class ResolverError extends Error {}

function shouldInclude(directives: readonly DirectiveNode[], variables: Readonly<Record<string, unknown>>): boolean {
  for (const dir of directives) {
    if (dir.name === 'skip') {
      const args = evalArgs(dir.arguments, variables);
      if (args.if === true) return false;
    } else if (dir.name === 'include') {
      const args = evalArgs(dir.arguments, variables);
      if (args.if === false) return false;
    }
  }
  return true;
}

function collectFields(
  selections: readonly SelectionNode[],
  runtimeType: string,
  doc: DocumentNode,
  variables: Readonly<Record<string, unknown>>,
  visitedFragments: Set<string>,
  out: Map<string, FieldNode[]>,
): void {
  for (const sel of selections) {
    if (!shouldInclude(sel.directives, variables)) continue;

    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      const list = out.get(key);
      if (list === undefined) out.set(key, [sel]);
      else list.push(sel);
      continue;
    }

    if (sel.kind === 'InlineFragment') {
      if (!doesFragmentMatch(sel.typeCondition, runtimeType)) continue;
      collectFields(sel.selectionSet, runtimeType, doc, variables, visitedFragments, out);
      continue;
    }

    if (visitedFragments.has(sel.name)) continue;
    visitedFragments.add(sel.name);
    const frag = doc.fragments.get(sel.name);
    if (frag === undefined) continue;
    if (!doesFragmentMatch(frag.typeCondition, runtimeType)) continue;
    collectFields(frag.selectionSet, runtimeType, doc, variables, visitedFragments, out);
  }
}

function doesFragmentMatch(typeCondition: string | undefined, runtimeType: string): boolean {
  if (typeCondition === undefined || typeCondition === runtimeType) return true;
  const condDef = TYPE_MAP.get(typeCondition);
  if (condDef?.kind === 'INTERFACE') {
    return condDef.possibleTypes.includes(runtimeType);
  }
  return false;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') throw new ResolverError(`Argument "${fieldName}" must be a String`);
  return value;
}

function asInt(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ResolverError(`Argument "${fieldName}" must be an Int`);
  }
  return value;
}

function asInputObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResolverError(`Argument "${fieldName}" must be an input object`);
  }
  return value as Record<string, unknown>;
}

function sortIssues(issues: readonly IssueRecord[], orderByRaw: unknown): IssueRecord[] {
  const list = [...issues];
  if (typeof orderByRaw !== 'object' || orderByRaw === null || Array.isArray(orderByRaw)) {
    return list;
  }
  const orderBy = orderByRaw as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const dir = orderBy.direction === 'DESC' ? -1 : 1;

  list.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') {
      cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    } else if (field === 'COMMENTS') {
      cmp = a.comments.length - b.comments.length;
    } else {
      cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }
    if (cmp !== 0) return cmp * dir;
    return (a.number - b.number) * dir;
  });
  return list;
}

function resolveFieldValue(
  parent: RuntimeObject,
  fieldName: string,
  args: Record<string, unknown>,
  store: ForgeStore,
): unknown {
  if (fieldName === '__typename') return parent.__typename;

  switch (parent.__typename) {
    case 'Query': {
      switch (fieldName) {
        case 'viewer':
          return { __typename: 'User', user: store.viewer } satisfies RuntimeObject;
        case 'repository': {
          const owner = asString(args.owner, 'owner');
          const name = asString(args.name, 'name');
          const repo = store.getRepo(owner, name);
          return repo === undefined ? null : ({ __typename: 'Repository', repo } satisfies RuntimeObject);
        }
        case 'node': {
          const id = asString(args.id, 'id');
          const node = store.nodesById.get(id);
          if (node === undefined) return null;
          switch (node.kind) {
            case 'repo':
              return { __typename: 'Repository', repo: node.repo } satisfies RuntimeObject;
            case 'issue':
              return { __typename: 'Issue', repo: node.repo, issue: node.issue } satisfies RuntimeObject;
            case 'pull':
              return { __typename: 'PullRequest', repo: node.repo, pull: node.pull } satisfies RuntimeObject;
            case 'comment':
              return { __typename: 'IssueComment', comment: node.comment } satisfies RuntimeObject;
            case 'user':
              return { __typename: 'User', user: node.user } satisfies RuntimeObject;
          }
        }
        case '__type': {
          const name = asString(args.name, 'name');
          return TYPE_MAP.has(name) ? ({ __typename: '__Type', typeRef: named(name) } satisfies RuntimeObject) : null;
        }
        case '__schema':
          return { __typename: '__Schema' } satisfies RuntimeObject;
        default:
          return null;
      }
    }

    case 'Mutation': {
      const input = asInputObject(args.input, 'input');
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      switch (fieldName) {
        case 'createIssue': {
          const repoId = asString(input.repositoryId, 'repositoryId');
          const title = asString(input.title, 'title');
          const body = typeof input.body === 'string' ? input.body : '';
          const node = store.nodesById.get(repoId);
          if (node === undefined || node.kind !== 'repo') {
            throw new ResolverError(`Could not resolve to a Repository with the global id of '${repoId}'`);
          }
          const issue = store.createIssue(node.repo, { title, body });
          return {
            __typename: 'CreateIssuePayload',
            issue: { __typename: 'Issue', repo: node.repo, issue },
            clientMutationId,
          } satisfies RuntimeObject;
        }
        case 'closeIssue': {
          const issueId = asString(input.issueId, 'issueId');
          const node = store.nodesById.get(issueId);
          if (node === undefined || node.kind !== 'issue') {
            throw new ResolverError(`Could not resolve to an Issue with the global id of '${issueId}'`);
          }
          const updated = store.updateIssue(node.repo, node.issue.number, { state: 'closed' });
          if (updated === undefined) {
            throw new ResolverError(`Issue #${node.issue.number} not found`);
          }
          return {
            __typename: 'CloseIssuePayload',
            issue: { __typename: 'Issue', repo: node.repo, issue: updated },
            clientMutationId,
          } satisfies RuntimeObject;
        }
        case 'createPullRequest': {
          const repoId = asString(input.repositoryId, 'repositoryId');
          const baseRefName = asString(input.baseRefName, 'baseRefName');
          const headRefName = asString(input.headRefName, 'headRefName');
          const title = asString(input.title, 'title');
          const body = typeof input.body === 'string' ? input.body : '';
          const node = store.nodesById.get(repoId);
          if (node === undefined || node.kind !== 'repo') {
            throw new ResolverError(`Could not resolve to a Repository with the global id of '${repoId}'`);
          }
          try {
            const pull = store.createPull(node.repo, { title, body, head: headRefName, base: baseRefName });
            return {
              __typename: 'CreatePullRequestPayload',
              pullRequest: { __typename: 'PullRequest', repo: node.repo, pull },
              clientMutationId,
            } satisfies RuntimeObject;
          } catch (err) {
            if (err instanceof UnprocessableError) throw new ResolverError(err.message);
            throw err;
          }
        }
        case 'mergePullRequest': {
          const pullRequestId = asString(input.pullRequestId, 'pullRequestId');
          const node = store.nodesById.get(pullRequestId);
          if (node === undefined || node.kind !== 'pull') {
            throw new ResolverError(`Could not resolve to a PullRequest with the global id of '${pullRequestId}'`);
          }
          const mergeMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
          try {
            store.mergePull(node.repo, node.pull, {
              commitTitle: typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined,
              commitMessage: typeof input.commitBody === 'string' ? input.commitBody : undefined,
              mergeMethod,
            });
            return {
              __typename: 'MergePullRequestPayload',
              pullRequest: { __typename: 'PullRequest', repo: node.repo, pull: node.pull },
              clientMutationId,
            } satisfies RuntimeObject;
          } catch (err) {
            if (err instanceof MethodNotAllowedError) throw new ResolverError(err.message);
            throw err;
          }
        }
        case 'addComment': {
          const subjectId = asString(input.subjectId, 'subjectId');
          const body = asString(input.body, 'body');
          const node = store.nodesById.get(subjectId);
          if (node === undefined || node.kind !== 'issue') {
            throw new ResolverError(`Could not resolve to an Issue with the global id of '${subjectId}'`);
          }
          const comment = store.addComment(node.repo, node.issue.number, body);
          if (comment === undefined) {
            throw new ResolverError(`Issue #${node.issue.number} not found`);
          }
          const commentObj: RuntimeObject = { __typename: 'IssueComment', comment };
          const cursor = encodeCursor(node.issue.comments.length - 1);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: commentObj, cursor },
            subject: { __typename: 'Issue', repo: node.repo, issue: node.issue },
            clientMutationId,
          } satisfies RuntimeObject;
        }
        default:
          return null;
      }
    }

    case 'User': {
      const u = parent.user;
      switch (fieldName) {
        case 'id': return u.nodeId;
        case 'databaseId': return u.id;
        case 'login': return u.login;
        case 'name': return u.name;
        case 'email': return u.email;
        default: return null;
      }
    }

    case 'Repository': {
      const r = parent.repo;
      switch (fieldName) {
        case 'id': return r.nodeId;
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return r.fullName;
        case 'owner': return { __typename: 'User', user: r.owner } satisfies RuntimeObject;
        case 'defaultBranchRef': {
          const refKey = `refs/heads/${r.defaultBranch}`;
          if (!r.refs.has(refKey)) return null;
          return {
            __typename: 'Ref',
            id: `ref:${r.id}:${refKey}`,
            name: r.defaultBranch,
            prefix: 'refs/heads/',
          } satisfies RuntimeObject;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return r.description;
        case 'isPrivate': return r.isPrivate;
        case 'createdAt': return r.createdAt;
        case 'updatedAt': return r.updatedAt;
        case 'issue': {
          const num = asInt(args.number, 'number');
          const issue = r.issueByNumber.get(num);
          return issue === undefined ? null : ({ __typename: 'Issue', repo: r, issue } satisfies RuntimeObject);
        }
        case 'issues': {
          const statesFilter = Array.isArray(args.states)
            ? new Set(args.states.filter((s): s is string => typeof s === 'string'))
            : null;
          const filtered = r.issues.filter((i) => {
            if (statesFilter === null || statesFilter.size === 0) return true;
            const gqlState = i.state === 'open' ? 'OPEN' : 'CLOSED';
            return statesFilter.has(gqlState);
          });
          const ordered = sortIssues(filtered, args.orderBy);
          const wrapped: RuntimeObject[] = ordered.map((issue) => ({ __typename: 'Issue', repo: r, issue }));
          return { __typename: 'IssueConnection', conn: paginateConnection(wrapped, args) } satisfies RuntimeObject;
        }
        case 'pullRequest': {
          const num = asInt(args.number, 'number');
          const pull = r.pullByNumber.get(num);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo: r, pull } satisfies RuntimeObject);
        }
        case 'pullRequests': {
          const statesFilter = Array.isArray(args.states)
            ? new Set(args.states.filter((s): s is string => typeof s === 'string'))
            : null;
          const filtered = r.pulls.filter((p) => {
            if (statesFilter === null || statesFilter.size === 0) return true;
            const gqlState = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
            return statesFilter.has(gqlState);
          });
          const wrapped: RuntimeObject[] = filtered.map((pull) => ({ __typename: 'PullRequest', repo: r, pull }));
          return { __typename: 'PullRequestConnection', conn: paginateConnection(wrapped, args) } satisfies RuntimeObject;
        }
        default: return null;
      }
    }

    case 'Ref': {
      if (fieldName === 'id') return parent.id;
      if (fieldName === 'name') return parent.name;
      if (fieldName === 'prefix') return parent.prefix;
      return null;
    }

    case 'Issue': {
      const i = parent.issue;
      switch (fieldName) {
        case 'id': return i.nodeId;
        case 'databaseId': return i.id;
        case 'number': return i.number;
        case 'title': return i.title;
        case 'body': return i.body;
        case 'state': return i.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'closed': return i.state === 'closed';
        case 'author': return { __typename: 'User', user: i.user } satisfies RuntimeObject;
        case 'createdAt': return i.createdAt;
        case 'updatedAt': return i.updatedAt;
        case 'closedAt': return i.closedAt;
        case 'comments': {
          const wrapped: RuntimeObject[] = i.comments.map((comment) => ({ __typename: 'IssueComment', comment }));
          return { __typename: 'IssueCommentConnection', conn: paginateConnection(wrapped, args) } satisfies RuntimeObject;
        }
        default: return null;
      }
    }

    case 'PullRequest': {
      const p = parent.pull;
      switch (fieldName) {
        case 'id': return p.nodeId;
        case 'databaseId': return p.id;
        case 'number': return p.number;
        case 'title': return p.title;
        case 'body': return p.body;
        case 'headRefName': return p.headRef;
        case 'baseRefName': return p.baseRef;
        case 'mergeable': return store.getPullMergeable(parent.repo, p);
        case 'state': return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return p.merged;
        case 'closed': return p.state === 'closed';
        case 'author': return { __typename: 'User', user: p.user } satisfies RuntimeObject;
        case 'createdAt': return p.createdAt;
        case 'updatedAt': return p.updatedAt;
        case 'mergedAt': return p.mergedAt;
        case 'files': {
          const diffs = store.getPullFiles(parent.repo, p);
          const wrapped: RuntimeObject[] = diffs.map((file) => ({ __typename: 'PullRequestChangedFile', file }));
          return {
            __typename: 'PullRequestChangedFileConnection',
            conn: paginateConnection(wrapped, args),
          } satisfies RuntimeObject;
        }
        default: return null;
      }
    }

    case 'PullRequestChangedFile': {
      const f = parent.file;
      switch (fieldName) {
        case 'path': return f.filename;
        case 'additions': return f.additions;
        case 'deletions': return f.deletions;
        case 'changeType':
          return f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED';
        default: return null;
      }
    }

    case 'IssueComment': {
      const c = parent.comment;
      switch (fieldName) {
        case 'id': return c.nodeId;
        case 'databaseId': return c.id;
        case 'body': return c.body;
        case 'author': return { __typename: 'User', user: c.user } satisfies RuntimeObject;
        case 'createdAt': return c.createdAt;
        case 'updatedAt': return c.updatedAt;
        default: return null;
      }
    }

    case 'PageInfo': {
      switch (fieldName) {
        case 'hasNextPage': return parent.pageInfo.hasNextPage;
        case 'hasPreviousPage': return parent.pageInfo.hasPreviousPage;
        case 'startCursor': return parent.pageInfo.startCursor;
        case 'endCursor': return parent.pageInfo.endCursor;
        default: return null;
      }
    }

    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      const edgeType =
        parent.__typename === 'IssueConnection'
          ? 'IssueEdge'
          : parent.__typename === 'PullRequestConnection'
            ? 'PullRequestEdge'
            : parent.__typename === 'PullRequestChangedFileConnection'
              ? 'PullRequestChangedFileEdge'
              : 'IssueCommentEdge';
      switch (fieldName) {
        case 'nodes': return parent.conn.nodes;
        case 'edges':
          return parent.conn.edges.map((e) => ({ __typename: edgeType, node: e.node, cursor: e.cursor } satisfies RuntimeObject));
        case 'pageInfo': return { __typename: 'PageInfo', pageInfo: parent.conn.pageInfo } satisfies RuntimeObject;
        case 'totalCount': return parent.conn.totalCount;
        default: return null;
      }
    }

    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge':
      if (fieldName === 'node') return parent.node;
      if (fieldName === 'cursor') return parent.cursor;
      return null;

    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (fieldName === 'issue') return parent.issue;
      if (fieldName === 'clientMutationId') return parent.clientMutationId;
      return null;

    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (fieldName === 'pullRequest') return parent.pullRequest;
      if (fieldName === 'clientMutationId') return parent.clientMutationId;
      return null;

    case 'AddCommentPayload':
      if (fieldName === 'commentEdge') return parent.commentEdge;
      if (fieldName === 'subject') return parent.subject;
      if (fieldName === 'clientMutationId') return parent.clientMutationId;
      return null;

    case '__Schema': {
      switch (fieldName) {
        case 'types':
          return SCHEMA_TYPES.map((t) => ({ __typename: '__Type', typeRef: named(t.name) }) satisfies RuntimeObject);
        case 'queryType':
          return { __typename: '__Type', typeRef: named('Query') } satisfies RuntimeObject;
        case 'mutationType':
          return { __typename: '__Type', typeRef: named('Mutation') } satisfies RuntimeObject;
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
        default:
          return null;
      }
    }

    case '__Type': {
      const ref = parent.typeRef;
      if (ref.kind === 'LIST' || ref.kind === 'NON_NULL') {
        if (fieldName === 'kind') return ref.kind;
        if (fieldName === 'ofType') return { __typename: '__Type', typeRef: ref.ofType } satisfies RuntimeObject;
        return null;
      }
      const def = TYPE_MAP.get(ref.name);
      if (def === undefined) return null;
      switch (fieldName) {
        case 'kind': return def.kind;
        case 'name': return def.name;
        case 'description': return def.description ?? null;
        case 'fields': {
          if (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') return null;
          return def.fields.map((field) => ({ __typename: '__Field', field }) satisfies RuntimeObject);
        }
        case 'interfaces': {
          if (def.kind !== 'OBJECT') return null;
          return (def.interfaces ?? []).map((n) => ({ __typename: '__Type', typeRef: named(n) }) satisfies RuntimeObject);
        }
        case 'possibleTypes': {
          if (def.kind !== 'INTERFACE') return null;
          return def.possibleTypes.map((n) => ({ __typename: '__Type', typeRef: named(n) }) satisfies RuntimeObject);
        }
        case 'enumValues': {
          if (def.kind !== 'ENUM') return null;
          return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }) satisfies RuntimeObject);
        }
        case 'inputFields': {
          if (def.kind !== 'INPUT_OBJECT') return null;
          return def.inputFields.map((input) => ({ __typename: '__InputValue', input }) satisfies RuntimeObject);
        }
        case 'ofType':
          return null;
        default:
          return null;
      }
    }

    case '__Field': {
      const f = parent.field;
      switch (fieldName) {
        case 'name': return f.name;
        case 'description': return f.description ?? null;
        case 'args':
          return (f.args ?? []).map((input) => ({ __typename: '__InputValue', input }) satisfies RuntimeObject);
        case 'type':
          return { __typename: '__Type', typeRef: f.type } satisfies RuntimeObject;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: return null;
      }
    }

    case '__InputValue': {
      const iv = parent.input;
      switch (fieldName) {
        case 'name': return iv.name;
        case 'description': return iv.description ?? null;
        case 'type': return { __typename: '__Type', typeRef: iv.type } satisfies RuntimeObject;
        case 'defaultValue': return iv.defaultValue ?? null;
        default: return null;
      }
    }

    case '__EnumValue': {
      switch (fieldName) {
        case 'name': return parent.name;
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: return null;
      }
    }

    case '__Directive':
      return null;
  }
}

function completeValue(
  value: unknown,
  selectionSet: readonly SelectionNode[] | undefined,
  doc: DocumentNode,
  variables: Readonly<Record<string, unknown>>,
  store: ForgeStore,
  path: readonly (string | number)[],
  errors: GraphQLErrorItem[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      completeValue(item, selectionSet, doc, variables, store, [...path, idx], errors),
    );
  }
  if (typeof value === 'object') {
    const obj = value as RuntimeObject;
    if (selectionSet === undefined) return null;
    return executeSelectionSet(obj, selectionSet, doc, variables, store, path, errors);
  }
  return value;
}

function executeSelectionSet(
  parent: RuntimeObject,
  selections: readonly SelectionNode[],
  doc: DocumentNode,
  variables: Readonly<Record<string, unknown>>,
  store: ForgeStore,
  path: readonly (string | number)[],
  errors: GraphQLErrorItem[],
): Record<string, unknown> {
  const grouped = new Map<string, FieldNode[]>();
  collectFields(selections, parent.__typename, doc, variables, new Set(), grouped);
  const result: Record<string, unknown> = {};

  for (const [responseKey, nodes] of grouped) {
    const fieldNode = nodes[0]!;
    const fieldPath = [...path, responseKey];
    const args = evalArgs(fieldNode.arguments, variables);
    let resolved: unknown;
    try {
      resolved = resolveFieldValue(parent, fieldNode.name, args, store);
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        locations: [fieldNode.loc],
        path: fieldPath,
      });
      result[responseKey] = null;
      continue;
    }

    let mergedSubSelections: SelectionNode[] | undefined;
    for (const n of nodes) {
      if (n.selectionSet !== undefined) {
        mergedSubSelections ??= [];
        mergedSubSelections.push(...n.selectionSet);
      }
    }
    result[responseKey] = completeValue(resolved, mergedSubSelections, doc, variables, store, fieldPath, errors);
  }

  return result;
}

function executeSingleOperation(
  payload: unknown,
  store: ForgeStore,
): { readonly data?: Record<string, unknown> | null; readonly errors?: readonly GraphQLErrorItem[] } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { errors: [{ message: 'GraphQL request payload must be a JSON object' }] };
  }
  const rec = payload as Record<string, unknown>;
  const query = rec.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  const rawVariables =
    typeof rec.variables === 'object' && rec.variables !== null && !Array.isArray(rec.variables)
      ? (rec.variables as Record<string, unknown>)
      : {};
  const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;

  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) {
      return { errors: [{ message: err.message, locations: [err.loc] }] };
    }
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }

  let operation: OperationDefinitionNode | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0]!;
  } else if (doc.operations.length === 0) {
    return { errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }

  if (operation.operation === 'subscription') {
    return { errors: [{ message: 'Subscriptions are not supported.' }] };
  }

  const rootTypeName = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: GraphQLErrorItem[] = [];
  validateSelectionSet(operation.selectionSet, rootTypeName, doc.fragments, new Set(), validationErrors);
  const variables = coerceVariables(operation, rawVariables, validationErrors);

  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  const rootValue: RuntimeObject =
    operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const execErrors: GraphQLErrorItem[] = [];
  const data = executeSelectionSet(rootValue, operation.selectionSet, doc, variables, store, [], execErrors);

  return execErrors.length > 0 ? { data, errors: execErrors } : { data };
}

/** Handle POST /api/graphql requests (single operation or batched array). */
export async function handleGraphqlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  expectedToken: string,
): Promise<void> {
  if (!isAuthorized(req, expectedToken)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  const method = (req.method ?? 'POST').toUpperCase();
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  let parsed: unknown;
  try {
    parsed = await readJsonBody(req, true);
  } catch (err) {
    if (err instanceof MalformedJsonError) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }

  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeSingleOperation(entry, store));
    sendJson(res, 200, results);
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }

  sendJson(res, 200, executeSingleOperation(parsed, store));
}
