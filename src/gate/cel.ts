/**
 * A bounded CEL subset — enough to express real egress rules, small enough that the reference gate
 * evaluates it *identically* to Claw Patrol, which is what lets us emit the same `condition` string
 * verbatim into Claw Patrol config and diff verdicts (see {@link "./corpus.ts"}). Anything outside
 * the subset is a parse error, so we never author a condition the reference gate can't evaluate.
 *
 * Grammar (lowest precedence first):
 *   expr    := or
 *   or      := and ("||" and)*
 *   and     := unary ("&&" unary)*
 *   unary   := "!" unary | primary
 *   primary := "(" expr ")" | term
 *   term    := operand (("==" | "!=") operand)?      // no operator ⇒ operand must be bool
 *   operand := STRING | selector ("(" STRING ")")?   // trailing (…) ⇒ method call
 *   selector := IDENT ("." IDENT)*                    // last IDENT may be startsWith|contains|matches
 *
 * Fact selectors: `http.method` `http.path` `http.query` `http.header.<name>` `http.body_json.<k>…`
 * `sql.statement` `sql.verb` `sql.tables` `k8s.verb` `k8s.resource` `k8s.namespace` `k8s.name`
 * `ssh.verb` `ssh.command`. Missing selectors read as the empty string (lists as empty).
 */

import type { ActionFacts } from "./facts.ts";

const METHODS = new Set(["startsWith", "contains", "matches"]);

type Value = string | string[];

// ── tokenizer ──────────────────────────────────────────────────────────────

type Tok =
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: "==" | "!=" | "&&" | "||" | "!" | "(" | ")" | "." };

export class CelError extends Error {
  constructor(message: string) {
    super(`condition: ${message}`);
    this.name = "CelError";
  }
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          s += src[i + 1];
          i += 2;
        } else {
          s += src[i];
          i++;
        }
      }
      if (src[i] !== c) throw new CelError("unterminated string literal");
      i++;
      toks.push({ k: "str", v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "&&" || two === "||") {
      toks.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "!" || c === "(" || c === ")" || c === ".") {
      toks.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = "";
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        s += src[i];
        i++;
      }
      toks.push({ k: "id", v: s });
      continue;
    }
    throw new CelError(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

// ── parser + evaluator (interprets against facts in one pass) ────────────────

class Parser {
  #toks: Tok[];
  #pos = 0;
  #facts: ActionFacts;

  constructor(toks: Tok[], facts: ActionFacts) {
    this.#toks = toks;
    this.#facts = facts;
  }

  #peek(): Tok | undefined {
    return this.#toks[this.#pos];
  }

  #eat(): Tok {
    const t = this.#toks[this.#pos++];
    if (!t) throw new CelError("unexpected end of expression");
    return t;
  }

  #expectOp(v: string): void {
    const t = this.#eat();
    if (t.k !== "op" || t.v !== v) throw new CelError(`expected ${JSON.stringify(v)}`);
  }

  parse(): boolean {
    const v = this.#or();
    if (this.#pos !== this.#toks.length) throw new CelError("trailing tokens");
    return v;
  }

  #or(): boolean {
    let v = this.#and();
    while (this.#peek()?.k === "op" && (this.#peek() as { v: string }).v === "||") {
      this.#eat();
      v = this.#and() || v; // evaluate RHS (no short-circuit; conditions are pure)
    }
    return v;
  }

  #and(): boolean {
    let v = this.#unary();
    while (this.#peek()?.k === "op" && (this.#peek() as { v: string }).v === "&&") {
      this.#eat();
      v = this.#unary() && v;
    }
    return v;
  }

  #unary(): boolean {
    if (this.#peek()?.k === "op" && (this.#peek() as { v: string }).v === "!") {
      this.#eat();
      return !this.#unary();
    }
    return this.#primary();
  }

  #primary(): boolean {
    const t = this.#peek();
    if (t?.k === "op" && t.v === "(") {
      this.#eat();
      const v = this.#or();
      this.#expectOp(")");
      return v;
    }
    return this.#term();
  }

  #term(): boolean {
    const left = this.#operand();
    const t = this.#peek();
    if (t?.k === "op" && (t.v === "==" || t.v === "!=")) {
      this.#eat();
      const right = this.#operand();
      const eq = toStr(left.value) === toStr(right.value);
      return t.v === "==" ? eq : !eq;
    }
    if (left.bool !== undefined) return left.bool;
    throw new CelError("expected a comparison or method call");
  }

  #operand(): { value: Value; bool?: boolean } {
    const t = this.#eat();
    if (t.k === "str") return { value: t.v };
    if (t.k !== "id") throw new CelError("expected a value");

    if (t.v === "true") return { value: "true", bool: true };
    if (t.v === "false") return { value: "false", bool: false };

    const segs = [t.v];
    while (this.#peek()?.k === "op" && (this.#peek() as { v: string }).v === ".") {
      // A "." may separate a path segment OR precede a method call.
      const save = this.#pos;
      this.#eat(); // "."
      const next = this.#eat();
      if (next.k !== "id") throw new CelError("expected identifier after '.'");
      if (
        METHODS.has(next.v) && this.#peek()?.k === "op" &&
        (this.#peek() as { v: string }).v === "("
      ) {
        this.#expectOp("(");
        const arg = this.#eat();
        if (arg.k !== "str") throw new CelError(`${next.v}() takes a string argument`);
        this.#expectOp(")");
        const target = this.#resolve(segs);
        return { value: "", bool: callMethod(next.v, target, arg.v) };
      }
      segs.push(next.v);
      void save;
    }
    return { value: this.#resolve(segs) };
  }

  #resolve(path: string[]): Value {
    return resolveSelector(path, this.#facts);
  }
}

