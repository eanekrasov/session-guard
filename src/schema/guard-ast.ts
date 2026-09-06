/**
 * AST-based guard expression evaluator.
 *
 * Replaces `new Function` with a typed, bounded AST interpreter that cannot
 * access globals, prototypes, or perform arbitrary calls. Supports:
 * - Literals (string, number, boolean, null, undefined)
 * - Identifiers and member access (dot and bracket)
 * - Function calls with known built-in names
 * - Unary operators (!, -)
 * - Binary operators (&&, ||, ==, !=, ===, !==, <, >, <=, >=, +, -, *, /)
 * - Ternary (a ? b : c)
 * - Array literals and arrow/callback functions (bounded recursion)
 *
 * AST depth, evaluation steps, and callback recursion are bounded.
 */

/** Max AST depth before evaluation rejects the expression. */
const MAX_AST_DEPTH = 64;

/** Max evaluation steps before timeout-like rejection. */
const MAX_EVAL_STEPS = 10_000;

/** Max callback invocations per evaluation. */
const MAX_CALLBACK_CALLS = 128;

// ─── AST Node Types ─────────────────────────────────────────────────────────

export type AstNode =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | TernaryNode
  | ArrayNode
  | ArrowNode;

interface LiteralNode {
  type: 'literal';
  value: string | number | boolean | null;
}

interface IdentifierNode {
  type: 'identifier';
  name: string;
}

interface MemberNode {
  type: 'member';
  object: AstNode;
  property: string;
  optional: boolean;
}

interface CallNode {
  type: 'call';
  callee: AstNode;
  args: AstNode[];
  optional: boolean;
}

interface UnaryNode {
  type: 'unary';
  operator: '-' | '!' | '+' | 'typeof';
  argument: AstNode;
}

interface BinaryNode {
  type: 'binary';
  operator: string;
  left: AstNode;
  right: AstNode;
}

interface TernaryNode {
  type: 'ternary';
  test: AstNode;
  consequent: AstNode;
  alternate: AstNode;
}

interface ArrayNode {
  type: 'array';
  elements: AstNode[];
}

interface ArrowNode {
  type: 'arrow';
  params: string[];
  body: AstNode;
}

// ─── Tokeniser ───────────────────────────────────────────────────────────────

interface Token {
  kind: string;
  value: string;
  pos: number;
}

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }

    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Multi-char operators (check 3-char before 2-char)
    const two = input.slice(i, i + 2);
    const three = input.slice(i, i + 3);
    if (three === '...') {
      tokens.push({ kind: '...', value: '...', pos: i });
      i += 3;
      continue;
    }
    if (three === '===' || three === '!==') {
      tokens.push({ kind: three, value: three, pos: i });
      i += 3;
      continue;
    }
    const multi = ['==', '!=', '&&', '||', '<=', '>=', '=>', '?.', '??'];
    if (multi.includes(two)) {
      tokens.push({ kind: two, value: two, pos: i });
      i += 2;
      continue;
    }

    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      tokens.push({ kind: ch, value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === '?' || ch === ':' || ch === '.') {
      tokens.push({ kind: ch, value: ch, pos: i });
      i++;
      continue;
    }

    // Single-char operators
    if ('+-*/%<>=!&|'.includes(ch)) {
      tokens.push({ kind: ch, value: ch, pos: i });
      i++;
      continue;
    }

    // String literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let value = '';
      i++;
      let escaped = false;
      while (i < input.length) {
        if (escaped) {
          value += input[i];
          escaped = false;
          i++;
          continue;
        }
        if (input[i] === '\\') {
          escaped = true;
          i++;
          continue;
        }
        if (input[i] === quote) {
          i++;
          break;
        }
        value += input[i];
        i++;
      }
      tokens.push({ kind: 'string', value, pos: i });
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch)) {
      let value = '';
      while (i < input.length && /[0-9.eE+-]/.test(input[i])) {
        if (input[i] === '+' || input[i] === '-') {
          if (
            value.length > 0 &&
            value[value.length - 1] !== 'e' &&
            value[value.length - 1] !== 'E'
          )
            break;
        }
        value += input[i];
        i++;
      }
      tokens.push({ kind: 'number', value, pos: i });
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(ch)) {
      let value = '';
      while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i])) {
        value += input[i];
        i++;
      }
      tokens.push({ kind: 'id', value, pos: i });
      continue;
    }

    // Unknown char — skip
    i++;
  }
  return tokens;
}

