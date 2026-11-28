"use strict";
// Committee invitation page: /invite.html?t=TOKEN[&lang=en]. The one-time link lets a person choose their own password;
// the server (POST /api/auth/invite/:token) enforces the password rules and signs them in.
const ivQ = new URLSearchParams(location.search);
currentLang = ivQ.get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
const ivToken = ivQ.get("t") || "";
const ivEl = (id) => document.getElementById(id);
function ivF(key, vars) {
  let s = t(key);
  Object.keys(vars || {}).forEach((k) => (s = s.split("{" + k + "}").join(vars[k])));
  return s;
}
function ivCsrf() {
  const m = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function ivMsg(text, ok) {
  const m = ivEl("iv-msg");
  m.textContent = text || "";
  m.classList.remove("ok", "err");
  if (text) m.classList.add("show", ok ? "ok" : "err");
  else m.classList.remove("show");
}
(function chrome() {
  const a = ivEl("iv-lang");
  const other = currentLang === "ar" ? "en" : "ar";
  const q = new URLSearchParams(location.search);
  q.set("lang", other);
  a.textContent = other === "en" ? "EN" : "عربي";
  a.href = "?" + q.toString();
  document.title = "MyAhlawy - " + t("ivTitle");
  ivEl("iv-title").textContent = t("ivTitle");
  ivEl("iv-intro").textContent = t("ivLoading");
  ivEl("iv-user-l").textContent = t("ivUser");
  ivEl("iv-pw-l").textContent = t("ivPassword");
  ivEl("iv-pw2-l").textContent = t("ivPassword2");
  ivEl("iv-rules").textContent = t("ivRules");
  ivEl("iv-go").textContent = t("ivSubmit");
})();
function ivStrength(pw) {
  let n = 0;
  if (pw.length >= 10) n++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 3) n++;
  if (pw.length >= 14) n++;
  if (classes === 4 && pw.length >= 10) n++;
  return n;
}
ivEl("iv-pw").addEventListener("input", (e) => {
  const n = ivStrength(e.target.value);
  for (let i = 1; i <= 4; i++) ivEl("iv-m" + i).className = i <= n ? "on" + n : "";
});
(async function load() {
  if (!ivToken) return ivBad();
  try {
    const res = await fetch("/api/auth/invite/" + encodeURIComponent(ivToken), { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return ivBad();
    ivEl("iv-intro").textContent = ivF("ivIntro", { name: data.name });
    ivEl("iv-user").value = data.username;
    ivEl("iv-form").classList.remove("hidden");
    ivEl("iv-pw").focus();
  } catch (e) {
    ivBad();
  }
})();
function ivBad() {
  ivEl("iv-intro").textContent = "";
  ivMsg(t("ivBad"), false);
}
ivEl("iv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = ivEl("iv-pw").value;
  if (pw !== ivEl("iv-pw2").value) return ivMsg(t("ivMismatch"), false);
  ivEl("iv-go").disabled = true;
  try {
    const res = await fetch("/api/auth/invite/" + encodeURIComponent(ivToken), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": ivCsrf() },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      ivMsg(data.error || t("ivBad"), false);
      ivEl("iv-go").disabled = false;
      return;
    }
    ivMsg("✓", true);
    location.replace("/");
  } catch (err) {
    ivMsg(t("errGeneric"), false);
    ivEl("iv-go").disabled = false;
  }
});
