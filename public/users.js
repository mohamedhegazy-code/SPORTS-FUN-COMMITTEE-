"use strict";
// Users & access, Security centre and 2-step login prompts (Phase 1).
// Talks to /api/admin/users*, /api/admin/security*, /api/auth/2fa*, /api/auth/staff-login/2fa.
// Shares helpers (api, t, escapeAttr, showMsg, waLink, CURRENT_SESSION ...) with app.js, which loads first.

const usEl = (id) => document.getElementById(id);
const usEsc = (v) => escapeAttr(v);
function usF(key, vars) {
  let s = t(key);
  Object.keys(vars || {}).forEach((k) => { s = s.split("{" + k + "}").join(vars[k] == null ? "" : vars[k]); });
  return s;
}
function usDate(iso, withTime) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const opts = withTime
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" };
    return d.toLocaleString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", opts);
  } catch (e) {
    return iso;
  }
}
async function usCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    window.prompt(t("usShareCopy"), text);
    return false;
  }
}

// ============================================================ Users & access ====
const US = { users: [], meta: null, filter: "all", q: "", editing: null, shareText: "", wired: false };
const US_STATUSES = ["active", "invited", "pending", "locked", "disabled"];
const US_STATUS_KEY = { active: "usStatusActive", invited: "usStatusInvited", pending: "usStatusPending", locked: "usStatusLocked", disabled: "usStatusDisabled" };
const US_PRESETS = {
  usPresetEvents: ["events", "tournaments", "checkin", "reports", "messages"],
  usPresetMembers: ["members", "points", "messages", "reports"],
  usPresetContent: ["content", "landing", "links"],
  usPresetReports: ["management", "reports"],
};

function usLevelOf(u) {
  if (u.role === "admin") return u.fullAdmin ? "full" : "custom";
  return u.role;
}
function usLevelLabel(level) {
  return t({ full: "usLevelFull", custom: "usLevelCustom", tournament: "usLevelTournament", staff: "usLevelStaff", management: "usLevelManagement", partner: "usLevelPartner" }[level]);
}
function usShortLevel(u) {
  if (u.role === "admin") return u.fullAdmin ? t("usLevelFull") : t("usLevelCustom").replace(/\s*\(.*\)\s*$/, "");
  return usLevelLabel(u.role).replace(/\s*\(.*\)\s*$/, "");
}
function usInitials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0)).join("").toUpperCase() || "?";
}

async function usLoad() {
  const msg = usEl("us-msg");
  try {
    const [meta, list] = await Promise.all([US.meta ? Promise.resolve(US.meta) : api("/api/admin/users/meta"), api("/api/admin/users")]);
    US.meta = meta;
    US.users = list.users;
    usWire();
    usRender();
    if (msg) msg.classList.remove("show");
  } catch (e) {
    if (msg) showMsg(msg, e.message, false);
  }
}

function usWire() {
  if (US.wired) return;
  US.wired = true;
  usEl("us-add-btn").addEventListener("click", () => usOpenEditor(null));
  usEl("us-search").addEventListener("input", (e) => { US.q = e.target.value.trim().toLowerCase(); usRender(); });
  usEl("us-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-us-filter]");
    if (!b) return;
    US.filter = b.dataset.usFilter;
    usRender();
  });
  usEl("us-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-us-act]");
    if (!b) return;
    const card = b.closest("[data-u]");
    usAct(b.dataset.usAct, card.dataset.u);
  });
  usEl("us-list").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-us-more]");
    if (!sel || !sel.value) return;
    const act = sel.value;
    sel.value = "";
    usAct(act, sel.closest("[data-u]").dataset.u);
  });
  // editor
  usEl("us-edit-x").addEventListener("click", usCloseEditor);
  usEl("us-edit-cancel").addEventListener("click", usCloseEditor);
  usEl("us-edit-save").addEventListener("click", usSaveEditor);
  usEl("us-f-level").addEventListener("change", () => usLevelChanged(true));
  usEl("us-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-us-preset]");
    if (!b) return;
    const keys = b.dataset.usPreset ? US_PRESETS[b.dataset.usPreset] : [];
    usEl("us-mod-grid").querySelectorAll("input[data-mod]").forEach((cb) => {
      if (!cb.disabled) cb.checked = keys.includes(cb.dataset.mod);
    });
  });
  // share dialogs
  usEl("us-share-done").addEventListener("click", () => usEl("us-share-modal").classList.add("hidden"));
  usEl("us-share-copy").addEventListener("click", async () => {
    const ok = await usCopy(US.shareText);
    if (ok) showMsg(usEl("us-share-msg"), t("usShareCopied"), true);
  });
  usEl("us-reissue-cancel").addEventListener("click", () => usEl("us-reissue-modal").classList.add("hidden"));
  usEl("us-reissue-go").addEventListener("click", usReissueGo);
}