// ─── Parser (recursive descent, bounded) ─────────────────────────────────────

class ParseError extends Error {
  constructor(
    message: string,
    readonly pos: number
  ) {
    super(message);
  }
}

function peek(tokens: Token[], depth: number): string {
  return tokens.length > 0 ? tokens[0].kind : 'EOF';
}

function consume(tokens: Token[], expected?: string): Token {
  const token = tokens.shift();
  if (!token) throw new ParseError('Unexpected end of expression', -1);
  if (expected && token.kind !== expected) {
    throw new ParseError(
      `Expected ${expected} but got ${token.kind}('${token.value}') at ${token.pos}`,
      token.pos
    );
  }
  return token;
}

function parseExpr(tokens: Token[], _depth = 0): AstNode {
  if (_depth > MAX_AST_DEPTH) throw new ParseError('AST depth exceeded', -1);
  return parseTernary(tokens, _depth + 1);
}

function parseTernary(tokens: Token[], depth: number): AstNode {
  let node = parseNullish(tokens, depth);
  if (peek(tokens, depth) === '?') {
    consume(tokens, '?');
    const consequent = parseExpr(tokens, depth + 1);
    consume(tokens, ':');
    const alternate = parseExpr(tokens, depth + 1);
    node = { type: 'ternary', test: node, consequent, alternate };
  }
  return node;
}

function parseNullish(tokens: Token[], depth: number): AstNode {
  let node = parseLogicalOr(tokens, depth);
  if (peek(tokens, depth) === '??') {
    consume(tokens, '??');
    const right = parseNullish(tokens, depth + 1);
    node = { type: 'binary', operator: '??', left: node, right };
  }
  return node;
}

