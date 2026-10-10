// What the extension needs from Manager, and the rules for matching a receipt
// to an invoice, copying the eTIMS details onto it, or creating the invoice.
//
// `api(method, path, body)` performs one Manager API call and resolves with the
// response body. In the browser it goes through Manager's postMessage bridge,
// so every call runs as the logged-in user in the business they have open.

export const FIELD_NO = "eTIMS Invoice No.";
export const FIELD_SCU = "eTIMS Device Serial (SCU ID)";
export const FIELD_QR = "eTIMS QR";
export const FIELD_PIN = "KRA PIN";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const round2 = (n) => Math.round(n * 100) / 100;
const clone = (o) => JSON.parse(JSON.stringify(o));
const strings = (item) => (item.customFields2 && item.customFields2.strings) || {};
export const money = (n) => (n === null || n === undefined ? "?" :
  n.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export class Books {
  constructor(api) {
    this.api = api;
  }

  async list(path) {
    const out = [];
    for (let skip = 0; ; skip += 500) {
      const res = await this.api("GET", `${path}?Skip=${skip}&PageSize=500`);
      const items = (res && res.items) || [];
      out.push(...items);
      if (items.length < 500) return out;
    }
  }

  // A handful of list calls; each returns the full records, so nothing is opened one by one.
  async load(progress = () => {}) {
    progress("Reading Manager lists...");
    const [fields, taxCodes, projects, inventory, nonInventory, accounts, customers] = await Promise.all([
      this.list("/api4/text-custom-field-batch"), this.list("/api4/tax-code-batch"),
      this.list("/api4/project-batch"), this.list("/api4/inventory-item-batch"),
      this.list("/api4/non-inventory-item-batch"), this.list("/api4/profit-and-loss-statement-account-batch"),
      this.list("/api4/customer-batch"),
    ]);
    this.fields = Object.fromEntries(fields.map((f) => [f.item.name, f.key]));
    for (const needed of [FIELD_NO, FIELD_SCU, FIELD_QR]) {
      if (!this.fields[needed]) throw new Error(`Manager has no custom field called "${needed}".`);
    }
    this.targetKeys = [this.fields[FIELD_NO], this.fields[FIELD_SCU], this.fields[FIELD_QR]];

    this.taxCodes = taxCodes.map((t) => ({ key: t.key, name: t.item.name || "", rate: taxRate(t.item) }));
    this.projects = projects.filter((p) => !p.item.inactive)
      .map((p) => ({ key: p.key, name: p.item.name || "" })).sort((a, b) => a.name.localeCompare(b.name));
    this.items = {}; // item name -> key; non-inventory items win over inventory items
    for (const i of inventory) this.items[norm(i.item.itemName)] = i.key;
    for (const i of nonInventory) this.items[norm(i.item.name)] = i.key;
    const sales = accounts.find((a) => a.item.name === "Sales");
    this.salesAccount = sales ? sales.key : null;

    const pinKey = this.fields[FIELD_PIN];
    this.customers = customers.map((c) => ({
      key: c.key, name: c.item.name || "",
      pin: String((pinKey && strings(c.item)[pinKey]) || "").trim().toUpperCase(),
    }));
    this.customerByKey = Object.fromEntries(this.customers.map((c) => [c.key, c]));

    progress("Reading sales invoices...");
    this.invoices = (await this.list("/api4/sales-invoice-batch")).map((i) => this.row(i.key, i.item));
  }

  row(key, item) {
    const customer = this.customerByKey[item.customer] || { name: "", pin: "" };
    return {
      key, item, reference: item.reference || "", date: String(item.issueDate || "").slice(0, 10),
      customer: item.customer, customerName: customer.name, customerPin: customer.pin,
      total: this.invoiceTotal(item), etimsNo: strings(item)[this.fields[FIELD_NO]] || "",
    };
  }

  // Manager does not hand extensions a ready-made total, so it is worked out from the lines.
  invoiceTotal(item) {
    const rates = Object.fromEntries(this.taxCodes.map((t) => [t.key, t.rate]));
    let total = 0;
    for (const l of item.lines || []) {
      let amount = (l.qty === null || l.qty === undefined ? 1 : l.qty) * (l.salesUnitPrice || 0);
      if (item.discount) {
        amount = item.discountType === 1 ? amount - (l.discountAmount || 0)
          : amount * (1 - (l.discountPercentage || 0) / 100);
      }
      if (!item.amountsIncludeTax && l.taxCode) amount *= 1 + (rates[l.taxCode] || 0) / 100;
      total += amount;
    }
    return round2(total);
  }

  describe(inv) {
    return `${inv.reference || "(no ref)"}  |  ${inv.date}  |  ${inv.customerName}  |  KES ${money(inv.total)}`;
  }

  search(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return this.invoices.filter((i) => words.every((w) => this.describe(i).toLowerCase().includes(w)));
  }

  // Returns { state, invoice, candidates, note }.
  match(receipt, taken = new Set(), tolerance = 1.0) {
    const hint = " - choose or create the invoice";
    const doneAll = this.invoices.filter((i) => i.etimsNo === receipt.etimsNo);
    if (doneAll.length) {
      return { state: "done", invoice: doneAll[0], invoices: doneAll, candidates: [],
        note: "Already on invoice " + doneAll.map((i) => i.reference || i.date).join(", ") };
    }
    const cands = this.invoices.filter((i) => !i.etimsNo && !taken.has(i.key)
      && Math.abs(i.total - receipt.total) <= tolerance);
    if (!cands.length) {
      return { state: "none", invoice: null, candidates: [], note: `No open invoice with total KES ${money(receipt.total)}${hint}` };
    }
    const name = norm(receipt.buyerName);
    const mine = cands.filter((i) => (receipt.buyerPin && i.customerPin === receipt.buyerPin) || norm(i.customerName) === name);
    if (!mine.length) return { state: "choose", invoice: null, candidates: cands, note: "Total matches but the customer differs" + hint };
    if (mine.length > 1) {
      const sameDay = mine.filter((i) => i.date === receipt.date);
      if (sameDay.length === 1) return { state: "ready", invoice: sameDay[0], candidates: mine, note: "" };
      return { state: "choose", invoice: null, candidates: mine, note: "More than one invoice fits" + hint };
    }
    return { state: "ready", invoice: mine[0], candidates: mine, note: "" };
  }

  // One receipt may cover several invoices of the same buyer (same customer or same PIN).
  // `error` blocks the choice; `warning` is something to confirm (the invoices do not add up to the receipt).
  checkGroup(receipt, invoices, tolerance = 1.0) {
    const first = invoices[0];
    const same = invoices.every((i) => i.customer === first.customer
      || (i.customerPin && i.customerPin === first.customerPin));
    if (!same) {
      return { error: "These invoices belong to different customers. A receipt carries one buyer PIN, so each customer needs its own receipt." };
    }
    const sum = round2(invoices.reduce((t, i) => t + i.total, 0));
    if (Math.abs(sum - receipt.total) > tolerance) {
      return { warning: `The ${invoices.length} invoices add up to KES ${money(sum)} but the receipt is KES ${money(receipt.total)}.` };
    }
    return {};
  }

  etimsStrings(receipt) {
    const s = { [this.fields[FIELD_NO]]: receipt.etimsNo, [this.fields[FIELD_SCU]]: receipt.scu };
    if (receipt.qr) s[this.fields[FIELD_QR]] = receipt.qr;
    return s;
  }

  // The parts of an invoice that must never change when only eTIMS details are written.
  essence(item) {
    const other = { ...strings(item) };
    for (const k of this.targetKeys) delete other[k];
    return {
      issueDate: item.issueDate, reference: item.reference || "", customer: item.customer,
      amountsIncludeTax: !!item.amountsIncludeTax, total: this.invoiceTotal(item), otherFields: other,
      lines: (item.lines || []).map((l) => [l.item, l.account, l.lineDescription || "", l.qty,
        l.salesUnitPrice, l.taxCode, l.project, l.discountPercentage || 0, l.discountAmount || 0]),
    };
  }

  // Writes the eTIMS details to one invoice, re-reads it, and puts it back if anything else changed.
  async apply(receipt, inv) {
    const path = "/api4/sales-invoice?Key=" + encodeURIComponent(inv.key);
    const before = await this.api("GET", path);
    const current = strings(before)[this.fields[FIELD_NO]] || "";
    if (current && current !== receipt.etimsNo) {
      throw new Error(`Invoice ${inv.reference || inv.date} already has eTIMS number ${current}.`);
    }
    const wanted = this.etimsStrings(receipt);
    const updated = clone(before);
    updated.customFields2 = updated.customFields2 || {};
    updated.customFields2.strings = { ...(updated.customFields2.strings || {}), ...wanted };
    await this.api("PUT", "/api4/sales-invoice", { key: inv.key, value: updated });

    const after = await this.api("GET", path);
    const kept = Object.entries(wanted).every(([k, v]) => strings(after)[k] === v);
    const untouched = JSON.stringify(this.essence(after)) === JSON.stringify(this.essence(before));
    if (!kept || !untouched) {
      await this.api("PUT", "/api4/sales-invoice", { key: inv.key, value: before });
      throw new Error(`Invoice ${inv.reference || inv.date} did not save as expected, so it was put back as it was.`);
    }
    Object.assign(inv, this.row(inv.key, after));
    return { before };
  }

  findCustomer(receipt) {
    const name = norm(receipt.buyerName);
    const byName = this.customers.filter((c) => norm(c.name) === name);
    if (byName.length === 1) return byName[0].key;
    const byPin = receipt.buyerPin ? this.customers.filter((c) => c.pin === receipt.buyerPin) : [];
    return byPin.length === 1 ? byPin[0].key : null;
  }

  async createCustomer(receipt) {
    const value = { name: receipt.buyerName };
    if (this.fields[FIELD_PIN] && receipt.buyerPin) {
      value.customFields2 = { strings: { [this.fields[FIELD_PIN]]: receipt.buyerPin } };
    }
    const key = await this.api("POST", "/api4/customer", { value });
    const c = { key, name: receipt.buyerName, pin: receipt.buyerPin };
    this.customers.push(c);
    this.customerByKey[key] = c;
    return key;
  }

  // Creates the sales invoice from the receipt, eTIMS details included.
  async createInvoice(receipt, { project = null, reference = "" } = {}) {
    const lines = receipt.lines || [];
    const sum = lines.reduce((t, l) => t + (l.total || 0), 0);
    if (!lines.length || Math.abs(sum - receipt.total) > 1.0) {
      throw new Error("Could not read the item lines of this receipt reliably, so the invoice was not created. "
        + "Create it in Manager and then choose it here.");
    }
    const value = {
      issueDate: receipt.date + "T00:00:00", amountsIncludeTax: true, lines: [],
      customFields2: { strings: this.etimsStrings(receipt) },
    };
    if (reference) value.reference = reference;
    for (const l of lines) {
      const want = { "16%": "16", "0%": "zero", "ex": "exempt" }[l.rate.replace(/\.$/, "").toLowerCase()] || l.rate.replace("%", "");
      const tax = this.taxCodes.find((t) => t.name.toLowerCase().includes(want));
      if (!tax) throw new Error(`Manager has no tax code for rate "${l.rate}".`);
      const line = { qty: l.qty, salesUnitPrice: l.unitPrice, taxCode: tax.key };
      const item = this.items[norm(l.description)];
      if (item) {
        line.item = item;
      } else {
        if (!this.salesAccount) throw new Error(`"${l.description}" is not an item in Manager and there is no Sales account to post it to.`);
        line.account = this.salesAccount;
        line.lineDescription = l.description;
      }
      if (project) line.project = project;
      value.lines.push(line);
    }

    value.customer = this.findCustomer(receipt) || await this.createCustomer(receipt);
    const key = await this.api("POST", "/api4/sales-invoice", { value });
    const saved = await this.api("GET", "/api4/sales-invoice?Key=" + encodeURIComponent(key));
    const inv = this.row(key, saved);
    if (Math.abs(inv.total - receipt.total) > 1.0) {
      await this.api("DELETE", "/api4/sales-invoice?Key=" + encodeURIComponent(key));
      throw new Error(`The new invoice came out at KES ${money(inv.total)} instead of KES ${money(receipt.total)}, `
        + "so it was removed again. Create it in Manager and then choose it here.");
    }
    this.invoices.push(inv);
    return inv;
  }
}

function taxRate(code) {
  if (/zero|exempt|non/i.test(code.name || "")) return 0;
  const rate = parseFloat(code.rate);
  if (rate > 0) return rate;
  const parts = (code.components || []).reduce((t, c) => t + (parseFloat(c.componentRate) || 0), 0);
  if (parts > 0) return parts;
  const inName = String(code.name || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return inName ? parseFloat(inName[1]) : 0;
}