function usFilteredUsers() {
  return US.users.filter((u) => {
    if (US.filter !== "all" && u.status !== US.filter) return false;
    if (US.q && !(`${u.name} ${u.username} ${u.title}`.toLowerCase().includes(US.q))) return false;
    return true;
  });
}
function usRender() {
  // filter chips with counts
  const counts = { all: US.users.length };
  US_STATUSES.forEach((s) => (counts[s] = US.users.filter((u) => u.status === s).length));
  usEl("us-chips").innerHTML = ["all"].concat(US_STATUSES.filter((s) => counts[s] > 0))
    .map((s) => `<button type="button" class="us-chip${US.filter === s ? " active" : ""}" data-us-filter="${s}">${usEsc(s === "all" ? t("usAll") : t(US_STATUS_KEY[s]))} <b>${counts[s]}</b></button>`)
    .join("");
  const rows = usFilteredUsers();
  const me = CURRENT_SESSION && CURRENT_SESSION.staff ? CURRENT_SESSION.staff.username : "";
  const total = US.meta ? US.meta.modules.length : 15;
  usEl("us-list").innerHTML = rows.length
    ? rows.map((u) => {
        const eff = Object.values(u.effectiveModules || {}).filter(Boolean).length;
        const custom = u.role === "admin" ? !u.fullAdmin : !!u.modules;
        const more = [
          u.locked ? `<option value="unlock">${usEsc(t("usUnlock"))}</option>` : "",
          u.twoFactor && u.username !== me ? `<option value="reset2fa">${usEsc(t("usReset2fa"))}</option>` : "",
          u.activeSessions ? `<option value="signout">${usEsc(t("usSignOutAll"))}</option>` : "",
          u.username !== me ? `<option value="${u.disabled ? "enable" : "disable"}">${usEsc(t(u.disabled ? "usEnable" : "usDisable"))}</option>` : "",
          u.username !== me ? `<option value="delete">${usEsc(t("usDelete"))}</option>` : "",
        ].join("");
        return `<div class="us-user st-${u.status}" data-u="${usEsc(u.username)}">
          <div class="us-avatar" aria-hidden="true">${usEsc(usInitials(u.name))}</div>
          <div class="us-main">
            <div class="us-name"><span>${usEsc(u.name)}</span> <span class="us-pill st-${u.status}">${usEsc(t(US_STATUS_KEY[u.status]))}</span></div>
            <div class="us-sub"><bdi dir="ltr">@${usEsc(u.username)}</bdi>${u.title ? ` · ${usEsc(u.title)}` : ""}</div>
            <div class="us-level">${usEsc(usShortLevel(u))}${custom ? ` <span class="us-badge">${usEsc(t("usCustomBadge"))}</span>` : ""} <span class="us-count">${usEsc(usF("usAreasCount", { n: eff, total }))}</span></div>
            <div class="us-meta">
              <span>${usEsc(t("usColLast"))}: ${u.lastLoginAt ? usEsc(usDate(u.lastLoginAt, true)) : usEsc(t("usNever"))}</span>
              <span class="us-2fa ${u.twoFactor ? "on" : "off"}">${usEsc(t(u.twoFactor ? "usTwoStepOn" : "usTwoStepOff"))}</span>
              ${u.invitePending ? `<span>${usEsc(usF("usInviteUntil", { date: usDate(u.invitePending.expiresAt, true) }))}</span>` : ""}
              ${u.activeSessions ? `<span>${usEsc(usF("usSessions", { n: u.activeSessions }))}</span>` : ""}
            </div>
          </div>
          <div class="us-actions">
            <button type="button" class="secondary small" data-us-act="edit">${usEsc(t("usEdit"))}</button>
            ${u.username !== me ? `<button type="button" class="secondary small" data-us-act="share">${usEsc(t("usShareAccess"))}</button>` : ""}
            ${more ? `<select class="us-more" data-us-more aria-label="${usEsc(t("usMore"))}"><option value="">${usEsc(t("usMore"))}…</option>${more}</select>` : ""}
          </div>
        </div>`;
      }).join("")
    : `<p class="dashboard-empty-note">${usEsc(t("usNone"))}</p>`;
}

