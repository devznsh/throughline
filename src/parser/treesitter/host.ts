import { readFile } from 'node:fs/promises';
import Parser from 'web-tree-sitter';
import type { LanguageId } from '../../config/schema.js';
import { SymbolKind, type Range } from '../../core/model/index.js';
import type { ParsedFile, RawImport, RawReference, RawSymbol } from '../../core/ports/index.js';
import { ParseError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';
import { redactSecrets } from '../../shared/redact.js';

/**
 * The tree-sitter host.
 *
 * Fifteen languages × a bespoke AST walker each is fifteen things to keep
 * correct as grammars evolve. Instead every language ships a `.scm` query file
 * using one shared capture vocabulary, and this single runner turns captures
 * into the language-neutral IR. Adding a language becomes: vendor a grammar,
 * write a query, optionally add an import resolver.
 *
 * Capture vocabulary (see `src/parser/queries/*.scm`):
 *
 *   @definition.<kind>   the whole definition node — kind maps to SymbolKind
 *   @name                the identifier inside a definition
 *   @reference.<kind>    a call / extends / implements / instantiation
 *   @reference.receiver  the receiver of a member call, e.g. `redis` in redis.get()
 *   @import.statement    an import/require/use declaration
 *   @import.source       the string or path inside it
 *
 * Doc comments and complexity are computed programmatically rather than by
 * query. Comment attachment differs enough between grammars that expressing it
 * as a query per language reintroduces exactly the per-language logic this
 * design exists to avoid.
 */

export interface GrammarSpec {
  readonly id: LanguageId;
  /** Absolute path to the `.wasm` grammar. */
  readonly wasmPath: string;
  /** Absolute path to the `.scm` query file. */
  readonly queryPath: string;
  /**
   * Node types that introduce a branch, used for cyclomatic complexity.
   * Grammar-specific because node naming is not standardised.
   */
  readonly branchNodeTypes: readonly string[];
  /** Node types whose presence means the symbol is exported/public. */
  readonly exportMarkers: readonly string[];
  readonly commentNodeTypes: readonly string[];
}

const CAPTURE_KIND: Readonly<Record<string, SymbolKind>> = {
  'definition.function': SymbolKind.Function,
  'definition.method': SymbolKind.Method,
  'definition.class': SymbolKind.Class,
  'definition.interface': SymbolKind.Interface,
  'definition.struct': SymbolKind.Struct,
  'definition.enum': SymbolKind.Enum,
  'definition.type': SymbolKind.TypeAlias,
  'definition.constant': SymbolKind.Constant,
  'definition.variable': SymbolKind.Variable,
  'definition.property': SymbolKind.Property,
  'definition.field': SymbolKind.Field,
  'definition.constructor': SymbolKind.Constructor,
  'definition.module': SymbolKind.Module,
  'definition.namespace': SymbolKind.Namespace,
  'definition.table': SymbolKind.Table,
  'definition.resource': SymbolKind.Resource,
};

const REFERENCE_KIND: Readonly<Record<string, RawReference['kind']>> = {
  'reference.call': 'call',
  'reference.extends': 'extends',
  'reference.implements': 'implements',
  'reference.instantiate': 'instantiate',
  'reference.class': 'reference',
};

type SyntaxNode = Parser.SyntaxNode;

let initialized = false;

/** Initialises the WASM runtime once per worker thread. */
export async function initializeTreeSitter(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

export class TreeSitterParser {
  readonly spec: GrammarSpec;
  #parser: Parser | null = null;
  #query: Parser.Query | null = null;
  readonly #branchTypes: ReadonlySet<string>;

  constructor(spec: GrammarSpec) {
    this.spec = spec;
    this.#branchTypes = new Set(spec.branchNodeTypes);
  }

  get id(): LanguageId {
    return this.spec.id;
  }

  async load(): Promise<void> {
    if (this.#parser !== null) return;
    await initializeTreeSitter();

    // Each failure mode names the file it could not use. A bare "load failed"
    // makes a missing query indistinguishable from a corrupt grammar, and both
    // indistinguishable from an unsupported language.
    let language: Parser.Language;
    try {
      language = await Parser.Language.load(this.spec.wasmPath);
    } catch (cause: unknown) {
      throw new ParseError(
        `grammar not loadable at ${this.spec.wasmPath} (run \`npm run grammars\`)`,
        { cause },
      );
    }

    let querySource: string;
    try {
      querySource = await readFile(this.spec.queryPath, 'utf8');
    } catch (cause: unknown) {
      throw new ParseError(
        `query file missing at ${this.spec.queryPath} (run \`npm run build\`, which copies .scm files into dist)`,
        { cause },
      );
    }

    const parser = new Parser();
    parser.setLanguage(language);

    try {
      this.#query = language.query(querySource);
    } catch (cause: unknown) {
      throw new ParseError(`query file ${this.spec.queryPath} is not valid for this grammar`, {
        cause,
      });
    }
    this.#parser = parser;
  }

  parse(relPath: string, source: string): Result<ParsedFile> {
    const parser = this.#parser;
    const query = this.#query;
    if (parser === null || query === null) {
      return err(new ParseError(`Grammar for ${this.spec.id} was not loaded.`));
    }

    let tree: Parser.Tree;
    try {
      // A hard cap protects against pathological single-line minified files that
      // can make tree-sitter allocate unboundedly.
      tree = parser.parse(source.length > 4_000_000 ? source.slice(0, 4_000_000) : source);
    } catch (cause: unknown) {
      return err(new ParseError(`Failed to parse ${relPath}.`, { cause }));
    }

    try {
      const lines = source.split('\n');
      const captures = query.captures(tree.rootNode);

      const symbols = this.#extractSymbols(captures, lines);
      const references = this.#extractReferences(captures, symbols);
      const imports = extractImports(captures);
      const chunkRanges = buildChunkRanges(symbols, lines.length);

      return ok({
        relPath,
        language: this.spec.id,
        symbols,
        references,
        imports,
        chunkRanges,
        hadSyntaxErrors: tree.rootNode.hasError,
      });
    } finally {
      tree.delete();
    }
  }

  #extractSymbols(captures: readonly Parser.QueryCapture[], lines: readonly string[]): RawSymbol[] {
    const definitions = captures.filter((capture) => capture.name in CAPTURE_KIND);
    const names = new Map<number, SyntaxNode>();
    for (const capture of captures) {
      if (capture.name === 'name') {
        names.set(capture.node.startIndex, capture.node);
      }
    }

    const symbols: RawSymbol[] = [];
    // Sorting by start offset means a container is always emitted before the
    // members it encloses, which is what makes single-pass qualification work.
    const sorted = [...definitions].sort((a, b) => a.node.startIndex - b.node.startIndex);
    const containerStack: { end: number; qualifiedName: string }[] = [];

    for (const capture of sorted) {
      const kind = CAPTURE_KIND[capture.name];
      if (kind === undefined) continue;

      const node = capture.node;
      const nameNode = findNameNode(node, names);
      const name = nameNode?.text ?? anonymousName(node, kind);
      if (name.length === 0) continue;

      while (containerStack.length > 0) {
        const top = containerStack[containerStack.length - 1];
        if (top !== undefined && top.end <= node.startIndex) containerStack.pop();
        else break;
      }

      const container = containerStack[containerStack.length - 1]?.qualifiedName ?? null;
      const qualifiedName = container === null ? name : `${container}.${name}`;

      symbols.push({
        name,
        kind,
        range: toRange(node),
        container,
        signature: this.#signatureOf(node, lines),
        docComment: this.#docCommentAbove(node, lines),
        isExported: this.#isExported(node),
        isAsync: /\basync\b/.test(firstLineOf(node, lines)),
        visibility: visibilityOf(node, name),
        complexity: this.#complexityOf(node),
      });

      if (isContainerKind(kind)) {
        containerStack.push({ end: node.endIndex, qualifiedName });
      }
    }

    return symbols;
  }

  #extractReferences(
    captures: readonly Parser.QueryCapture[],
    symbols: readonly RawSymbol[],
  ): RawReference[] {
    const receivers = new Map<number, string>();
    for (const capture of captures) {
      if (capture.name === 'reference.receiver') {
        receivers.set(capture.node.endIndex, capture.node.text);
      }
    }

    const references: RawReference[] = [];
    for (const capture of captures) {
      const kind = REFERENCE_KIND[capture.name];
      if (kind === undefined) continue;

      const node = capture.node;
      const line = node.startPosition.row + 1;
      const name = lastIdentifierOf(node.text);
      if (name.length === 0) continue;

      references.push({
        name,
        kind,
        line,
        fromSymbol: enclosingSymbolName(symbols, line),
        receiver: receivers.get(node.startIndex) ?? receiverOf(node),
      });
    }
    return references;
  }

  /** First line of the definition, trimmed and truncated — enough to show a signature. */
  #signatureOf(node: SyntaxNode, lines: readonly string[]): string {
    const raw = firstLineOf(node, lines).trim();
    const withoutBrace = raw.replace(/\s*[{:]\s*$/, '');
    const clipped = withoutBrace.length > 240 ? `${withoutBrace.slice(0, 237)}…` : withoutBrace;
    return redactSecrets(clipped).text;
  }

  /**
   * Walks upward from the definition collecting contiguous comment lines.
   * Grammars disagree about whether a comment is a sibling, a child, or
   * unattached, so this works on the line grid instead of the tree.
   */
  #docCommentAbove(node: SyntaxNode, lines: readonly string[]): string | null {
    let row = node.startPosition.row - 1;
    const collected: string[] = [];

    while (row >= 0 && collected.length < 40) {
      const line = lines[row];
      if (line === undefined) break;
      const trimmed = line.trim();
      if (trimmed.length === 0 && collected.length === 0) {
        row -= 1;
        continue;
      }
      if (!isCommentLine(trimmed)) break;
      collected.unshift(stripCommentSyntax(trimmed));
      row -= 1;
    }

    const text = collected.join('\n').trim();
    if (text.length === 0) return null;
    return redactSecrets(text.length > 1200 ? `${text.slice(0, 1197)}…` : text).text;
  }

  #isExported(node: SyntaxNode): boolean {
    // Explicit export syntax on an ancestor (TS `export`, Rust `pub`).
    let current: SyntaxNode | null = node.parent;
    for (let depth = 0; current !== null && depth < 3; depth += 1) {
      if (this.spec.exportMarkers.includes(current.type)) return true;
      current = current.parent;
    }
    for (const child of node.children) {
      if (this.spec.exportMarkers.includes(child.type)) return true;
    }
    return false;
  }

  /**
   * Cyclomatic complexity: one plus the number of branch nodes inside the
   * definition. Used only for ranking — a bigger, branchier function is more
   * likely to be the one someone means by "the payment logic" — so an
   * approximation is fine and a full control-flow analysis would not be.
   */
  #complexityOf(node: SyntaxNode): number {
    let count = 1;
    const stack: SyntaxNode[] = [node];
    let visited = 0;

    while (stack.length > 0 && visited < 20_000) {
      const current = stack.pop();
      if (current === undefined) break;
      visited += 1;
      if (current !== node && this.#branchTypes.has(current.type)) count += 1;
      for (let i = 0; i < current.namedChildCount; i += 1) {
        const child = current.namedChild(i);
        if (child !== null) stack.push(child);
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRange(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

function firstLineOf(node: SyntaxNode, lines: readonly string[]): string {
  return lines[node.startPosition.row] ?? '';
}

function findNameNode(node: SyntaxNode, names: ReadonlyMap<number, SyntaxNode>): SyntaxNode | null {
  // Prefer a `name` capture that falls inside this definition.
  for (const [offset, candidate] of names) {
    if (offset >= node.startIndex && offset < node.endIndex) return candidate;
  }
  return node.childForFieldName('name');
}

function anonymousName(node: SyntaxNode, kind: SymbolKind): string {
  return `<anonymous ${kind} @${String(node.startPosition.row + 1)}>`;
}

function isContainerKind(kind: SymbolKind): boolean {
  return (
    kind === SymbolKind.Class ||
    kind === SymbolKind.Interface ||
    kind === SymbolKind.Struct ||
    kind === SymbolKind.Enum ||
    kind === SymbolKind.Namespace ||
    kind === SymbolKind.Module
  );
}

function visibilityOf(node: SyntaxNode, name: string): RawSymbol['visibility'] {
  const text = node.text.slice(0, 80);
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  if (/\binternal\b/.test(text)) return 'internal';
  // Leading underscore is the convention in Python and JavaScript; Go uses a
  // lowercase initial for package-private.
  if (name.startsWith('_') || name.startsWith('#')) return 'private';
  return 'public';
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''") ||
    trimmed.startsWith('--')
  );
}

function stripCommentSyntax(trimmed: string): string {
  return trimmed
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\/\/+/, '')
    .replace(/^#+/, '')
    .replace(/^\*+/, '')
    .replace(/^--+/, '')
    .replace(/^["']{3}/, '')
    .replace(/["']{3}$/, '')
    .trim();
}

function lastIdentifierOf(text: string): string {
  const match = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(text.trim());
  if (match?.[1] !== undefined) return match[1];
  const fallback = /([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text);
  return fallback?.[1] ?? '';
}

function receiverOf(node: SyntaxNode): string | null {
  const text = node.text;
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\./.exec(text);
  return match?.[1] ?? null;
}

function enclosingSymbolName(symbols: readonly RawSymbol[], line: number): string | null {
  let best: RawSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.range.startLine <= line && symbol.range.endLine >= line) {
      if (
        best === null ||
        symbol.range.endLine - symbol.range.startLine < best.range.endLine - best.range.startLine
      ) {
        best = symbol;
      }
    }
  }
  if (best === null) return null;
  return best.container === null ? best.name : `${best.container}.${best.name}`;
}

function extractImports(captures: readonly Parser.QueryCapture[]): RawImport[] {
  const sources = captures.filter((capture) => capture.name === 'import.source');
  const imports: RawImport[] = [];

  for (const capture of sources) {
    const specifier = capture.node.text.replace(/^["'`]|["'`]$/g, '').trim();
    if (specifier.length === 0) continue;

    const statement = capture.node.parent?.parent ?? capture.node.parent;
    const statementText = statement?.text ?? '';

    imports.push({
      specifier,
      symbols: namedImportsOf(statementText),
      isTypeOnly: /\bimport\s+type\b|\bfrom\s+typing\b/.test(statementText),
      line: capture.node.startPosition.row + 1,
    });
  }
  return imports;
}

function namedImportsOf(statementText: string): string[] {
  const braced = /\{([^}]*)\}/.exec(statementText);
  if (braced?.[1] !== undefined) {
    return braced[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((part) => part.length > 0 && /^[A-Za-z_$]/.test(part));
  }
  const pythonStyle = /\bimport\s+([A-Za-z_][\w,\s]*)$/m.exec(statementText);
  if (pythonStyle?.[1] !== undefined) {
    return pythonStyle[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [];
}

/**
 * Retrieval chunks are symbol-aligned. Returning half a function is worse than
 * returning nothing: it looks authoritative and is wrong. Oversized symbols are
 * split on line boundaries with overlap so a match near a seam still surfaces
 * usable context.
 */
function buildChunkRanges(
  symbols: readonly RawSymbol[],
  totalLines: number,
): { startLine: number; endLine: number; symbol: string | null }[] {
  const MAX_CHUNK_LINES = 120;
  const OVERLAP = 10;
  const ranges: { startLine: number; endLine: number; symbol: string | null }[] = [];

  const topLevel = symbols.filter((symbol) => symbol.container === null);
  for (const symbol of topLevel) {
    const { startLine, endLine } = symbol.range;
    const qualified = symbol.name;

    if (endLine - startLine + 1 <= MAX_CHUNK_LINES) {
      ranges.push({ startLine, endLine, symbol: qualified });
      continue;
    }
    for (let start = startLine; start <= endLine; start += MAX_CHUNK_LINES - OVERLAP) {
      ranges.push({
        startLine: start,
        endLine: Math.min(start + MAX_CHUNK_LINES - 1, endLine),
        symbol: qualified,
      });
    }
  }

  // A file with no extractable symbols — a config file, a template — still needs
  // to be searchable, so fall back to fixed windows.
  if (ranges.length === 0 && totalLines > 0) {
    for (let start = 1; start <= totalLines; start += MAX_CHUNK_LINES) {
      ranges.push({
        startLine: start,
        endLine: Math.min(start + MAX_CHUNK_LINES - 1, totalLines),
        symbol: null,
      });
    }
  }

  return ranges;
}
