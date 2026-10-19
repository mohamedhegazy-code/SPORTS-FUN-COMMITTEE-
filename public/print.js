// Wires the Print button on the printable tournament sheets (inline scripts
// are blocked by the app's CSP, so this has to be an external file).
(function () {
  var btn = document.getElementById("print-btn");
  if (btn) btn.addEventListener("click", function () { window.print(); });
})();
