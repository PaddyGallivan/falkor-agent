var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" };
var ASGARD_URL = "https://asgard.pgallivan.workers.dev";
var THOR_URL = "https://thor.pgallivan.workers.dev";
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health" || url.pathname === "/ping") {
      return json({ ok: true, worker: "falkor-agent", version: "4.0", redirects_to: ASGARD_URL, ts: /* @__PURE__ */ new Date() });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/ask") {
      const targetUrl = THOR_URL + url.pathname + url.search;
      try {
        const r = await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" ? request.body : void 0
        });
        return new Response(r.body, { status: r.status, headers: { ...CORS, ...Object.fromEntries(r.headers) } });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    return Response.redirect(ASGARD_URL, 302);
  }
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map