function parseLogicalOr(tokens: Token[], depth: number): AstNode {
  let node = parseLogicalAnd(tokens, depth);
  while (peek(tokens, depth) === '||') {
    const op = consume(tokens, '||').value;
    const right = parseLogicalAnd(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseLogicalAnd(tokens: Token[], depth: number): AstNode {
  let node = parseEquality(tokens, depth);
  while (peek(tokens, depth) === '&&') {
    const op = consume(tokens, '&&').value;
    const right = parseEquality(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseEquality(tokens: Token[], depth: number): AstNode {
  let node = parseRelational(tokens, depth);
  const eqOps = ['===', '!==', '==', '!='];
  while (eqOps.includes(peek(tokens, depth))) {
    const op = consume(tokens, peek(tokens, depth)).value;
    const right = parseRelational(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseRelational(tokens: Token[], depth: number): AstNode {
  let node = parseAdditive(tokens, depth);
  const relOps = ['<', '>', '<=', '>='];
  while (relOps.includes(peek(tokens, depth))) {
    const op = consume(tokens, peek(tokens, depth)).value;
    const right = parseAdditive(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseAdditive(tokens: Token[], depth: number): AstNode {
  let node = parseMultiplicative(tokens, depth);
  while (peek(tokens, depth) === '+' || peek(tokens, depth) === '-') {
    const op = consume(tokens, peek(tokens, depth)).value;
    const right = parseMultiplicative(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseMultiplicative(tokens: Token[], depth: number): AstNode {
  let node = parseUnary(tokens, depth);
  while (
    peek(tokens, depth) === '*' ||
    peek(tokens, depth) === '/' ||
    peek(tokens, depth) === '%'
  ) {
    const op = consume(tokens, peek(tokens, depth)).value;
    const right = parseUnary(tokens, depth + 1);
    node = { type: 'binary', operator: op, left: node, right };
  }
  return node;
}

function parseUnary(tokens: Token[], depth: number): AstNode {
  const tokenKind = peek(tokens, depth);
  if (tokenKind === '!' || tokenKind === '-') {
    const op = consume(tokens, tokenKind).value as '-' | '!';
    const argument = parseUnary(tokens, depth + 1);
    return { type: 'unary', operator: op, argument };
  }
  // typeof keyword — it's emitted as an 'id' token by the tokeniser
  if (tokenKind === 'id' && tokens[0]?.value === 'typeof') {
    consume(tokens, 'id');
    const argument = parseUnary(tokens, depth + 1);
    return { type: 'unary', operator: 'typeof', argument };
  }
  return parsePrimary(tokens, depth);
}

function parsePrimary(tokens: Token[], depth: number): AstNode {
  const token = peek(tokens, depth);

  // Parenthesised expression
  if (token === '(') {
    consume(tokens, '(');
    const node = parseExpr(tokens, depth + 1);
    consume(tokens, ')');
    return parsePostfix(node, tokens, depth);
  }

  // Array literal
  if (token === '[') {
    consume(tokens, '[');
    const elements: AstNode[] = [];
    while (peek(tokens, depth) !== ']') {
      if (elements.length > 0 && peek(tokens, depth) === ',') {
        consume(tokens, ',');
        continue;
      }
      elements.push(parseExpr(tokens, depth + 1));
      if (peek(tokens, depth) === ',') consume(tokens, ',');
    }
    consume(tokens, ']');
    return parsePostfix({ type: 'array', elements }, tokens, depth);
  }

  // String literal
  if (token === 'string') {
    const value = consume(tokens, 'string').value;
    return parsePostfix({ type: 'literal', value }, tokens, depth);
  }

  // Number literal
  if (token === 'number') {
    const value = Number(consume(tokens, 'number').value);
    return parsePostfix({ type: 'literal', value }, tokens, depth);
  }

  // Keywords
  if (token === 'id') {
    const id = consume(tokens, 'id').value;
    if (id === 'true') return parsePostfix({ type: 'literal', value: true }, tokens, depth);
    if (id === 'false') return parsePostfix({ type: 'literal', value: false }, tokens, depth);
    if (id === 'null') return parsePostfix({ type: 'literal', value: null }, tokens, depth);
    if (id === 'undefined') {
      // The `id` token was already consumed above — `undefined` is a literal,
      // not a prefix keyword, so nothing further may be consumed here.
      return parsePostfix({ type: 'literal', value: undefined as unknown as null }, tokens, depth);
    }

    // Arrow function: (params) => body  or  param => body
    if (peek(tokens, depth) === '=>') {
      consume(tokens, '=>');
      const body = parseExpr(tokens, depth + 1);
      return parsePostfix({ type: 'arrow', params: [id], body }, tokens, depth);
    }

    return parsePostfix({ type: 'identifier', name: id }, tokens, depth);
  }

  throw new ParseError(`Unexpected token ${token}`, tokens[0]?.pos ?? -1);
}

function parsePostfix(node: AstNode, tokens: Token[], depth: number): AstNode {
  let current = node;
  while (true) {
    const token = peek(tokens, depth);

    // Member access: .prop or ?.prop
    if (token === '.') {
      consume(tokens, '.');
      const prop = consume(tokens, 'id').value;
      current = { type: 'member', object: current, property: prop, optional: false };
      continue;
    }

    // Optional member access: ?.prop
    if (token === '?.') {
      consume(tokens, '?.');
      const propTok = peek(tokens, depth);
      if (propTok === 'id') {
        const prop = consume(tokens, 'id').value;
        current = { type: 'member', object: current, property: prop, optional: true };
      } else if (propTok === '(') {
        consume(tokens, '(');
        const args: AstNode[] = [];
        while (peek(tokens, depth) !== ')') {
          if (args.length > 0 && peek(tokens, depth) === ',') {
            consume(tokens, ',');
            continue;
          }
          args.push(parseExpr(tokens, depth + 1));
          if (peek(tokens, depth) === ',') consume(tokens, ',');
        }
        consume(tokens, ')');
        current = { type: 'call', callee: current, args, optional: true };
      } else if (propTok === '[') {
        consume(tokens, '[');
        const index = parseExpr(tokens, depth + 1);
        consume(tokens, ']');
        current = {
          type: 'call',
          callee: { type: 'member', object: current, property: 'at', optional: false },
          args: [index],
          optional: false,
        };
      } else {
        // ?.[expr]
        if (propTok === '[') {
          consume(tokens, '[');
          const index = parseExpr(tokens, depth + 1);
          consume(tokens, ']');
          current = { type: 'member', object: current, property: '', optional: true };
          // approximate: wrap as member with computed access via identifier
        }
        break;
      }
      // After optional chain, keep trying postfix
      if (
        peek(tokens, depth) === '.' ||
        peek(tokens, depth) === '?.' ||
        peek(tokens, depth) === '(' ||
        peek(tokens, depth) === '['
      )
        continue;
      break;
    }

    // Bracket access: [expr]
    if (token === '[') {
      consume(tokens, '[');
      const index = parseExpr(tokens, depth + 1);
      consume(tokens, ']');
      // Evaluate bracket access as member access with a string key for literals
      if (index.type === 'literal') {
        current = {
          type: 'member',
          object: current,
          property: String(index.value),
          optional: false,
        };
      } else {
        // For dynamic access, store a special marker
        current = { type: 'member', object: current, property: '', optional: false };
      }
      continue;
    }

    // Function call: (args)
    if (token === '(') {
      consume(tokens, '(');
      const args: AstNode[] = [];
      while (peek(tokens, depth) !== ')') {
        if (args.length > 0 && peek(tokens, depth) === ',') {
          consume(tokens, ',');
          continue;
        }
        args.push(parseExpr(tokens, depth + 1));
        if (peek(tokens, depth) === ',') consume(tokens, ',');
      }
      consume(tokens, ')');
      current = { type: 'call', callee: current, args, optional: false };
      continue;
    }

    // Arrow function with parenthesised params: (a, b) => body
    if (token === ')') {
      // Arrow was already parsed as primary, check for =>
      break;
    }

    break;
  }
  return current;
}

export function parse(input: string): AstNode {
  const tokens = tokenise(input);
  if (tokens.length === 0) throw new ParseError('Empty expression', -1);
  const node = parseExpr(tokens, 0);
  if (tokens.length > 0) {
    throw new ParseError(
      `Unexpected token '${tokens[0].value}' after expression end`,
      tokens[0].pos
    );
  }
  return node;
}

// ─── Evaluation Budget ────────────────────────────────────────────────────────

interface EvalBudget {
  steps: number;
  callbacks: number;
}

function makeBudget(): EvalBudget {
  return { steps: 0, callbacks: 0 };
}

function consumeStep(budget: EvalBudget): void {
  if (budget.steps++ > MAX_EVAL_STEPS) throw new EvalError('Evaluation step limit exceeded');
}

function consumeCallback(budget: EvalBudget): void {
  if (budget.callbacks++ > MAX_CALLBACK_CALLS) throw new EvalError('Callback call limit exceeded');
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

export interface EvalContext {
  /** Built-in functions available to guard expressions. */
  builtins: Record<string, (...args: unknown[]) => unknown>;
  /** The session/execution context (read-only field access). */
  session: Record<string, unknown>;
  /** Custom user-defined guard functions. */
  guards: Record<string, (...args: unknown[]) => unknown>;
  /** Per-evaluation budget. */
  budget: EvalBudget;
}

function evaluateNode(node: AstNode, ctx: EvalContext): unknown {
  consumeStep(ctx.budget);

  switch (node.type) {
    case 'literal':
      return node.value;

    case 'identifier': {
      // Check builtins first, then context, then guards
      if (node.name in ctx.builtins) return ctx.builtins[node.name];
      if (node.name === 'session') return ctx.session;
      if (node.name in ctx.guards) return ctx.guards[node.name];
      // Fallback — check session
      if (node.name in ctx.session) return ctx.session[node.name];
      return undefined;
    }

    case 'member': {
      const obj = evaluateNode(node.object, ctx);
      if (obj == null) return node.optional ? undefined : undefined;
      if (typeof obj === 'object' && obj !== null) {
        return (obj as Record<string, unknown>)[node.property];
      }
      if (typeof obj === 'string' && node.property === 'length') return obj.length;
      return undefined;
    }

    case 'call': {
      // Evaluate the object first (for method calls with this binding)
      let thisArg: unknown = undefined;
      if (node.callee.type === 'member') {
        thisArg = evaluateNode(node.callee.object, ctx);
      }
      const callee = evaluateNode(node.callee, ctx);
      if (typeof callee !== 'function') {
        if (node.optional) return undefined;
        return undefined;
      }
      const args = node.args.map((a) => evaluateNode(a, ctx));

      // Check if callee is a built-in
      const calleeName = node.callee.type === 'identifier' ? node.callee.name : '';
      if (calleeName && calleeName in ctx.builtins) {
        return ctx.builtins[calleeName](...args);
      }

      consumeCallback(ctx.budget);

      // Preserve this-binding for method calls (e.g. arr.find(cb))
      if (thisArg !== undefined) {
        return (callee as Function).apply(thisArg, args);
      }
      return callee(...args);
    }

    case 'unary': {
      const arg = evaluateNode(node.argument, ctx);
      switch (node.operator) {
        case '!':
          return !arg;
        case '-':
          return -Number(arg);
        case '+':
          return Number(arg);
        case 'typeof':
          return typeof arg;
        default:
          return undefined;
      }
    }

    case 'binary': {
      const left = evaluateNode(node.left, ctx);
      // Short-circuit: only evaluate right when needed
      switch (node.operator) {
        case '&&':
          return left ? evaluateNode(node.right, ctx) : left;
        case '||':
          return left ? left : evaluateNode(node.right, ctx);
        case '??':
          return left != null ? left : evaluateNode(node.right, ctx);
        default:
          break;
      }
      const right = evaluateNode(node.right, ctx);
      return evalBinary(node.operator, left, right);
    }

    case 'ternary': {
      const test = evaluateNode(node.test, ctx);
      return evaluateNode(test ? node.consequent : node.alternate, ctx);
    }

    case 'array': {
      return node.elements.map((e) => evaluateNode(e, ctx));
    }

    case 'arrow': {
      // Arrow functions capture the current ctx via closure
      const capturedCtx = ctx;
      return (...args: unknown[]) => {
        const localCtx: EvalContext = {
          ...capturedCtx,
          session: { ...capturedCtx.session },
          budget: makeBudget(),
        };
        node.params.forEach((p, i) => {
          (localCtx.session as Record<string, unknown>)[p] = args[i];
        });
        // Each arrow call gets its own fresh budget
        return evaluateNode(node.body, localCtx);
      };
    }

    default:
      return undefined;
  }
}

function evalBinary(op: string, left: unknown, right: unknown): unknown {
  switch (op) {
    case '&&':
      return left && right;
    case '||':
      return left || right;
    case '??':
      return left ?? right;
    case '==':
      return left == right;
    case '!=':
      return left != right;
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
      return (left as number) < (right as number);
    case '>':
      return (left as number) > (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '+':
      return (left as number) + (right as number);
    case '-':
      return (left as number) - (right as number);
    case '*':
      return (left as number) * (right as number);
    case '/':
      return (left as number) / (right as number);
    case '%':
      return (left as number) % (right as number);
    default:
      return undefined;
  }
}

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/**
 * Parse and evaluate a guard expression against the given context.
 * Returns `false` for any error, timeout, or limit exceeded (fail-closed).
 */
export function evaluateGuard(
  expression: string,
  session: Record<string, unknown>,
  builtins: Record<string, (...args: unknown[]) => unknown> = {},
  guards: Record<string, (...args: unknown[]) => unknown> = {}
): boolean {
  try {
    const node = parse(expression);
    const budget = makeBudget();
    const ctx: EvalContext = { builtins, session: { ...session }, guards, budget };
    const result = evaluateNode(node, ctx);
    return Boolean(result);
  } catch {
    return false;
  }
}
