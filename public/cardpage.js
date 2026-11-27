"use strict";
// Public player card page: /card.html?c=TOKEN[&lang=en]. No sign-in; the signed token is the key.
const pcParams = new URLSearchParams(location.search);
currentLang = pcParams.get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
const pcToken = pcParams.get("c") || "";
(function langLink() {
  const a = document.getElementById("pc-lang");
  const other = currentLang === "ar" ? "en" : "ar";
  a.textContent = other === "en" ? "EN" : "عربي";
  a.href = `?c=${encodeURIComponent(pcToken)}&lang=${other}`;
})();
let pcData = null;
async function pcLoad() {
  const root = document.getElementById("pc-root");
  try {
    const res = await fetch("/api/public/card/" + encodeURIComponent(pcToken), { cache: "no-store" });
    if (!res.ok) { root.innerHTML = `<div class="pc-err">${pcEsc(t("cardNotValid"))}</div>`; return; }
    pcData = await res.json();
    document.title = pcData.player.label + " - " + pcEventName(pcData);
    pcMount(root, pcData);
    document.getElementById("pc-actions").hidden = false;
  } catch (e) { if (!pcData) root.innerHTML = `<div class="pc-err">${pcEsc(t("cardLoadFail"))}</div>`; }
}
document.getElementById("pc-share").textContent = t("cardShare");
document.getElementById("pc-copy").textContent = t("cardCopyLink");
document.getElementById("pc-share").addEventListener("click", async () => {
  if (!pcData) return;
  const r = await pcShare(pcData);
  document.getElementById("pc-msg").textContent = r === "downloaded" ? t("cardSaved") : "";
});
document.getElementById("pc-copy").addEventListener("click", async () => {
  const ok = await pcCopy(location.href);
  document.getElementById("pc-msg").textContent = ok ? t("cardLinkCopied") : location.href;
});
pcLoad();
setInterval(pcLoad, 30000); // scores and the next match update by themselves
