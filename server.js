import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 3010;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

// ----- branded customer portal -----
// Manager's own customer portal cannot use custom themes. These pages fetch the same public
// portal page from Manager and hand it on restyled (portal.css). Only Manager's portal pages
// can be requested, and only with the customer's own link token, exactly as on Manager itself.
const MANAGER = (process.env.MANAGER_URL || "https://finance360.laitor.co.ke").replace(/\/$/, "");
const PORTAL_PAGE = /^customer-portal(-(quotes|orders|invoices|credit-notes|delivery-notes|quote|order|invoice|credit-note|delivery-note))?$/;
const PORTAL_TOKEN = /^[A-Za-z0-9_-]{20,300}$/;
const INTERNAL_FIELDS = ["Portal URL", "Portal Status", "Portal ID", "Customer Type"];   // never shown to customers

// Cloudflare hides email addresses behind a script; the script is stripped here, so decode them.
function email(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  return hex.slice(2).replace(/../g, (b) => String.fromCharCode(parseInt(b, 16) ^ key));
}

export function restyle(html) {
  // Manager only serves the logo to signed-in users, so the portal shows its own copy (logo.jpg).
  const logo = existsSync(join(root, "logo.jpg")) ? '<img src="/logo.jpg" alt="">' : "";
  html = html
    .replace(/<a[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/a>/gi, (_, hex) => email(hex))
    .replace(/<img[^>]*\/api4\/business-logo[^>]*>/g, logo)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/(href|src)="\/(resources|api4)\//g, `$1="${MANAGER}/$2/`)
    .replace(/href="favicon\.ico"/g, `href="${MANAGER}/favicon.ico"`)
    .replace(/href="\/(customer-portal[a-z-]*)\?/g, 'href="/portal/$1?')
    .replace(/<tr>(?:<td style="border: 1px solid #000; border-top: none">&nbsp;<\/td>)+<\/tr>/g, "");   // spacer row
  for (const label of INTERNAL_FIELDS) {
    html = html.replace(new RegExp(
      `<dt[^>]*>\\s*(?:<data[^>]*>\\s*<strong>|<strong>\\s*<data[^>]*>)\\s*${label}\\s*(?:</strong>\\s*</data>|</data>\\s*</strong>)\\s*</dt>\\s*<dd[^>]*>[\\s\\S]*?</dd>`, "g"), "");
  }
  return html.replace("</head>",
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex">'
    + '<link rel="stylesheet" href="/portal.css?v=1"></head>');
}

async function portal(page, token, res) {
  if (!PORTAL_PAGE.test(page) || !PORTAL_TOKEN.test(token)) return false;
  const upstream = await fetch(`${MANAGER}/${page}?${token}`, {
    headers: { "User-Agent": "leitor-portal/1.0", Accept: "text/html" }, redirect: "manual",
  });
  if (upstream.status !== 200) return false;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex",
  });
  res.end(restyle(await upstream.text()));
  return true;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/portal/")) {
      if (req.method === "GET" && await portal(url.pathname.slice(8), url.search.slice(1), res)) return;
      throw new Error("no such portal page");
    }
    const path = decodeURIComponent(url.pathname);
    const rel = normalize(path === "/" ? "/index.html" : path);
    if (rel.includes("..") || rel.split(/[\\/]/).some((p) => p.startsWith("."))) throw new Error("bad path");
    const body = await readFile(join(root, rel));
    res.writeHead(200, { "Content-Type": types[extname(rel)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