function callMethod(method: string, target: Value, arg: string): boolean {
  if (method === "startsWith") return asStrings(target).some((s) => s.startsWith(arg));
  if (method === "contains") {
    return Array.isArray(target) ? target.includes(arg) : String(target).includes(arg);
  }
  if (method === "matches") {
    const re = new RegExp(arg);
    return asStrings(target).some((s) => re.test(s));
  }
  throw new CelError(`unknown method ${method}`);
}

function asStrings(v: Value): string[] {
  return Array.isArray(v) ? v : [v];
}

function toStr(v: Value): string {
  return Array.isArray(v) ? v.join(",") : v;
}

function resolveSelector(path: string[], facts: ActionFacts): Value {
  const [root, ...rest] = path;
  if (root === "http" && facts.http) {
    const h = facts.http;
    if (rest[0] === "method") return h.method ?? "";
    if (rest[0] === "path") return h.path ?? "";
    if (rest[0] === "query") return h.query ?? "";
    if (rest[0] === "header") {
      const name = rest[1]?.toLowerCase();
      for (const [k, v] of Object.entries(h.headers ?? {})) {
        if (k.toLowerCase() === name) return Array.isArray(v) ? (v[0] ?? "") : v;
      }
      return "";
    }
    if (rest[0] === "body_json") {
      try {
        let node: unknown = JSON.parse(h.body ?? "null");
        for (const seg of rest.slice(1)) {
          node = node && typeof node === "object"
            ? (node as Record<string, unknown>)[seg]
            : undefined;
        }
        return node == null ? "" : String(node);
      } catch {
        return "";
      }
    }
  }
  if (root === "sql" && facts.sql) {
    if (rest[0] === "statement") return facts.sql.statement ?? "";
    if (rest[0] === "verb") return facts.sql.verb ?? "";
    if (rest[0] === "tables") return facts.sql.tables ?? [];
  }
  if (root === "k8s" && facts.k8s) {
    const v = (facts.k8s as unknown as Record<string, unknown>)[rest[0]];
    return typeof v === "string" ? v : "";
  }
  if (root === "ssh" && facts.ssh) {
    const v = (facts.ssh as unknown as Record<string, unknown>)[rest[0]];
    return typeof v === "string" ? v : "";
  }
  return "";
}

/** Evaluate a CEL-subset condition against a request's facts. Throws {@link CelError} on syntax. */
export function evaluateCondition(condition: string, facts: ActionFacts): boolean {
  return new Parser(tokenize(condition), facts).parse();
}

/** Parse-check a condition without facts; returns an error message, or null if it is in-subset. */
export function checkCondition(condition: string): string | null {
  try {
    new Parser(tokenize(condition), { host: "" }).parse();
    return null;
  } catch (e) {
    return e instanceof CelError ? e.message : String(e);
  }
}
