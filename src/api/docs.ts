// ─────────────────────────────────────────────────────────────────────────────
// API docs page — served at /api/v1/docs.
//
// A self-contained, dependency-free HTML page that fetches /api/v1/openapi.json
// and renders it with a small vanilla-JS viewer. No CDN, no build step: it
// honours the single-container / offline constraint and matches the dashboard's
// dark visual language. Public (mounted before the auth gate) so the API is
// documented without signing in.
// ─────────────────────────────────────────────────────────────────────────────

/** Render the standalone docs page. `specUrl` is fetched client-side. */
export function renderDocsPage(opts: { specUrl?: string } = {}): string {
  const specUrl = opts.specUrl ?? "/api/v1/openapi.json";
  // The viewer script is inlined; it fetches the spec and builds the DOM. Kept
  // intentionally compact — it groups operations by tag and renders method,
  // path, summary, params, and the security schemes each operation accepts.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DiffSentry API · Reference</title>
<style>
  :root {
    --bg: #0b0e14; --bg-1: #11151f; --bg-2: #161b27; --line: #232a3a;
    --text: #e6e9f0; --text-2: #aab3c5; --text-3: #6b7488;
    --accent: #6ea8fe; --accent-soft: rgba(110,168,254,0.12);
    --get: #4ec9a8; --post: #d7a65f; --delete: #e06c75; --put: #c586c0;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; }
  header { padding: 30px 28px 22px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, var(--bg-1), var(--bg)); }
  header h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }
  header p { margin: 0; color: var(--text-2); font-size: 13px; max-width: 760px; }
  header .ver { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 5px;
    background: var(--accent-soft); color: var(--accent); font-size: 11px; vertical-align: middle; }
  header .links { margin-top: 14px; font-size: 12.5px; }
  header .links a { color: var(--accent); text-decoration: none; margin-right: 16px; }
  header .links a:hover { text-decoration: underline; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 28px 80px; }
  .tag { margin-top: 30px; }
  .tag > h2 { font-size: 15px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .tag > .desc { color: var(--text-3); font-size: 12.5px; margin: 0 0 12px; }
  .op { border: 1px solid var(--line); border-radius: 10px; background: var(--bg-1);
    margin-bottom: 10px; overflow: hidden; }
  .op-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; }
  .op-head:hover { background: var(--bg-2); }
  .method { font-weight: 700; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 6px; flex-shrink: 0; min-width: 56px; text-align: center; }
  .m-get { background: rgba(78,201,168,0.14); color: var(--get); }
  .m-post { background: rgba(215,166,95,0.16); color: var(--post); }
  .m-delete { background: rgba(224,108,117,0.15); color: var(--delete); }
  .m-put { background: rgba(197,134,192,0.16); color: var(--put); }
  .op-path { font-size: 13px; color: var(--text); }
  .op-summary { color: var(--text-3); font-size: 12.5px; margin-left: auto; text-align: right; }
  .op-body { padding: 0 14px 14px; border-top: 1px solid var(--line); display: none; }
  .op.open .op-body { display: block; }
  .op-body .row { margin-top: 12px; }
  .op-body h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); }
  .op-body p.d { margin: 10px 0 0; color: var(--text-2); font-size: 13px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--text-3); font-weight: 600; }
  td .req { color: var(--delete); font-size: 11px; margin-left: 5px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 5px; background: var(--bg-2);
    border: 1px solid var(--line); color: var(--text-2); font-size: 11px; margin: 0 5px 5px 0; }
  .resp-code { font-weight: 600; }
  .c2 { color: var(--get); } .c4 { color: var(--post); } .c5 { color: var(--delete); }
  .loading, .error { color: var(--text-3); padding: 40px 0; }
  .error { color: var(--delete); }
</style>
</head>
<body>
<header>
  <h1>DiffSentry API <span class="ver" id="ver"></span></h1>
  <p id="desc">Loading the API reference…</p>
  <div class="links">
    <a href="${specUrl}">openapi.json ↗</a>
    <a href="/">← Back to dashboard</a>
  </div>