async function usAct(act, username) {
  const u = US.users.find((x) => x.username === username);
  if (!u) return;
  const msg = usEl("us-msg");
  try {
    if (act === "edit") return usOpenEditor(u);
    if (act === "share") return usOpenReissue(u);
    if (act === "unlock") await api(`/api/admin/users/${encodeURIComponent(username)}/unlock`, { method: "POST" });
    else if (act === "reset2fa") { if (!confirm(usF("usConfirmReset2fa", { name: u.name }))) return; await api(`/api/admin/users/${encodeURIComponent(username)}/reset-2fa`, { method: "POST" }); }
    else if (act === "signout") { if (!confirm(usF("usConfirmSignOut", { name: u.name }))) return; await api(`/api/admin/users/${encodeURIComponent(username)}/revoke-sessions`, { method: "POST" }); }
    else if (act === "disable") { if (!confirm(usF("usConfirmDisable", { name: u.name }))) return; await api(`/api/admin/users/${encodeURIComponent(username)}/status`, { method: "POST", body: JSON.stringify({ disabled: true }) }); }
    else if (act === "enable") await api(`/api/admin/users/${encodeURIComponent(username)}/status`, { method: "POST", body: JSON.stringify({ disabled: false }) });
    else if (act === "delete") { if (!confirm(usF("usConfirmDelete", { name: u.name }))) return; await api(`/api/staff/accounts/${encodeURIComponent(username)}`, { method: "DELETE" }); }
    showMsg(msg, t(act === "unlock" ? "usUnlocked" : "usDone"), true);
    await usLoad();
    if (typeof loadStaffAccountsTable === "function") loadStaffAccountsTable().catch(() => {});
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// ---- editor ----
function usModuleDefaults(level) {
  // which switches start ticked for each level
  const base = (US.meta.roles.find((r) => r.role === level) || { base: {} }).base;
  return base;
}
function usOpenEditor(user) {
  US.editing = user;
  const isNew = !user;
  const me = CURRENT_SESSION.staff.username;
  const self = !isNew && user.username === me;
  usEl("us-edit-title").textContent = isNew ? t("usNewTitle") : usF("usEditTitle", { name: user.name });
  usEl("us-f-name").value = isNew ? "" : user.name;
  usEl("us-f-username").value = isNew ? "" : user.username;
  usEl("us-f-username").disabled = !isNew;
  usEl("us-f-title").value = isNew ? "" : user.title || "";
  usEl("us-f-phone").value = isNew ? "" : user.phone || "";
  const sel = usEl("us-f-level");
  const levels = (US.meta.actorFull ? ["full"] : []).concat(["custom", "tournament", "staff", "management", "partner"]);
  sel.innerHTML = levels.map((l) => `<option value="${l}">${usEsc(usLevelLabel(l))}</option>`).join("");
  sel.value = isNew ? "custom" : usLevelOf(user);
  if (![...sel.options].some((o) => o.value === sel.value)) {
    const keep = usLevelOf(user);
    sel.insertAdjacentHTML("afterbegin", `<option value="${keep}">${usEsc(usLevelLabel(keep))}</option>`);
    sel.value = keep;
  }
  sel.disabled = self;
  usEl("us-f-cce").checked = !isNew && user.canCreateEvents === true;
  usEl("us-share-wrap").classList.toggle("hidden", !isNew);
  document.querySelector('input[name="us-share"][value="invite"]').checked = true;
  usEl("us-edit-save").textContent = isNew ? t("usCreate") : t("usSaveChanges");
  usEl("us-edit-msg").classList.remove("show");
  usBuildGrid(isNew ? null : user, self);
  usLevelChanged(false);
  usEl("us-edit-modal").classList.remove("hidden");
  setTimeout(() => (isNew ? usEl("us-f-name") : usEl("us-f-title")).focus(), 50);
}
function usCloseEditor() {
  usEl("us-edit-modal").classList.add("hidden");
}
function usBuildGrid(user, self) {
  const actor = US.meta.actorModules;
  const level = usEl("us-f-level").value;
  const cur = user ? user.effectiveModules : {};
  const base = usModuleDefaults(level === "custom" || level === "full" ? "admin" : level);
  usEl("us-mod-grid").innerHTML = US.meta.modules.map((m) => {
    const fixedOff = !base[m.key]; // the role never reaches this module
    const mine = !!actor[m.key];
    const checked = user ? !!cur[m.key] : (level === "custom" ? false : !!base[m.key]);
    const disabled = self || fixedOff || !mine;
    return `<label class="us-mod${disabled ? " off" : ""}${m.sensitive ? " sens" : ""}" ${!mine && !fixedOff ? `title="${usEsc(t("usYouLack"))}"` : ""}>
      <input type="checkbox" data-mod="${m.key}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span>${usEsc(t("modName_" + m.key))}${m.sensitive ? ` <em>${usEsc(t("usSensitive"))}</em>` : ""}</span>
    </label>`;
  }).join("");
  usEl("us-presets").innerHTML = Object.keys(US_PRESETS)
    .map((k) => `<button type="button" class="us-chip" data-us-preset="${k}">${usEsc(t(k))}</button>`)
    .join("") + `<button type="button" class="us-chip" data-us-preset="">${usEsc(t("usPresetClear"))}</button>`;
}
function usLevelChanged(rebuild) {
  const level = usEl("us-f-level").value;
  if (rebuild) usBuildGrid(null, false);
  usEl("us-level-hint").textContent = t({ full: "usLevelFullHint", custom: "usLevelCustomHint", tournament: "usLevelTournamentHint", staff: "usLevelStaffHint", management: "usLevelManagementHint", partner: "usLevelPartnerHint" }[level]);
  usEl("us-modules-wrap").classList.toggle("hidden", level === "full" || level === "partner");
  usEl("us-presets").classList.toggle("hidden", level !== "custom");
  usEl("us-modules-label").textContent = t(level === "custom" ? "usFModules" : "usFModulesNarrow");
  usEl("us-cce-wrap").classList.toggle("hidden", level !== "tournament");
}
function usReadModules() {
  const out = {};
  usEl("us-mod-grid").querySelectorAll("input[data-mod]").forEach((cb) => (out[cb.dataset.mod] = cb.checked));
  return out;
}
async function usSaveEditor() {
  const msg = usEl("us-edit-msg");
  const level = usEl("us-f-level").value;
  const user = US.editing;
  const body = {
    name: usEl("us-f-name").value.trim(),
    title: usEl("us-f-title").value.trim(),
    phone: usEl("us-f-phone").value.trim(),
  };
  if (!body.name || (!user && !usEl("us-f-username").value.trim())) {
    highlightMissingFields(["us-f-name", "us-f-username"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const self = user && user.username === CURRENT_SESSION.staff.username;
  if (!self) {
    body.role = level === "full" || level === "custom" ? "admin" : level;
    if (level === "full") body.fullAdmin = true;
    else if (level === "custom") body.modules = usReadModules();
    else if (level !== "partner") {
      const base = usModuleDefaults(level);
      const picked = usReadModules();
      const same = Object.keys(base).every((k) => !!base[k] === !!picked[k] || !base[k]);
      body.modules = same ? (user ? null : undefined) : picked;
    }
    if (level === "tournament") body.canCreateEvents = usEl("us-f-cce").checked;
  }
  try {
    if (!user) {
      body.username = usEl("us-f-username").value.trim();
      body.share = document.querySelector('input[name="us-share"]:checked').value;
      const r = await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
      usCloseEditor();
      await usLoad();
      usShowShare(r);
    } else {
      await api(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: "PUT", body: JSON.stringify(body) });
      usCloseEditor();
      showMsg(usEl("us-msg"), t("usSaved"), true);
      await usLoad();
      if (self) {
        const me = await api("/api/auth/me");
        CURRENT_SESSION.staff = me.staff;
      }
    }
    if (typeof loadStaffAccountsTable === "function") loadStaffAccountsTable().catch(() => {});
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// ---- send access ----
function usOpenReissue(user) {
  US.reissue = user;
  usEl("us-reissue-title").textContent = usF("usReissueTitle", { name: user.name });
  usEl("us-reissue-warn").textContent = usF("usConfirmReissue", { name: user.name });
  document.querySelector('input[name="us-reshare"][value="invite"]').checked = true;
  usEl("us-reissue-msg").classList.remove("show");
  usEl("us-reissue-modal").classList.remove("hidden");
}
async function usReissueGo() {
  const user = US.reissue;
  const msg = usEl("us-reissue-msg");
  try {
    const share = document.querySelector('input[name="us-reshare"]:checked').value;
    const r = await api(`/api/admin/users/${encodeURIComponent(user.username)}/access`, { method: "POST", body: JSON.stringify({ share }) });
    usEl("us-reissue-modal").classList.add("hidden");
    await usLoad();
    usShowShare(r);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
function usShowShare(r) {
  const u = r.user;
  const level = usShortLevel(u);
  const isInvite = r.share === "invite";
  const text = isInvite
    ? usF("usWaInvite", { name: u.name, level, url: r.inviteUrl })
    : usF("usWaTemp", { name: u.name, url: r.loginUrl, user: u.username, pw: r.tempPassword });
  US.shareText = text;
  usEl("us-share-title").textContent = usF("usShareTitle", { name: u.name });
  usEl("us-share-body").innerHTML = isInvite
    ? `<label>${usEsc(t("usShareLinkLabel"))}</label><input class="us-secret" readonly dir="ltr" value="${usEsc(r.inviteUrl)}" />
       <p class="hint-note">${usEsc(usF("usInviteUntil", { date: usDate(r.expiresAt, true) }))}</p>`
    : `<label>${usEsc(t("usShareLoginLabel"))}</label><input class="us-secret" readonly dir="ltr" value="${usEsc(r.loginUrl)}" />
       <label>${usEsc(t("fieldUsername"))}</label><input class="us-secret" readonly dir="ltr" value="${usEsc(u.username)}" />
       <label>${usEsc(t("usShareTempLabel"))}</label><input class="us-secret strong" readonly dir="ltr" value="${usEsc(r.tempPassword)}" />`;
  const wa = usEl("us-share-wa");
  const href = r.phone && typeof waLink === "function" ? waLink(r.phone, text) : "";
  wa.classList.toggle("hidden", !href);
  if (href) wa.href = href;
  usEl("us-share-note").textContent = href ? t("usShareOnce") : `${t("usShareOnce")} ${t("usShareNoPhone")}`;
  usEl("us-share-msg").classList.remove("show");
  usEl("us-share-modal").classList.remove("hidden");
  usEl("us-share-body").querySelectorAll(".us-secret").forEach((i) => i.addEventListener("focus", () => i.select()));
}

// ============================================================ Security centre ====
const SC = { overview: null, log: { q: "", type: "", offset: 0, entries: [], total: 0, types: [] }, audit: { q: "", action: "", offset: 0, entries: [], total: 0, actions: [] }, wired: false };
async function scLoad() {
  const msg = usEl("sc-msg");
  try {
    const [ov, sess, log, audit] = await Promise.all([
      api("/api/admin/security/overview"),
      api("/api/admin/security/sessions"),
      api("/api/admin/security/log?limit=25"),
      api("/api/admin/activity-log?limit=25"),
    ]);
    SC.overview = ov;
    SC.sessions = sess.sessions;
    Object.assign(SC.log, { entries: log.entries, total: log.total, types: log.types, offset: 0 });
    Object.assign(SC.audit, { entries: audit.entries, total: audit.total, actions: audit.actions, offset: 0 });
    scWire();
    scRenderAll();
    msg.classList.remove("show");
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
function scRenderAll() {
  scRenderOverview();
  scRenderRules();
  scRenderMy2fa();
  scRenderSessions();
  scRenderLog();
  scRenderAudit();
}
function scScoreColor(n) { return n >= 80 ? "var(--green)" : n >= 50 ? "var(--amber)" : "#b3261e"; }
function scRenderOverview() {
  const ov = SC.overview;
  const C = 2 * Math.PI * 46;
  const checks = ov.checks.map((c) => `<li class="sc-check ${c.ok ? "ok" : "bad"}"><span class="sc-dot" aria-hidden="true"></span><span>${usEsc(t("scChk_" + c.id))}${c.value !== undefined && c.id !== "idle" ? ` <b dir="ltr">${usEsc(c.value)}</b>` : ""}${!c.ok && c.id === "secret" ? `<small>${usEsc(t("scChk_secret_fix"))}</small>` : ""}</span></li>`).join("");
  const alerts = ov.alerts.length
    ? ov.alerts.map((a) => `<li class="sc-alert ${a.severity}"><b>${usEsc(t("scAl_" + a.type))}</b>${a.count > 1 ? ` <span class="us-count">×${a.count}</span>` : ""}${a.detail ? `<small dir="auto">${usEsc(a.detail)}</small>` : ""}</li>`).join("")
    : `<li class="sc-alert none">${usEsc(t("scNoAlerts"))}</li>`;
  const k = ov.counts;
  usEl("sc-overview").innerHTML = `
    <div class="sc-top">
      <div class="sc-score" role="img" aria-label="${usEsc(t("scScore"))} ${ov.score}">
        <svg viewBox="0 0 110 110" width="132" height="132"><circle cx="55" cy="55" r="46" fill="none" stroke="var(--border)" stroke-width="9"/><circle cx="55" cy="55" r="46" fill="none" stroke="${scScoreColor(ov.score)}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(C * ov.score) / 100} ${C}" transform="rotate(-90 55 55)"/></svg>
        <div class="sc-score-n" style="color:${scScoreColor(ov.score)}">${ov.score}</div>
        <div class="sc-score-l">${usEsc(t("scScore"))}</div>
      </div>
      <div class="sc-tiles">
        <div class="sc-tile"><b>${k.sessions}</b><span>${usEsc(t("scSessions"))}</span></div>
        <div class="sc-tile"><b>${k.with2fa}/${k.active}</b><span>${usEsc(t("usTwoStepOn"))}</span></div>
        <div class="sc-tile${k.failed24h ? " warn" : ""}"><b>${k.failed24h}</b><span>${usEsc(t("ev_login_failed"))} · 24h</span></div>
        <div class="sc-tile${k.locked ? " bad" : ""}"><b>${k.locked}</b><span>${usEsc(t("usStatusLocked"))}</span></div>
      </div>
    </div>
    <div class="sc-cols">
      <div><h3>${usEsc(t("scChecks"))}</h3><p class="hint-note">${usEsc(t("scScoreHint"))}</p><ul class="sc-checks">${checks}</ul></div>
      <div><h3>${usEsc(t("scAlerts"))}</h3><ul class="sc-alerts">${alerts}</ul></div>
    </div>`;
}
function scRenderRules() {
  const s = SC.overview.settings;
  const opt = (v, k) => `<option value="${v}" ${s.require2fa === v ? "selected" : ""}>${usEsc(t(k))}</option>`;
  usEl("sc-rules").innerHTML = `
    <h2>${usEsc(t("scSettings"))}</h2>
    <div class="grid-2">
      <div><label for="sc-r-2fa">${usEsc(t("scRequire2fa"))}</label>
        <select id="sc-r-2fa">${opt("off", "scReq_off")}${opt("admin", "scReq_admin")}${opt("all", "scReq_all")}</select>
        <p class="hint-note">${usEsc(t("scReqHint"))}</p></div>
      <div><label for="sc-r-idle">${usEsc(t("scIdle"))}</label><input id="sc-r-idle" type="number" min="0" max="1440" value="${s.idleMinutes}" /></div>
      <div><label for="sc-r-lt">${usEsc(t("scLockThreshold"))}</label><input id="sc-r-lt" type="number" min="3" max="20" value="${s.lockoutThreshold}" /></div>
      <div><label for="sc-r-lm">${usEsc(t("scLockMinutes"))}</label><input id="sc-r-lm" type="number" min="1" max="1440" value="${s.lockoutMinutes}" /></div>
    </div>
    <p class="hint-note">${usEsc(t("scPwRule"))}</p>
    <button class="primary" type="button" id="sc-r-save">${usEsc(t("scSave"))}</button>
    <div class="msg" id="sc-r-msg"></div>`;
}
function scRenderMy2fa() {
  const me = CURRENT_SESSION.staff;
  usEl("sc-my2fa").innerHTML = `
    <h2>${usEsc(t("scMy2fa"))} <span class="us-pill ${me.twoFactorEnabled ? "st-active" : "st-disabled"}">${usEsc(t(me.twoFactorEnabled ? "scOn" : "scOff"))}</span></h2>
    <p class="section-sub">${usEsc(t("scMy2faHint"))}</p>
    ${me.twoFactorEnabled ? `<p class="hint-note">${usEsc(usF("scBackupLeft", { n: me.backupCodesLeft || 0 }))}</p>` : ""}
    <div class="us-row-actions">
      ${me.twoFactorEnabled
        ? `<button class="secondary" type="button" id="sc-2fa-codes">${usEsc(t("scNewCodes"))}</button><button class="secondary" type="button" id="sc-2fa-off">${usEsc(t("scDisable"))}</button>`
        : `<button class="primary" type="button" id="sc-2fa-on">${usEsc(t("scEnable"))}</button>`}
    </div>`;
}
function scRenderSessions() {
  const rows = SC.sessions;
  usEl("sc-sessions").innerHTML = `<h2>${usEsc(t("scSessions"))}</h2>` + (rows.length
    ? `<div class="us-table-wrap"><table class="us-table"><thead><tr><th>${usEsc(t("scSessUser"))}</th><th>${usEsc(t("scSessDevice"))}</th><th>${usEsc(t("scSessSince"))}</th><th>${usEsc(t("scSessLast"))}</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td><b>${usEsc(r.name)}</b><br><small dir="ltr">@${usEsc(r.username)}</small></td>
      <td><small dir="ltr">${usEsc(r.ip)}</small><br><small class="us-ua" title="${usEsc(r.ua)}">${usEsc(scUa(r.ua))}</small></td>
      <td>${usEsc(usDate(r.createdAt, true))}</td><td>${usEsc(usDate(r.lastSeen, true))}</td>
      <td>${r.current ? `<span class="us-badge">${usEsc(t("scSessCurrent"))}</span>` : `<button type="button" class="secondary small" data-sc-end="${usEsc(r.id)}">${usEsc(t("scSessEnd"))}</button>`}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="dashboard-empty-note">${usEsc(t("scSessNone"))}</p>`);
}
function scUa(ua) {
  const s = String(ua || "");
  const os = /Windows/i.test(s) ? "Windows" : /iPhone|iPad|iOS/i.test(s) ? "iOS" : /Android/i.test(s) ? "Android" : /Mac OS/i.test(s) ? "macOS" : /Linux/i.test(s) ? "Linux" : "";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || (s ? s.slice(0, 30) : "—");
}
const SC_EVENT_ICON = { high: "high", warn: "warn", info: "info" };
function scRenderLog() {
  const L = SC.log;
  const typeOpts = [`<option value="">${usEsc(t("scLogAllTypes"))}</option>`].concat(L.types.map((x) => `<option value="${usEsc(x)}" ${L.type === x ? "selected" : ""}>${usEsc(scEventName(x))}</option>`)).join("");
  usEl("sc-log").innerHTML = `
    <div class="us-head"><h2>${usEsc(t("scLog"))}</h2><button class="secondary small" type="button" id="sc-log-export">${usEsc(t("scLogExport"))}</button></div>
    <div class="us-tools"><input id="sc-log-q" type="search" placeholder="${usEsc(t("scLogSearch"))}" value="${usEsc(L.q)}" /><select id="sc-log-type">${typeOpts}</select></div>
    ${L.entries.length ? `<div class="us-table-wrap"><table class="us-table"><thead><tr><th>${usEsc(t("scSessSince"))}</th><th></th><th>${usEsc(t("scSessUser"))}</th><th>IP</th><th></th></tr></thead><tbody>${L.entries.map((e) => `<tr class="sev-${SC_EVENT_ICON[e.severity] || "info"}">
      <td>${usEsc(usDate(e.at, true))}</td><td><b>${usEsc(scEventName(e.type))}</b></td><td dir="ltr">${usEsc(e.username)}</td><td dir="ltr">${usEsc(e.ip)}</td><td><small dir="auto">${usEsc(e.details)}</small></td></tr>`).join("")}</tbody></table></div>
      ${L.entries.length < L.total ? `<button class="secondary small" type="button" id="sc-log-more" style="margin-top:8px;">${usEsc(t("scLogMore"))} (${L.total - L.entries.length})</button>` : ""}`
      : `<p class="dashboard-empty-note">${usEsc(t("scLogEmpty"))}</p>`}`;
}
function scEventName(type) {
  const k = "ev_" + type;
  const v = t(k);
  return v === k ? type : v;
}
function scRenderAudit() {
  const A = SC.audit;
  const actOpts = [`<option value="">${usEsc(t("scAuditAllActions"))}</option>`].concat(A.actions.map((x) => `<option value="${usEsc(x)}" ${A.action === x ? "selected" : ""}>${usEsc(x)}</option>`)).join("");
  usEl("sc-audit").innerHTML = `
    <div class="us-head"><div><h2>${usEsc(t("scAudit"))}</h2><p class="section-sub">${usEsc(t("scAuditHint"))}</p></div>
      <div class="us-row-actions"><button class="secondary small" type="button" id="sc-verify">${usEsc(t("scVerify"))}</button><button class="secondary small" type="button" id="sc-audit-export">${usEsc(t("scLogExport"))}</button></div></div>
    <div class="msg" id="sc-verify-msg"></div>
    <div class="us-tools"><input id="sc-audit-q" type="search" placeholder="${usEsc(t("scLogSearch"))}" value="${usEsc(A.q)}" /><select id="sc-audit-action">${actOpts}</select></div>
    ${A.entries.length ? `<div class="us-table-wrap"><table class="us-table"><thead><tr><th>${usEsc(t("scSessSince"))}</th><th>${usEsc(t("scSessUser"))}</th><th></th><th></th></tr></thead><tbody>${A.entries.map((e) => `<tr>
      <td>${usEsc(usDate(e.at, true))}</td><td>${usEsc(e.actorName || e.actorId)}<br><small dir="ltr">${usEsc(e.actorId)}</small></td><td><code>${usEsc(e.action)}</code></td><td><small dir="auto">${usEsc(e.details)}</small></td></tr>`).join("")}</tbody></table></div>
      ${A.entries.length < A.total ? `<button class="secondary small" type="button" id="sc-audit-more" style="margin-top:8px;">${usEsc(t("scLogMore"))} (${A.total - A.entries.length})</button>` : ""}`
      : `<p class="dashboard-empty-note">${usEsc(t("scAuditEmpty"))}</p>`}`;
}
async function scFetchLog(append) {
  const L = SC.log;
  const p = new URLSearchParams({ limit: "25", offset: String(append ? L.entries.length : 0) });
  if (L.q) p.set("q", L.q);
  if (L.type) p.set("type", L.type);
  const r = await api("/api/admin/security/log?" + p.toString());
  L.entries = append ? L.entries.concat(r.entries) : r.entries;
  L.total = r.total;
  L.types = r.types;
  scRenderLog();
  const q = usEl("sc-log-q");
  if (q && !append) q.focus(), q.setSelectionRange(q.value.length, q.value.length);
}
async function scFetchAudit(append) {
  const A = SC.audit;
  const p = new URLSearchParams({ limit: "25", offset: String(append ? A.entries.length : 0) });
  if (A.q) p.set("q", A.q);
  if (A.action) p.set("action", A.action);
  const r = await api("/api/admin/activity-log?" + p.toString());
  A.entries = append ? A.entries.concat(r.entries) : r.entries;
  A.total = r.total;
  A.actions = r.actions;
  scRenderAudit();
  const q = usEl("sc-audit-q");
  if (q && !append) q.focus(), q.setSelectionRange(q.value.length, q.value.length);
}
function scDebounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
function scWire() {
  if (SC.wired) return;
  SC.wired = true;
  const fetchLogSoon = scDebounce(() => scFetchLog(false).catch((e) => showMsg(usEl("sc-msg"), e.message, false)), 350);
  const fetchAuditSoon = scDebounce(() => scFetchAudit(false).catch((e) => showMsg(usEl("sc-msg"), e.message, false)), 350);
  ["sc-rules-card", "sc-my2fa-card", "sc-sessions-card", "sc-log-card", "sc-audit-card"].forEach((id) => {
    const card = usEl(id);
    card.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      try {
        if (b.id === "sc-r-save") {
          const body = { require2fa: usEl("sc-r-2fa").value, idleMinutes: Number(usEl("sc-r-idle").value), lockoutThreshold: Number(usEl("sc-r-lt").value), lockoutMinutes: Number(usEl("sc-r-lm").value) };
          const r = await api("/api/admin/security/settings", { method: "PUT", body: JSON.stringify(body) });
          SC.overview.settings = r.settings;
          showMsg(usEl("sc-r-msg"), t("scSaved"), true);
          api("/api/admin/security/overview").then((ov) => { SC.overview = ov; scRenderOverview(); }).catch(() => {});
        } else if (b.id === "sc-2fa-on") tfOpenSetup(false);
        else if (b.id === "sc-2fa-off") tfOpenManage("disable");
        else if (b.id === "sc-2fa-codes") tfOpenManage("codes");
        else if (b.dataset.scEnd) {
          await api("/api/admin/security/sessions/" + encodeURIComponent(b.dataset.scEnd), { method: "DELETE" });
          SC.sessions = (await api("/api/admin/security/sessions")).sessions;
          scRenderSessions();
        } else if (b.id === "sc-log-more") await scFetchLog(true);
        else if (b.id === "sc-audit-more") await scFetchAudit(true);
        else if (b.id === "sc-log-export") {
          const p = new URLSearchParams();
          if (SC.log.q) p.set("q", SC.log.q);
          if (SC.log.type) p.set("type", SC.log.type);
          window.location.href = "/api/admin/security/log/export.xlsx?" + p.toString();
        } else if (b.id === "sc-audit-export") {
          const p = new URLSearchParams();
          if (SC.audit.q) p.set("q", SC.audit.q);
          if (SC.audit.action) p.set("action", SC.audit.action);
          window.location.href = "/api/admin/activity-log/export.xlsx?" + p.toString();
        } else if (b.id === "sc-verify") {
          const r = await api("/api/admin/security/verify");
          const m = usEl("sc-verify-msg");
          const bad = r.activity.broken || r.security.broken;
          if (bad) {
            const where = r.activity.broken || r.security.broken;
            showMsg(m, usF("scVerifyBad", { id: where.id }), false);
          } else if (!r.activity.headOk || !r.security.headOk) showMsg(m, t("scVerifyHead"), false);
          else {
            const legacy = r.activity.legacy + r.security.legacy;
            showMsg(m, usF("scVerifyOk", { n: r.activity.hashed + r.security.hashed }) + (legacy ? " " + usF("scVerifyLegacy", { n: legacy }) : ""), true);
          }
        }
      } catch (err) {
        showMsg(usEl("sc-msg"), err.message, false);
      }
    });
    card.addEventListener("input", (e) => {
      if (e.target.id === "sc-log-q") { SC.log.q = e.target.value.trim(); fetchLogSoon(); }
      if (e.target.id === "sc-audit-q") { SC.audit.q = e.target.value.trim(); fetchAuditSoon(); }
    });
    card.addEventListener("change", (e) => {
      if (e.target.id === "sc-log-type") { SC.log.type = e.target.value; scFetchLog(false).catch(() => {}); }
      if (e.target.id === "sc-audit-action") { SC.audit.action = e.target.value; scFetchAudit(false).catch(() => {}); }
    });
  });
}

// ============================================================ 2-step login ====
// ---- sign-in prompt ----
function usAskSecondFactor(challenge) {
  return new Promise((resolve, reject) => {
    const modal = usEl("tf-login-modal");
    const input = usEl("tf-login-code");
    const msg = usEl("tf-login-msg");
    const go = usEl("tf-login-go");
    const cancel = usEl("tf-login-cancel");
    input.value = "";
    msg.classList.remove("show");
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
    const done = () => {
      modal.classList.add("hidden");
      go.removeEventListener("click", submit);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
    };
    const onCancel = () => { done(); resolve(null); };
    const onKey = (e) => { if (e.key === "Enter") submit(); };
    const submit = async () => {
      const code = input.value.trim();
      if (!code) { highlightMissingFields(["tf-login-code"]); return; }
      go.disabled = true;
      try {
        const r = await api("/api/auth/staff-login/2fa", { method: "POST", body: JSON.stringify({ challenge, code }) });
        done();
        resolve(r);
      } catch (e) {
        const gone = e.data && (e.data.code === "challenge_expired" || e.data.code === "account_locked");
        if (gone) { done(); reject(e); }
        else { showMsg(msg, e.message || t("tfBadCode"), false); input.select(); }
      } finally {
        go.disabled = false;
      }
    };
    go.addEventListener("click", submit);
    cancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
  });
}

// ---- set-up (own account) ----
const TF = { forced: false, open: false, wired: false };
function tfWire() {
  if (TF.wired) return;
  TF.wired = true;
  usEl("tf-setup-start").addEventListener("click", tfStart);
  usEl("tf-setup-activate").addEventListener("click", tfActivate);
  usEl("tf-setup-cancel").addEventListener("click", tfCloseSetup);
  usEl("tf-setup-cancel2").addEventListener("click", tfCloseSetup);
  usEl("tf-codes-done").addEventListener("click", tfFinish);
  usEl("tf-codes-copy").addEventListener("click", () => usCopy(usEl("tf-codes").textContent.trim().split(/\s+/).join("\n")));
  usEl("tf-gate-logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    CURRENT_SESSION = null;
    tfCloseSetup(true);
    updateUIForSession();
  });
  usEl("tf-manage-cancel").addEventListener("click", () => usEl("tf-manage-modal").classList.add("hidden"));
  usEl("tf-manage-go").addEventListener("click", tfManageGo);
}
function tfOpenSetup(forced) {
  tfWire();
  TF.forced = !!forced;
  TF.open = true;
  usEl("tf-step-pass").classList.remove("hidden");
  usEl("tf-step-scan").classList.add("hidden");
  usEl("tf-step-codes").classList.add("hidden");
  usEl("tf-setup-pass").value = "";
  usEl("tf-setup-code").value = "";
  usEl("tf-setup-msg").classList.remove("show");
  usEl("tf-gate-body").classList.toggle("hidden", !forced);
  usEl("tf-gate-out").classList.toggle("hidden", !forced);
  usEl("tf-setup-cancel").classList.toggle("hidden", !!forced);
  usEl("tf-setup-cancel2").classList.toggle("hidden", !!forced);
  usEl("tf-setup-title").textContent = t(forced ? "tfGateTitle" : "tfSetupTitle");
  usEl("tf-setup-modal").classList.remove("hidden");
  setTimeout(() => usEl("tf-setup-pass").focus(), 50);
}
function tfCloseSetup(force) {
  if (TF.forced && !force) return;
  TF.open = false;
  usEl("tf-setup-modal").classList.add("hidden");
}
async function tfStart() {
  const msg = usEl("tf-setup-msg");
  const password = usEl("tf-setup-pass").value;
  if (!password) { highlightMissingFields(["tf-setup-pass"]); return; }
  try {
    const r = await api("/api/auth/2fa/setup", { method: "POST", body: JSON.stringify({ password }) });
    usEl("tf-qr").src = r.qr;
    usEl("tf-secret").textContent = r.secret;
    usEl("tf-step-pass").classList.add("hidden");
    usEl("tf-step-scan").classList.remove("hidden");
    msg.classList.remove("show");
    usEl("tf-setup-code").focus();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
async function tfActivate() {
  const msg = usEl("tf-setup-msg");
  const code = usEl("tf-setup-code").value.trim();
  if (!code) { highlightMissingFields(["tf-setup-code"]); return; }
  try {
    const r = await api("/api/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code }) });
    CURRENT_SESSION.staff = r.staff;
    tfShowCodes(r.backupCodes);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
function tfShowCodes(codes) {
  tfWire();
  usEl("tf-codes").innerHTML = codes.map((c) => `<span>${usEsc(c)}</span>`).join(" ");
  usEl("tf-step-pass").classList.add("hidden");
  usEl("tf-step-scan").classList.add("hidden");
  usEl("tf-step-codes").classList.remove("hidden");
  usEl("tf-gate-body").classList.add("hidden");
  usEl("tf-gate-out").classList.add("hidden");
  usEl("tf-setup-title").textContent = t("tfBackupTitle");
  usEl("tf-setup-msg").classList.remove("show");
  usEl("tf-setup-modal").classList.remove("hidden");
}
function tfFinish() {
  TF.forced = false;
  TF.open = false;
  usEl("tf-setup-modal").classList.add("hidden");
  updateUIForSession();
  if (SC.wired) scRenderMy2fa();
  if (SC.overview) api("/api/admin/security/overview").then((ov) => { SC.overview = ov; scRenderOverview(); }).catch(() => {});
}
// ---- turn off / new backup codes ----
const TFM = { mode: "" };
function tfOpenManage(mode) {
  tfWire();
  TFM.mode = mode;
  usEl("tf-manage-title").textContent = t(mode === "disable" ? "tfDisableTitle" : "tfNewCodesTitle");
  usEl("tf-manage-body").textContent = t(mode === "disable" ? "tfDisableBody" : "tfNewCodesBody");
  usEl("tf-manage-pass").value = "";
  usEl("tf-manage-code").value = "";
  usEl("tf-manage-msg").classList.remove("show");
  usEl("tf-manage-modal").classList.remove("hidden");
  setTimeout(() => usEl("tf-manage-pass").focus(), 50);
}
async function tfManageGo() {
  const msg = usEl("tf-manage-msg");
  const password = usEl("tf-manage-pass").value;
  const code = usEl("tf-manage-code").value.trim();
  if (!password || !code) { highlightMissingFields(["tf-manage-pass", "tf-manage-code"]); return; }
  try {
    const r = await api(TFM.mode === "disable" ? "/api/auth/2fa/disable" : "/api/auth/2fa/backup-codes", { method: "POST", body: JSON.stringify({ password, code }) });
    CURRENT_SESSION.staff = r.staff;
    usEl("tf-manage-modal").classList.add("hidden");
    usRenderMini2fa();
    if (TFM.mode === "codes") tfShowCodes(r.backupCodes);
    else { scRenderMy2fa(); api("/api/admin/security/overview").then((ov) => { SC.overview = ov; scRenderOverview(); }).catch(() => {}); }
  } catch (e) {
    showMsg(msg, e.code === "2fa_required" || (e.data && e.data.code === "2fa_required") ? t("tfRequiredNoOff") : e.message, false);
  }
}

// ---- required set-up gate (the platform requires 2-step login for this account) ----
function usOnTwoFaRequired() {
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff") return;
  CURRENT_SESSION.staff.mustSetup2fa = true;
  if (!TF.open) tfOpenSetup(true);
}
// Everyone with a staff account (gate staff, tournament managers...) can protect it with 2-step login from the gate screen;
// administrators who can open the Security centre find the same switch there.
function usRenderMini2fa() {
  const el = usEl("us-mini2fa");
  if (!el) return;
  const staff = CURRENT_SESSION && CURRENT_SESSION.type === "staff" ? CURRENT_SESSION.staff : null;
  const show = !!staff && !(staff.role === "admin" && staffCan("security"));
  el.classList.toggle("hidden", !show);
  if (!show) return;
  el.innerHTML = `<div class="us-head"><div><b>${usEsc(t("scMy2fa"))}</b> <span class="us-pill ${staff.twoFactorEnabled ? "st-active" : "st-disabled"}">${usEsc(t(staff.twoFactorEnabled ? "scOn" : "scOff"))}</span>
    <div class="hint-note">${usEsc(t("scMy2faHint"))}</div></div>
    <div class="us-row-actions">${staff.twoFactorEnabled
      ? `<button class="secondary small" type="button" data-mini="codes">${usEsc(t("scNewCodes"))}</button><button class="secondary small" type="button" data-mini="off">${usEsc(t("scDisable"))}</button>`
      : `<button class="primary small" type="button" data-mini="on">${usEsc(t("scEnable"))}</button>`}</div></div>`;
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mini]");
      if (!b) return;
      if (b.dataset.mini === "on") tfOpenSetup(false);
      else tfOpenManage(b.dataset.mini === "off" ? "disable" : "codes");
    });
  }
}
function usAfterSession() {
  usRenderMini2fa();
  const staff = CURRENT_SESSION && CURRENT_SESSION.type === "staff" ? CURRENT_SESSION.staff : null;
  if (staff && staff.mustSetup2fa) {
    if (!TF.open) tfOpenSetup(true);
  } else if (TF.open && TF.forced && !(usEl("tf-step-codes") && !usEl("tf-step-codes").classList.contains("hidden"))) {
    TF.forced = false;
    tfCloseSetup(true);
  }
}
