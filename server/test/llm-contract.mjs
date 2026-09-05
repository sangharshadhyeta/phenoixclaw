/**
 * The local-model client's contract — the parsing and degradation rules, not
 * the model.
 *
 *     npm run test:llm
 *
 * No network. Every assertion here is about a response shape that actually
 * came back from the llama-server during this port, including the one that
 * silently disabled the whole ingest pipeline.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseJsonArray } = await import(path.join(here, "..", "dist", "llm.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

ok("plain array", JSON.stringify(parseJsonArray('["a","b"]')) === '["a","b"]');

// What the model actually returns once thinking is off: fenced, with a label.
ok("fenced in a code block",
   JSON.stringify(parseJsonArray('```json\n[\n  "DuckDB is a database"\n]\n```')) === '["DuckDB is a database"]');
ok("prose before the array",
   JSON.stringify(parseJsonArray('Here are the propositions:\n["one","two"]')) === '["one","two"]');
ok("prose after the array",
   JSON.stringify(parseJsonArray('["one"]\nThat is all of them.')) === '["one"]');
ok("array of objects",
   (parseJsonArray('[{"name":"DuckDB","type":"concept"}]') ?? [])[0]?.name === "DuckDB");
ok("nested brackets survive the outermost-bracket rule",
   JSON.stringify(parseJsonArray('[{"a":[1,2]},{"b":[3]}]')) === '[{"a":[1,2]},{"b":[3]}]');

ok("undefined input", parseJsonArray(undefined) === undefined);
ok("empty string", parseJsonArray("") === undefined);
ok("no array at all", parseJsonArray("I could not do that.") === undefined);
ok("an object is not an array", parseJsonArray('{"a":1}') === undefined);
ok("malformed json", parseJsonArray('["unterminated') === undefined);
ok("brackets in the wrong order", parseJsonArray("] not an array [") === undefined);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
