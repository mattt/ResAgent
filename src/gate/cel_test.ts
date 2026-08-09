import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { checkCondition, evaluateCondition } from "./cel.ts";
import type { ActionFacts } from "./facts.ts";

const http = (
  method: string,
  path: string,
  extra: Partial<ActionFacts["http"]> = {},
): ActionFacts => ({
  host: "example.com",
  http: { method, path, ...extra },
});

Deno.test("cel: equality and inequality over http facts", () => {
  assert(evaluateCondition('http.method == "GET"', http("GET", "/")));
  assert(!evaluateCondition('http.method == "GET"', http("POST", "/")));
  assert(evaluateCondition('http.method != "GET"', http("POST", "/")));
});

Deno.test("cel: single-quoted literals parse too (CEL accepts both)", () => {
  assert(evaluateCondition("http.method == 'GET'", http("GET", "/")));
});

Deno.test("cel: string method calls", () => {
  assert(evaluateCondition('http.path.startsWith("/repos")', http("GET", "/repos/x")));
  assert(!evaluateCondition('http.path.startsWith("/repos")', http("GET", "/orgs")));
  assert(evaluateCondition('http.path.contains("delete")', http("POST", "/x/delete/y")));
  assert(evaluateCondition('http.path.matches("^/v[0-9]+/")', http("GET", "/v2/models")));
});

Deno.test("cel: boolean composition and precedence", () => {
  const f = http("POST", "/admin");
  assert(evaluateCondition('http.method == "POST" && http.path == "/admin"', f));
  assert(!evaluateCondition('http.method == "GET" && http.path == "/admin"', f));
  assert(evaluateCondition('http.method == "GET" || http.path == "/admin"', f));
  assert(evaluateCondition('!(http.method == "GET")', f));
  // && binds tighter than ||: false && false || true  ⇒ true
  assert(
    evaluateCondition(
      'http.method == "GET" && http.path == "/x" || http.path == "/admin"',
      f,
    ),
  );
});

Deno.test("cel: header lookup is case-insensitive", () => {
  const f = http("GET", "/", { headers: { "Authorization": "Bearer z" } });
  assert(evaluateCondition('http.header.authorization.startsWith("Bearer")', f));
});

Deno.test("cel: body_json access", () => {
  const f = http("POST", "/", {
    body: JSON.stringify({ action: "drop", nested: { k: "v" } }),
  });
  assert(evaluateCondition('http.body_json.action == "drop"', f));
  assert(evaluateCondition('http.body_json.nested.k == "v"', f));
});

Deno.test("cel: sql and k8s facets", () => {
  const sql: ActionFacts = {
    host: "db",
    sql: { statement: "DROP TABLE users", verb: "DROP", tables: ["users"] },
  };
  assert(evaluateCondition('sql.verb == "DROP"', sql));
  assert(evaluateCondition('sql.tables.contains("users")', sql));
  assert(!evaluateCondition('sql.tables.contains("orders")', sql));

  const k8s: ActionFacts = {
    host: "k",
    k8s: { verb: "delete", resource: "secrets", namespace: "prod" },
  };
  assert(evaluateCondition('k8s.resource == "secrets"', k8s));
  assert(evaluateCondition('k8s.verb == "delete" && k8s.namespace == "prod"', k8s));
});

Deno.test("cel: missing selectors read as empty string", () => {
  assert(evaluateCondition('http.query == ""', http("GET", "/")));
  assert(!evaluateCondition('http.query == "x"', http("GET", "/")));
});

Deno.test("cel: syntax errors are rejected", () => {
  assertThrows(() => evaluateCondition("http.method =", http("GET", "/")));
  assertThrows(() => evaluateCondition('http.method == "GET" &&', http("GET", "/")));
  assertThrows(() => evaluateCondition('(http.method == "GET"', http("GET", "/")));
});

Deno.test("cel: checkCondition returns null for valid, a message for invalid", () => {
  assertEquals(checkCondition('http.method == "GET"'), null);
  assert(checkCondition("http.method ==") !== null);
});
