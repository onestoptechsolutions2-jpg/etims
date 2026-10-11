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

// One document, laid out the way the "LIC Standard" theme lays it out inside Manager (the theme
// itself cannot run here: it reads the document from Manager, which needs a signed-in user).
// Keep the field sorting below in step with themes/lic-standard.html.
const lines = (html) => html.replace(/<(?!br\b)[^>]+>/g, "").replace(/^(\s|<br\s*\/?>)+|(\s|<br\s*\/?>)+$/g, "");
const pairs = (dl) => [...(dl || "").matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)]
  .map(([, label, value]) => ({ label: text(label), text: text(value), custom: /<data value="[0-9a-f-]{36}"/.test(label) }));
const alignOf = (attrs) => /text-align: (right|end)/.test(attrs) ? "right" : /text-align: center/.test(attrs) ? "center" : "left";

function paper(main, title) {
  const logo = existsSync(join(root, "logo.jpg")) ? '<img src="/logo.jpg" alt="">' : "";
  const header = (main.match(/<section\b[^>]*>([\s\S]*?)<\/section>/) || [])[1] || "";
  const parties = [...header.matchAll(/<address[^>]*>\s*<div>([\s\S]*?)<\/div>\s*<div>([\s\S]*?)<\/div>\s*<\/address>/g)]
    .map(([, name, details]) => ({ name: text(name), details: lines(details) }));
  const to = parties.length > 1 ? parties[0] : null, business = parties[parties.length - 1] || { name: BUSINESS, details: "" };
  const at = main.indexOf("<table"), tableEnd = main.indexOf("</table>", at);
  const table = at < 0 ? "" : main.slice(at, tableEnd);
  let rest = at < 0 ? "" : main.slice(tableEnd + 8);

  // Fields are sorted into: eTIMS details, the customer's PIN and phone, header fields, and body fields.
  const etims = [], top = [], body = [];
  let qr = "", pin = "", phone = "";
  const below = rest.match(/^\s*<dl[^>]*>([\s\S]*?)<\/dl>/);
  if (below) rest = rest.slice(below[0].length);
  const fields = pairs((header.match(/<dl[^>]*>([\s\S]*?)<\/dl>/) || [])[1]).map((f) => ({ ...f, top: true }))
    .concat(pairs(below && below[1]));
  for (const f of fields) {
    if (!f.text || INTERNAL_FIELDS.includes(f.label)) continue;
    if (/\bqr\b/i.test(f.label) || /^https?:\/\/etims\.kra\.go\.ke/i.test(f.text)) qr = f.text;
    else if (/etims|scu|device serial/i.test(f.label)) etims.push(f);
    else if (/^kra pin$/i.test(f.label)) pin = f.text;
    else if (/^(phone|telephone|mobile)/i.test(f.label)) phone = f.text;
    else if (!f.custom || (f.top && f.text.length <= 40 && !/^https?:/i.test(f.text))) top.push(f);
    else body.push(f);
  }

  // Lines, then the totals (Manager writes those as rows that span the columns)
  const cols = [...((table.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "").matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)]
    .map(([, attrs, label]) => ({ label: text(label), align: alignOf(attrs), nowrap: /nowrap/.test(attrs) }));
  let rows = "", totals = "";
  for (const [, row] of ((table.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)];
    if (cells.every(([, , cell]) => !text(cell))) continue;   // spacer row
    if (/colspan=/.test(cells[0][1])) {
      totals += `<tr${/font-weight: bold/.test(cells[0][1]) ? ' class="strong"' : ""}><td>${text(cells[0][2])}</td><td>${text((cells[1] || [])[2] || "")}</td></tr>`;
    } else {
      rows += "<tr>" + cells.map(([, , cell], i) => `<td${(cols[i] || {}).nowrap ? ' class="nowrap"' : ""} style="text-align:${(cols[i] || {}).align || "left"}">${lines(cell)}</td>`).join("") + "</tr>";
    }
  }

  const stamp = rest.match(/<div style="text-align: center; display: flex; justify-content: center"><div style="([^"]*)">([\s\S]*?)<\/div><\/div>\s*$/);
  if (stamp) rest = rest.slice(0, stamp.index);
  const tone = !stamp ? "" : /color: red/.test(stamp[1]) ? "negative" : /color: green/.test(stamp[1]) ? "positive" : "";
  const tel = business.details.match(/(?:\+?254|0)\d{9}\b/), mail = business.details.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const toDetails = to ? [to.details, phone, pin ? "PIN: " + pin : ""].filter(Boolean).join("<br>") : "";

  return `<div class="bar"><h2>${title}</h2><button class="button main" onclick="print()">Print or save as PDF</button></div>`
    + '<div class="scroll"><article class="paper">'
    + `<div class="head"><div class="logo">${logo}</div><div class="biz"><div class="biz-name">${business.name}</div><div class="muted">${business.details}</div></div></div>`
    + `<div class="titlebar"><h1>${title}</h1>${stamp ? `<span class="stamp ${tone}">${text(stamp[2])}</span>` : ""}</div>`
    + '<div class="parties">'
    + (to ? `<div class="party"><div class="label">To</div><div class="name">${to.name}</div><div class="muted">${toDetails}</div></div>` : "")
    + `<div class="meta"><table><tbody>${top.map((f) => `<tr><td>${f.label}</td><td>${f.text}</td></tr>`).join("")}</tbody></table></div></div>`
    + `<table class="items"><thead><tr>${cols.map((c) => `<th${c.nowrap ? ' class="nowrap"' : ""} style="text-align:${c.align}">${c.label}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`
    + `<div class="totals"><table><tbody>${totals}</tbody></table></div>`
    + (etims.length || qr ? `<div class="etims">${qr ? `<div class="qr" id="qr" data-text="${qr.replace(/"/g, "&quot;")}"></div>` : ""}<div><div class="name">KRA eTIMS</div>`
      + etims.map((f) => `<div class="label">${f.label}</div><div class="value">${f.text}</div>`).join("") + "</div></div>" : "")
    + (body.length ? `<div class="extra">${body.map((f) => `<div><div class="label">${f.label}</div><div>${f.text}</div></div>`).join("")}</div>` : "")
    + (text(rest) ? `<div class="footers">${rest}</div>` : "")
    + '<div class="share">'
    + (tel ? `<a target="_blank" rel="noopener" href="https://wa.me/${tel[0].replace(/^\+/, "").replace(/^0/, "254")}">Chat on WhatsApp</a>` : "")
    + (mail ? `<a href="mailto:${mail[0]}?subject=${encodeURIComponent([title, (top.find((f) => /number|reference/i.test(f.label)) || {}).text].filter(Boolean).join(" "))}">Email us</a>` : "")
    + "</div></article></div>"
    + (qr ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script><script src="/portal-qr.js"></script>' : "");
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
    + '<link rel="icon" href="/logo.jpg"><link rel="stylesheet" href="/portal.css?v=3"></head><body>'
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
