// Run with:  node tests/test.mjs [receipt.pdf] [fixture.json]
// Tests the receipt reader and the matching / saving rules against a fake Manager.
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseReceiptText } from "../receipt.js";
import { Books, FIELD_NO, FIELD_SCU, FIELD_QR, FIELD_PIN } from "../books.js";

const SAMPLE = `Item Code Item Descrption Qty x Unit Price Rate Amt excl. Tax Tax Amt Amt incl. Tax
KE2CTXNOX00001 Network Router 1 x 87,000.00 16% 75,000.00 12,000.00 87,000.00
KE2OUXNOX00002 Network Switch 1 x 16,820.00 16% 14,500.00 2,320.00 16,820.00
KE1ROXBXX00001 Network cable 40 x 70.00 16% 2,413.79 386.21 2,800.00
KE3OUXNOX00001 Professional engineering
services
1 x 30,600.00 16% 26,379.31 4,220.69 30,600.00
INVOICE NO: KRACU0200240524/13
Date : 08/08/2026 09:25:53
INVOICE TO
PIN: P000000001A
NAME: Example Buyer Limited
INVOICE FROM
PIN: P000000002B
NAME: EXAMPLE SELLER
COMPANY LIMITED
TAX SUMMARY
Tax Rate Taxable Amt Tax Amt Total Amt
16% KSh 118,293.10 KSh 18,926.90 KSh 137,220.00
Totals KSh 118,293.10 KSh 18,926.90 KSh 137,220.00
SCU INFORMATION
------------------------------------
Date : 08/08/2026 09:25:53
SCU ID : KRACU0200240524
CU INVOICE NO. :
KRACU0200240524/13
Internal Data : CE6B-NE5I-FMQ7-SKVS-
Y4PW-5UB7-34
Receipt Signature : A2CJ-FBVX-WAFL-
JLG6
------------------------------------
Powered by eTIMS
`;

const r = parseReceiptText(SAMPLE);
assert.equal(r.etimsNo, "KRACU0200240524/13");
assert.equal(r.scu, "KRACU0200240524");
assert.equal(r.total, 137220);
assert.equal(r.date, "2026-08-08");
assert.equal(r.buyerPin, "P000000001A");
assert.equal(r.buyerName, "Example Buyer Limited");
assert.equal(r.qr, "https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P000000002B00A2CJFBVXWAFLJLG6");
assert.equal(r.lines.length, 4);
assert.deepEqual(r.lines[3], { code: "KE3OUXNOX00001", description: "Professional engineering services", qty: 1, unitPrice: 30600, rate: "16%", total: 30600 });
assert.throws(() => parseReceiptText("just some text"));

// ----- a fake Manager -----
const F = { no: "f-no", scu: "f-scu", qr: "f-qr", pin: "f-pin" };
const db = {
  "text-custom-field": [[F.no, { name: FIELD_NO }], [F.scu, { name: FIELD_SCU }], [F.qr, { name: FIELD_QR }], [F.pin, { name: FIELD_PIN }]],
  "tax-code": [["t16", { name: "16% VAT", rate: 16 }], ["tz", { name: "VAT‑Zero", rate: 0 }]],
  project: [["p1", { name: "General Supplies" }]],
  "inventory-item": [["i-router", { itemName: "Network Router" }]],
  "non-inventory-item": [["n-cable", { name: "Network cable" }]],
  "profit-and-loss-statement-account": [["a-sales", { name: "Sales" }]],
  customer: [["c1", { name: "Example Buyer Limited", customFields2: { strings: { [F.pin]: "P000000001A" } } }], ["c2", { name: "Other Ltd" }]],
  "sales-invoice": [
    ["k1", { issueDate: "2026-08-07T00:00:00", customer: "c1", lines: [{ qty: 1, salesUnitPrice: 118293.1, taxCode: "t16" }] }],
    ["k2", { issueDate: "2026-08-08T00:00:00", reference: "INV-11", customer: "c2", amountsIncludeTax: true, lines: [{ qty: 2, salesUnitPrice: 68610, taxCode: "t16" }] }],
    ["k3", { issueDate: "2026-08-01T00:00:00", reference: "INV-12", customer: "c1", discount: true, lines: [{ qty: 1, salesUnitPrice: 1000, discountPercentage: 50 }] }],
  ],
};
const calls = [];
let breakTotals = false;
async function api(method, path, body) {
  calls.push(method + " " + path.split("?")[0]);
  const [, name, batch] = path.match(/^\/api4\/([a-z-]+?)(-batch)?(\?|$)/);
  const key = (path.match(/Key=([^&]+)/) || [])[1];
  if (batch) return { items: db[name].map(([k, item]) => ({ key: k, item: structuredClone(item) })) };
  if (method === "GET") return structuredClone(db[name].find(([k]) => k === key)[1]);
  if (method === "PUT") { db[name].find(([k]) => k === body.key)[1] = structuredClone(body.value); return true; }
  if (method === "POST") {
    const k = name + "-" + (db[name].length + 1);
    const v = structuredClone(body.value);
    if (breakTotals && name === "sales-invoice") v.lines[0].salesUnitPrice = 1;
    db[name].push([k, v]);
    return k;
  }
  if (method === "DELETE") { db[name] = db[name].filter(([k]) => k !== key); return true; }
  throw new Error("unexpected call");
}

