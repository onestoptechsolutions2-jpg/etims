// Reads the fields we need out of the text of one eTIMS receipt.

const QR_BASE = "https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=";

export function toAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? null : Math.round(n * 100) / 100;
}

export function parseReceiptText(text) {
  const find = (re) => { const m = text.match(re); return m ? m[1].trim() : ""; };
  const joined = (re) => find(re).replace(/\s+/g, ""); // values that wrap across lines

  const r = {
    etimsNo: find(/INVOICE NO:\s*(\S+)/) || joined(/CU INVOICE NO\.\s*:\s*(\S+)/),
    scu: find(/SCU ID\s*:\s*(\S+)/),
    buyerPin: find(/INVOICE TO\s*PIN:\s*(\S+)/).toUpperCase(),
    buyerName: find(/INVOICE TO[\s\S]*?NAME:\s*([\s\S]+?)\s*INVOICE FROM/).replace(/\s+/g, " "),
    sellerPin: find(/INVOICE FROM\s*PIN:\s*(\S+)/).toUpperCase(),
    signature: joined(/Receipt Signature\s*:\s*([A-Z0-9\-\s]+?)\s*-{5,}/),
    total: toAmount(find(/Totals\s+KSh\s*[\d,.]+\s+KSh\s*[\d,.]+\s+KSh\s*([\d,.]+)/)),
    date: "",
    lines: [],
  };
  const d = text.match(/Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (d) r.date = `${d[3]}-${d[2]}-${d[1]}`;
  // The QR on the receipt encodes: seller PIN + branch "00" + signature without dashes.
  r.qr = r.sellerPin && r.signature ? QR_BASE + r.sellerPin + "00" + r.signature.replace(/-/g, "") : "";

  // Item lines sit between the table header and "INVOICE NO:". Descriptions may wrap.
  const block = text.match(/Amt incl\. Tax\s*([\s\S]*?)INVOICE NO:/);
  const lineRe = /(\S+)\s+([\s\S]+?)\s+([\d,.]+)\s+x\s+([\d,.]+)\s+(\d+%|Ex\.?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/g;
  for (const m of (block ? block[1] : "").matchAll(lineRe)) {
    r.lines.push({
      code: m[1], description: m[2].replace(/\s+/g, " ").trim(),
      qty: toAmount(m[3]), unitPrice: toAmount(m[4]), rate: m[5], total: toAmount(m[8]),
    });
  }

  const missing = ["etimsNo", "scu", "total"].filter((k) => !r[k]);
  if (missing.length) {
    throw new Error("This does not look like an eTIMS receipt (could not read: " + missing.join(", ") + ").");
  }
  return r;
}
