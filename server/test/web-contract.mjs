/**
 * The web reader's contract. Pure string handling — no network, no database.
 *
 *     npm run test:web
 *
 * The stripping assertions are security assertions, not cosmetic ones: script,
 * style, nav, header and footer are exactly where a page puts text aimed at
 * whoever is reading rather than at the reader of the article.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { htmlToText } = await import(path.join(here, "..", "dist", "pi", "web-tools.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const page = `
<html><head><title>T</title><style>.x{color:red}</style>
<script>alert("INJECTED_BY_SCRIPT")</script></head>
<body>
  <nav>Home About INJECTED_BY_NAV</nav>
  <header>INJECTED_BY_HEADER</header>
  <article><h1>Real Title</h1><p>First paragraph.</p><p>Second paragraph.</p></article>
  <footer>INJECTED_BY_FOOTER</footer>
</body></html>`;

const text = htmlToText(page);
ok("keeps the article text", text.includes("Real Title") && text.includes("First paragraph."));
ok("drops <script>", !text.includes("INJECTED_BY_SCRIPT"));
ok("drops <style>", !text.includes("color:red"));
ok("drops <nav>", !text.includes("INJECTED_BY_NAV"));
ok("drops <header>", !text.includes("INJECTED_BY_HEADER"));
ok("drops <footer>", !text.includes("INJECTED_BY_FOOTER"));
ok("leaves no tags behind", !/<[a-z/][^>]*>/i.test(text));

ok("drops comments", !htmlToText("<p>ok</p><!-- INJECTED_BY_COMMENT -->").includes("INJECTED_BY_COMMENT"));
ok("decodes entities", htmlToText("<p>a &amp; b &lt;c&gt; &#65;</p>") === "a & b <c> A");
ok("block tags become line breaks", htmlToText("<p>one</p><p>two</p>").split("\n").length === 2);
ok("collapses blank lines", !/\n\s*\n/.test(htmlToText("<div>a</div>\n\n\n<div>b</div>")));
ok("empty input is safe", htmlToText("") === "");

// Without <article>/<main> the whole body is read, still stripped.
const bare = htmlToText("<body><script>BAD</script><p>plain page</p></body>");
ok("no article tag falls back to the body", bare.includes("plain page") && !bare.includes("BAD"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