const b = new Books(api);
await b.load();
assert.equal(calls.length, 8, "start-up is eight list calls");
assert.deepEqual(b.invoices.map((i) => i.total), [137220, 137220, 500]);

let m = b.match(r);
assert.equal(m.state, "ready");
assert.equal(m.invoice.key, "k1", "two invoices share the total; the customer decides");
await b.apply(r, m.invoice);
const k1 = db["sales-invoice"][0][1];
assert.deepEqual(k1.customFields2.strings, { [F.no]: r.etimsNo, [F.scu]: r.scu, [F.qr]: r.qr });
assert.equal(k1.lines[0].salesUnitPrice, 118293.1);
assert.equal(b.match(r).state, "done");
await assert.rejects(b.apply({ ...r, etimsNo: "OTHER/1" }, m.invoice), /already has eTIMS number/);
assert.deepEqual(b.search("inv-12").map((i) => i.key), ["k3"]);

// create an invoice, for a customer that does not exist yet
const r2 = { ...r, etimsNo: "KRACU0200240524/14", buyerName: "New Client Ltd", buyerPin: "P000000009Z" };
assert.equal(b.match(r2).state, "choose");
const made = await b.createInvoice(r2, { project: "p1", reference: "INV-99" });
const saved = db["sales-invoice"].find(([k]) => k === made.key)[1];
assert.equal(saved.amountsIncludeTax, true);
assert.equal(saved.issueDate, "2026-08-08T00:00:00");
assert.equal(db.customer.find(([k]) => k === saved.customer)[1].customFields2.strings[F.pin], "P000000009Z");
assert.deepEqual(saved.lines.map((l) => l.item || null), ["i-router", null, "n-cable", null]);
assert.deepEqual(saved.lines[1], { qty: 1, salesUnitPrice: 16820, taxCode: "t16", account: "a-sales", lineDescription: "Network Switch", project: "p1" });
assert.equal(made.total, 137220);
assert.equal(b.match(r2).state, "done");

// a created invoice whose total comes out wrong is removed again
breakTotals = true;
const count = db["sales-invoice"].length;
await assert.rejects(b.createInvoice({ ...r, etimsNo: "X/15" }), /removed again/);
assert.equal(db["sales-invoice"].length, count);
console.log("logic tests passed");

// ----- optional: the real PDF through pdf.js, and totals against real figures -----
const [pdfPath, fixturePath] = process.argv.slice(2);
if (pdfPath) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    for (const it of (await (await doc.getPage(p)).getTextContent()).items) text += it.str + (it.hasEOL ? "\n" : "");
    text += "\n";
  }
  const real = parseReceiptText(text);
  assert.equal(real.lines.length, 4);
  assert.equal(real.total, 137220);
  assert.ok(real.qr.endsWith("00A2CJFBVXWAFLJLG6"));
  console.log("real receipt read correctly:", real.etimsNo, real.total, real.lines.length, "lines");
}
if (fixturePath) {
  const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const bb = new Books(async (_m, path) => {
    const name = path.match(/^\/api4\/([a-z-]+?)-batch/)[1];
    if (name === "tax-code") return { items: fx.taxCodes };
    if (name === "sales-invoice") return { items: fx.invoices };
    if (name === "text-custom-field") return { items: db["text-custom-field"].map(([key, item]) => ({ key, item })) };
    return { items: [] };
  });
  await bb.load();
  const off = bb.invoices.filter((inv, n) => Math.abs(inv.total - fx.invoices[n].listTotal) > 1);
  console.log(`totals worked out for ${bb.invoices.length} real invoices: ${bb.invoices.length - off.length} agree with Manager, ${off.length} differ`);
  for (const inv of off.slice(0, 8)) {
    const f = fx.invoices.find((x) => x.key === inv.key);
    console.log("  differs:", inv.total, "vs", f.listTotal, JSON.stringify({ d: f.item.discount, dt: f.item.discountType, inc: f.item.amountsIncludeTax, wht: f.item.withholdingTaxPercentage, n: f.item.lines.length }));
  }
}
