# eTIMS Import (Manager extension)

Copies eTIMS receipt details onto sales invoices in Manager, or creates the
invoice from the receipt. It is a static web page that Manager opens in a
window; every call to Manager is made by Manager itself as the logged-in
user, so the page holds no password or access token and has no server code.

## Deploy on Coolify

These are plain static files: no build step and no container of our own.

1. Put this folder in a Git repository.
2. In Coolify: New Resource > the repository > Build Pack **Static**
   (or Nixpacks with "Is it a static site?" ticked).
3. Base directory and publish directory: `/` (this folder).
4. Set the domain, e.g. `https://etims.laitor.co.ke`, and deploy.

Coolify's proxy handles the address and HTTPS.

If Manager moves to a different address, change `MANAGER_ORIGINS` near the
top of the script in `index.html`. The page only talks to those addresses.

## Add the button in Manager

In the business: Settings > Custom Buttons > New Custom Button.

| Field     | Value                              |
|-----------|------------------------------------|
| Name      | eTIMS Import                       |
| Source    | Url                                |
| Endpoint  | the deployed address (e.g. `etims.laitor.co.ke/`) |
| Placement | `sales-invoices`                   |

The button then appears on the Sales Invoices screen.

## Requirements in Manager

Text custom fields on Sales Invoices named exactly `eTIMS Invoice No.`,
`eTIMS Device Serial (SCU ID)` and `eTIMS QR`. A `KRA PIN` field on
customers improves matching.

## Tests

    npm install pdfjs-dist@4.10.38
    node tests/test.mjs

## Files

- `index.html` - the screen and the link to Manager
- `receipt.js` - reads an eTIMS receipt
- `books.js`   - matching, copying and creating rules
- `vendor/`    - pdf.js 4.10.38 (reads PDFs in the browser)
