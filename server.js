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
// portal page from Manager, take the content out of it and lay it out afresh (portal.css).
// Only Manager's portal pages can be requested, and only with the customer's own link token,
// exactly as on Manager itself.
const MANAGER = (process.env.MANAGER_URL || "https://finance360.laitor.co.ke").replace(/\/$/, "");
const BUSINESS = process.env.PORTAL_BUSINESS || "Leitor Investment Company Limited";
const CONTACT_EMAIL = process.env.PORTAL_EMAIL || "partnerships@laitor.co.ke";
const CONTACT_PHONE = process.env.PORTAL_PHONE || "0113352048";
const PORTAL_PAGE = /^customer-portal(-(quotes|orders|invoices|credit-notes|delivery-notes|quote|order|invoice|credit-note|delivery-note))?$/;
const PORTAL_TOKEN = /^[A-Za-z0-9_-]{20,300}$/;
const INTERNAL_FIELDS = ["Portal URL", "Portal Status", "Portal ID", "Customer Type"];   // never shown to customers
const STATUS_TONE = { "bg-danger": "bad", "bg-success": "good", "bg-warning": "due", "bg-info": "due" };

// Cloudflare hides email addresses behind a script; no Manager script runs here, so decode them.
function email(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  return hex.slice(2).replace(/../g, (b) => String.fromCharCode(parseInt(b, 16) ^ key));
}
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").trim();
const local = (href) => href.replace(/^\/(customer-portal[a-z-]*)\?/, "/portal/$1?");

// The customer's own details, as a list of label and value.
function summary(body) {
  let out = "";
  for (const [, title, items] of body.matchAll(/<div class="card-header[^>]*>([^<]*)<\/div>([\s\S]*?)<\/div><\/div><\/div>/g)) {
    const rows = [...items.matchAll(/<h6[^>]*>([\s\S]*?)<\/h6><p[^>]*>([\s\S]*?)<\/p>/g)]
      .filter(([, , value]) => text(value))
      .map(([, label, value]) => `<div><dt>${text(label)}</dt><dd>${value.replace(/<(?!br\b)[^>]+>/g, "")}</dd></div>`);
    if (rows.length) out += `<h2>${text(title)}</h2><dl class="details">${rows.join("")}</dl>`;
  }
  return out;
}

// A list of documents. Each cell carries its column name so a phone can show a row as a card.
function list(body) {
  const title = text((body.match(/<span class="fw-bold"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
  const heads = [...((body.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map(([, h]) => text(h));
  const rows = [...((body.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => "<tr>" + [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attrs, cell], i) => {
      const link = cell.match(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const badge = cell.match(/<span class="badge[^"]*?(bg-[a-z]+)?"[^>]*>([\s\S]*?)<\/span>/);
      const inner = link ? `<a class="button" href="${local(link[1])}">${text(link[2])}</a>`
        : badge ? `<span class="status ${STATUS_TONE[badge[1]] || ""}">${text(badge[2])}</span>` : text(cell);
      const side = link ? "open" : /text-align: right/.test(attrs) ? "num" : "";
      return `<td class="${side}" data-label="${heads[i] || ""}">${inner}</td>`;
    }).join("") + "</tr>");
  if (!rows.length) return `<h2>${title}</h2><p class="empty">Nothing here yet.</p>`;
  return `<h2>${title}</h2><div class="scroll"><table class="list"><thead><tr>`
    + heads.map((h, i) => `<th${/total|balance|amount/i.test(h) ? ' class="num"' : ""}>${h}</th>`).join("")
    + `</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

// One document. Manager's own markup is kept (portal.css restyles it), minus what customers should not see.
function paper(main, title) {
  const logo = existsSync(join(root, "logo.jpg")) ? '<img src="/logo.jpg" alt="">' : "";
  main = main
    .replace(/<img\b[^>]*\/api4\/business-logo[^>]*>/g, logo)   // Manager serves the logo only to signed-in users
    .replace(/<tr>(?:<td style="border: 1px solid #000; border-top: none">&nbsp;<\/td>)+<\/tr>/g, "");   // spacer row
  for (const label of INTERNAL_FIELDS) {
    main = main.replace(new RegExp(
      `<dt[^>]*>\\s*(?:<data[^>]*>\\s*<strong>|<strong>\\s*<data[^>]*>)\\s*${label}\\s*(?:</strong>\\s*</data>|</data>\\s*</strong>)\\s*</dt>\\s*<dd[^>]*>[\\s\\S]*?</dd>`, "g"), "");
  }
  return `<div class="bar"><h2>${title}</h2><button class="button main" onclick="print()">Print or save as PDF</button></div>`
    + `<div class="scroll"><main>${main}</main></div>`;
}

export function restyle(html) {
  html = html
    .replace(/<a\b[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/a>/gi, (_, hex) => email(hex))
    .replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const customer = text((html.match(/<span class="navbar-brand[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
  let section = "";
  const menu = [...html.matchAll(/<a href="(\/customer-portal[a-z-]*\?[A-Za-z0-9_-]+)" class="([^"]*list-group-item[^"]*)"[^>]*><span><i[^>]*><\/i><span[^>]*>([^<]*)<\/span><\/span>(?:<span class="[^"]*badge[^"]*"[^>]*>(\d+)<\/span>)?<\/a>/g)]
    .map(([, href, cls, label, count]) => {
      const here = !/\bborder-end\b/.test(cls);
      if (here) section = label;
      return `<a href="${local(href)}"${here ? ' class="here"' : ""}>${label}${count === undefined ? "" : `<b>${count}</b>`}</a>`;
    }).join("");
  const start = html.indexOf('<div class="col border-end border-bottom p-4 bg-white print-reset"');
  const end = html.indexOf('<div class="row d-print-none"><div class="col"><div class="print:hidden"');
  const body = start < 0 ? "" : html.slice(start, end < 0 ? undefined : end);
  const main = body.match(/<main\b[^>]*>([\s\S]*)<\/main>/);
  const content = main ? paper(main[1], text((main[1].match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || section))
    : /<table\b/.test(body) ? list(body) : summary(body) || '<p class="empty">Nothing here yet.</p>';
  const logo = existsSync(join(root, "logo.jpg")) ? '<img src="/logo.jpg" alt="">' : "";
  const phone = CONTACT_PHONE.replace(/\D/g, "").replace(/^0/, "254");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${customer ? customer + " | " : ""}${BUSINESS}</title>`
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
    + '<link rel="icon" href="/logo.jpg"><link rel="stylesheet" href="/portal.css?v=2"></head><body>'
    + `<header class="top"><div class="wrap">${logo}<div><strong>${BUSINESS}</strong><span>Customer portal${customer ? " &middot; " + customer : ""}</span></div></div></header>`
    + `<nav class="tabs"><div class="wrap">${menu}</div></nav>`
    + `<div class="wrap"><section class="sheet${main ? " doc" : ""}">${content}</section>`
    + `<footer class="foot">Questions about a document? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`
    + ` &middot; <a href="https://wa.me/${phone}">WhatsApp ${CONTACT_PHONE}</a></footer></div></body></html>`;
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
