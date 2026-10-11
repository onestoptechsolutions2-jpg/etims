// Draws the eTIMS verification QR code on a document in the customer portal.
(function () {
  var target = document.getElementById("qr");
  if (!target || typeof qrcode !== "function") return;
  try {
    var code = qrcode(0, "M");
    code.addData(target.getAttribute("data-text"));
    code.make();
    target.innerHTML = code.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  } catch (e) { target.remove(); }
})();
