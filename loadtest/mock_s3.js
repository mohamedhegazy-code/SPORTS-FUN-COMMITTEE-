// A fake S3 / Cloudflare R2 bucket for tests: checks every request's AWS signature with its own code.
"use strict";
const http = require("http"), crypto = require("crypto");
const KEY_ID = "TESTKEYID1234567890", SECRET = "s3cr3t/Test+Key/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", BUCKET = "ahlawy-backups";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---------------------------------------------------------------- fake bucket with independent signature check
function makeBucket() {
  const objects = new Map(); // key -> Buffer
  const state = { sigOk: 0, sigBad: 0, requests: [], failPut: 0, truncate: false, putDelay: 0, secret: SECRET };
  const H = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const uriEnc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  function verify(req, url) {
    const a = req.headers.authorization || "";
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(a);
    if (!m) return false;
    const [, kid, date, region, signed, sig] = m;
    if (kid !== KEY_ID) return false;
    const amzDate = req.headers["x-amz-date"];
    if (!amzDate || amzDate.slice(0, 8) !== date) return false;
    if (Math.abs(Date.now() - Date.parse(amzDate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"))) > 5 * 60 * 1000) return false;
    const names = signed.split(";");
    if (!names.includes("host") || !names.includes("x-amz-date") || !names.includes("x-amz-content-sha256")) return false;
    const ch = names.map((n) => `${n}:${String(req.headers[n] === undefined ? "" : req.headers[n]).trim()}\n`).join("");
    const qs = [...url.searchParams.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([k, v]) => `${uriEnc(k)}=${uriEnc(v)}`).join("&");
    const canonical = [req.method, url.pathname, qs, ch, signed, req.headers["x-amz-content-sha256"]].join("\n");
    const sts = ["AWS4-HMAC-SHA256", amzDate, `${date}/${region}/s3/aws4_request`, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
    const kS = H(H(H(H("AWS4" + state.secret, date), region), "s3"), "aws4_request");
    return crypto.createHmac("sha256", kS).update(sts).digest("hex") === sig;
  }
  const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, text, headers = {}) => { res.writeHead(code, { "content-type": "application/xml", ...headers }); res.end(text); };
    if (!verify(req, url)) { state.sigBad++; return send(403, "<Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>"); }
    state.sigOk++;
    const m = /^\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m || decodeURIComponent(m[1]) !== BUCKET) return send(404, "<Error><Code>NoSuchBucket</Code></Error>");
    const key = m[2] ? decodeURIComponent(m[2]) : null;
    if (req.method === "PUT" && key) {
      if (state.failPut > 0) { state.failPut--; return send(500, "<Error><Code>InternalError</Code></Error>"); }
      if (state.putDelay) await sleep(state.putDelay);
      objects.set(key, state.truncate ? body.subarray(0, Math.floor(body.length / 2)) : body);
      return send(200, "");
    }
    if (req.method === "HEAD" && key) { const o = objects.get(key); if (!o) return send(404, ""); res.writeHead(200, { "content-length": o.length }); return res.end(); }
    if (req.method === "GET" && key) { const o = objects.get(key); if (!o) return send(404, "<Error><Code>NoSuchKey</Code></Error>"); res.writeHead(200, { "content-length": o.length, "content-type": "application/zip" }); return res.end(o); }
    if (req.method === "DELETE" && key) { objects.delete(key); return send(204, ""); }
    if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      const pfx = url.searchParams.get("prefix") || "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(pfx)).sort();
      return send(200, `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${xmlEsc(k)}</Key><LastModified>2026-11-27T00:00:00.000Z</LastModified><Size>${objects.get(k).length}</Size></Contents>`).join("")}</ListBucketResult>`);
    }
    send(400, "<Error><Code>Unsupported</Code></Error>");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, objects, state, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { makeBucket, KEY_ID, SECRET, BUCKET };