</header>
<main id="root"><div class="loading">Loading spec…</div></main>
<script>
(function () {
  var SPEC_URL = ${JSON.stringify(specUrl)};
  var METHOD_ORDER = ["get", "post", "put", "delete", "patch"];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderParams(params) {
    if (!params || !params.length) return null;
    var wrap = el("div", "row");
    wrap.appendChild(el("h4", null, "Parameters"));
    var t = el("table");
    var thead = el("tr");
    ["Name", "In", "Type", "Description"].forEach(function (h) { thead.appendChild(el("th", null, h)); });
    t.appendChild(thead);
    params.forEach(function (p) {
      var tr = el("tr");
      var name = el("td", "mono"); name.appendChild(document.createTextNode(p.name || ""));
      if (p.required) { var r = el("span", "req", "required"); name.appendChild(r); }
      tr.appendChild(name);
      tr.appendChild(el("td", null, p.in || ""));
      var schema = p.schema || {};
      var type = schema.type || (schema.$ref ? schema.$ref.split("/").pop() : "");
      if (schema.enum) type = schema.enum.filter(function (x){return x!=null;}).join(" | ");
      tr.appendChild(el("td", "mono", type));
      tr.appendChild(el("td", null, p.description || ""));
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    return wrap;
  }

  function renderResponses(responses) {
    if (!responses) return null;
    var wrap = el("div", "row");
    wrap.appendChild(el("h4", null, "Responses"));
    var t = el("table");
    var thead = el("tr");
    ["Status", "Description"].forEach(function (h) { thead.appendChild(el("th", null, h)); });
    t.appendChild(thead);
    Object.keys(responses).forEach(function (code) {
      var tr = el("tr");
      var cls = "resp-code c" + String(code).charAt(0);
      tr.appendChild(el("td", "mono " + cls, code));
      tr.appendChild(el("td", null, (responses[code] && responses[code].description) || ""));
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    return wrap;
  }

  function renderSecurity(op, topLevel) {
    var sec = op.security !== undefined ? op.security : topLevel;
    var wrap = el("div", "row");
    wrap.appendChild(el("h4", null, "Auth"));
    if (!sec || !sec.length) { wrap.appendChild(el("span", "pill", "public — none")); return wrap; }
    var names = {};
    sec.forEach(function (req) { Object.keys(req).forEach(function (k) { names[k] = true; }); });
    Object.keys(names).forEach(function (n) {
      wrap.appendChild(el("span", "pill", n === "bearerAuth" ? "Bearer token" : n === "cookieAuth" ? "Cookie session" : n));
    });
    return wrap;
  }

  function renderOp(path, method, op, topSecurity) {
    var card = el("div", "op");
    var head = el("div", "op-head");
    head.appendChild(el("span", "method m-" + method, method));
    head.appendChild(el("span", "op-path mono", path));
    head.appendChild(el("span", "op-summary", op.summary || ""));
    card.appendChild(head);
    var body = el("div", "op-body");
    if (op.description) { var d = el("p", "d"); d.textContent = op.description; body.appendChild(d); }
    var sec = renderSecurity(op, topSecurity); if (sec) body.appendChild(sec);
    var params = renderParams(op.parameters); if (params) body.appendChild(params);
    if (op.requestBody) {
      var rb = el("div", "row"); rb.appendChild(el("h4", null, "Request body"));
      rb.appendChild(el("span", "pill", op.requestBody.required ? "required" : "optional"));
      rb.appendChild(el("span", "pill", "application/json"));
      body.appendChild(rb);
    }
    var resp = renderResponses(op.responses); if (resp) body.appendChild(resp);
    card.appendChild(body);
    head.addEventListener("click", function () { card.classList.toggle("open"); });
    return card;
  }

  function render(spec) {
    document.getElementById("ver").textContent = (spec.info && spec.info.version) ? "v" + spec.info.version : "";
    document.getElementById("desc").textContent = (spec.info && spec.info.description) ? spec.info.description : "";
    var root = document.getElementById("root");
    root.innerHTML = "";

    var tags = (spec.tags || []).map(function (t) { return t.name; });
    var byTag = {};
    var paths = spec.paths || {};
    Object.keys(paths).forEach(function (p) {
      var item = paths[p];
      METHOD_ORDER.forEach(function (m) {
        if (!item[m]) return;
        var op = item[m];
        var tag = (op.tags && op.tags[0]) || "other";
        (byTag[tag] = byTag[tag] || []).push({ path: p, method: m, op: op });
      });
    });
    // Preserve declared tag order, then any extras.
    Object.keys(byTag).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); });
    var tagDesc = {};
    (spec.tags || []).forEach(function (t) { tagDesc[t.name] = t.description; });

    tags.forEach(function (tag) {
      var ops = byTag[tag];
      if (!ops || !ops.length) return;
      var section = el("section", "tag");
      section.appendChild(el("h2", null, tag));
      if (tagDesc[tag]) section.appendChild(el("p", "desc", tagDesc[tag]));
      ops.forEach(function (o) { section.appendChild(renderOp(o.path, o.method, o.op, spec.security)); });
      root.appendChild(section);
    });
  }

  fetch(SPEC_URL, { headers: { Accept: "application/json" }, credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById("root").innerHTML = "";
      var err = el("div", "error", "Failed to load the API spec: " + e.message);
      document.getElementById("root").appendChild(err);
    });
})();
</script>
</body>
</html>`;
}
