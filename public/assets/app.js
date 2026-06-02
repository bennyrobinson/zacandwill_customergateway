/* =========================================================================
   Consulting site — front-end logic.

   Everything that touches the Customer Gateway goes through gateway(), which
   POSTs { args, turnstileToken } to our own /api/<tool> proxy. The browser
   never knows the gateway URL, the gateway key, or the Turnstile secret.

   Business-specific content (name, tagline, about, services, hours, FAQs) is
   fetched live from the gateway so the site stays a single source of truth.
   The only thing the gateway doesn't provide is pricing — that lives in the
   editable /assets/plans.json.
   ========================================================================= */

/* ----------------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function labelFor(id) {
  return String(id || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeService(s) {
  if (s == null) return null;
  if (typeof s === "string") return { id: s, label: labelFor(s) };
  const id = s.id || s.slug || s.service || s.key || s.code || s.name;
  if (!id) return null;
  return {
    id,
    label: s.title || s.name || s.label || labelFor(id),
    description: s.description || s.summary || s.blurb || "",
    accepting: s.acceptingClients !== false,
  };
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* --------------------------------------------------------- gateway client */
async function gateway(tool, args = {}, turnstileToken) {
  let res;
  try {
    res = await fetch(`/api/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args, turnstileToken }),
    });
  } catch {
    throw new Error("Network error. Please check your connection and retry.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* leave data empty */
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.error) || "Something went wrong. Please try again."
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let _servicesCache = null;
async function loadServices() {
  if (_servicesCache) return _servicesCache;
  try {
    const data = await gateway("list_services", {});
    const raw = Array.isArray(data) ? data : data.services || [];
    _servicesCache = raw.map(normalizeService).filter(Boolean);
  } catch {
    _servicesCache = [];
  }
  return _servicesCache;
}

let _businessCache;
async function loadBusinessInfo() {
  if (_businessCache !== undefined) return _businessCache;
  try {
    _businessCache = await gateway("get_business_info", {});
  } catch {
    _businessCache = null;
  }
  return _businessCache;
}

let _plansCache;
async function loadPlans() {
  if (_plansCache !== undefined) return _plansCache;
  try {
    const r = await fetch("/assets/plans.json");
    _plansCache = await r.json();
  } catch {
    _plansCache = null;
  }
  return _plansCache;
}

function fillServiceSelect(sel, services, { placeholder = "Select a service…" } = {}) {
  if (!sel) return;
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  ph.disabled = true;
  ph.selected = true;
  sel.appendChild(ph);
  for (const svc of services) {
    const opt = document.createElement("option");
    opt.value = svc.id;
    opt.textContent = svc.label;
    sel.appendChild(opt);
  }
}

/* --------------------------------------------------------------- Turnstile */
const CONFIG = (async () => {
  try {
    const r = await fetch("/api/config");
    return await r.json();
  } catch {
    return { turnstileSiteKey: "1x00000000000000000000AA" };
  }
})();

let _tsScript;
function loadTurnstileScript() {
  if (_tsScript) return _tsScript;
  _tsScript = new Promise((resolve, reject) => {
    if (window.turnstile?.render) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load the security check."));
    document.head.appendChild(s);
  });
  return _tsScript;
}

async function mountTurnstile(container) {
  if (!container) return { getToken: () => null, reset: () => {} };
  const cfg = await CONFIG;
  await loadTurnstileScript();
  await new Promise((res) => {
    if (window.turnstile?.render) return res();
    const t = setInterval(() => {
      if (window.turnstile?.render) {
        clearInterval(t);
        res();
      }
    }, 30);
  });
  let token = null;
  const id = window.turnstile.render(container, {
    sitekey: cfg.turnstileSiteKey,
    theme: "auto",
    callback: (t) => {
      token = t;
    },
    "expired-callback": () => {
      token = null;
    },
    "error-callback": () => {
      token = null;
    },
  });
  return {
    getToken: () => {
      try {
        return window.turnstile.getResponse(id) || token;
      } catch {
        return token;
      }
    },
    reset: () => {
      token = null;
      try {
        window.turnstile.reset(id);
      } catch {
        /* ignore */
      }
    },
  };
}

/* ----------------------------------------------------------- UI utilities */
function showAlert(el, kind, html) {
  if (!el) return;
  el.className = `alert alert--${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}
function clearAlert(el) {
  if (el) el.hidden = true;
}
function setBusy(btn, busy, idleLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.idle = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${idleLabel || "Working…"}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.idle) btn.innerHTML = btn.dataset.idle;
  }
}

const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
};
const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

function toISO(value, endOfDay = false) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString();
  }
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}
function todayInput() {
  return new Date().toISOString().slice(0, 10);
}
function daysFromTodayInput(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function initReveal() {
  $$("[data-reveal]").forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i * 80, 600)}ms`;
  });
}

/* ============================ CHROME HYDRATION ========================== */
// Fill brand, title, footer and contact details from get_business_info on
// every page, so the whole site reflects the gateway tenant automatically.
async function hydrateChrome() {
  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  const info = await loadBusinessInfo();
  if (!info) return;

  if (info.name) {
    $$('[data-bi="name"]').forEach((el) => {
      el.textContent = info.name;
      el.removeAttribute("data-empty");
    });
    $$('[data-bi="mark"]').forEach((el) => (el.textContent = initials(info.name)));
    const base = document.body.dataset.title;
    document.title = base ? `${base} — ${info.name}` : info.name;
  }

  const tagline = info.tagline || "";
  $$('[data-bi="tagline"]').forEach((el) => {
    if (tagline) el.textContent = tagline;
  });
  $$('[data-bi="about-short"]').forEach((el) => {
    if (info.about) el.textContent = info.about;
  });

  // Footer contact links
  const phoneEl = $('[data-bi="phone"]');
  if (phoneEl && info.phone) {
    phoneEl.textContent = info.phone;
    phoneEl.href = `tel:${String(info.phone).replace(/[^\d+]/g, "")}`;
    phoneEl.hidden = false;
  }
  const emailEl = $('[data-bi="email"]');
  if (emailEl && info.contactEmail) {
    emailEl.textContent = info.contactEmail;
    emailEl.href = `mailto:${info.contactEmail}`;
    emailEl.hidden = false;
  }
  const locEl = $('[data-bi="location"]');
  if (locEl && (info.address || info.location)) {
    locEl.textContent = info.address || info.location;
    locEl.hidden = false;
  }
}

/* ================================ PAGE: HOME ============================ */
async function initHome() {
  const [info, services, plansData] = await Promise.all([
    loadBusinessInfo(),
    loadServices(),
    loadPlans(),
  ]);

  // Hero lede — prefer the business "about", fall back to tagline.
  if (info) {
    const lede = $("#home-lede");
    if (lede && (info.about || info.tagline)) {
      lede.textContent = info.about || info.tagline;
    }
  }

  // About + approach
  fillSection("#home-about-section", "#home-about", info && info.about);
  fillSection("#home-approach-section", "#home-approach", info && info.ourApproach);

  // How it works (array of steps)
  renderSteps(info && info.howItWorks);

  // Services preview (first few)
  renderServiceCards($("#home-services"), services.slice(0, 4));
  const svcSection = $("#home-services-section");
  if (svcSection) svcSection.hidden = services.length === 0;

  // Plans teaser (first three)
  renderPlanCards($("#home-plans"), plansData, { limit: 3, teaser: true });
  const planSection = $("#home-plans-section");
  if (planSection)
    planSection.hidden = !(plansData && Array.isArray(plansData.plans) && plansData.plans.length);

  // Team
  renderTeam(info && info.team);
}

function fillSection(sectionSel, targetSel, value) {
  const target = $(targetSel);
  const section = $(sectionSel);
  if (!target) return;
  if (!value) {
    if (section) section.hidden = true;
    return;
  }
  target.textContent = value;
  if (section) section.hidden = false;
}

function renderSteps(steps) {
  const wrap = $("#home-steps");
  const section = $("#home-steps-section");
  if (!wrap) return;
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  if (!list.length) {
    if (section) section.hidden = true;
    return;
  }
  wrap.innerHTML = "";
  list.forEach((text, i) => {
    const row = document.createElement("div");
    row.className = "step";
    row.innerHTML = `<span class="num">${String(i + 1).padStart(2, "0")}</span><p></p>`;
    row.querySelector("p").textContent = text;
    wrap.appendChild(row);
  });
  if (section) section.hidden = false;
}

function renderServiceCards(wrap, services) {
  if (!wrap) return;
  wrap.innerHTML = "";
  services.forEach((svc, i) => {
    const card = document.createElement("article");
    card.className = "card product";
    card.setAttribute("data-reveal", "");
    card.style.animationDelay = `${i * 70}ms`;
    card.innerHTML = `
      <div class="product-top">
        <span class="sec-num">${String(i + 1).padStart(2, "0")}</span>
        <span class="tag ${svc.accepting ? "tag--ok" : "tag--muted"}">${
      svc.accepting ? "Available" : "Waitlist"
    }</span>
      </div>
      <h3></h3>
      <p></p>
      <a class="card-link" href="/book.html?service=${encodeURIComponent(
        svc.id
      )}">Book a call <span class="arrow">→</span></a>`;
    card.querySelector("h3").textContent = svc.label;
    card.querySelector("p").textContent =
      svc.description || "Talk to us about how this can work for you.";
    wrap.appendChild(card);
  });
}

function renderTeam(team) {
  const wrap = $("#home-team");
  const section = $("#home-team-section");
  if (!wrap) return;
  const list = Array.isArray(team) ? team.filter((m) => m && m.name) : [];
  if (!list.length) {
    if (section) section.hidden = true;
    return;
  }
  wrap.innerHTML = "";
  list.forEach((m) => {
    const el = document.createElement("article");
    el.className = "member";
    el.innerHTML = `
      <div class="avatar"></div>
      <h3></h3>
      <p class="role"></p>
      <p class="bio"></p>`;
    el.querySelector(".avatar").textContent = initials(m.name);
    el.querySelector("h3").textContent = m.name;
    el.querySelector(".role").textContent = m.role || "";
    el.querySelector(".bio").textContent = m.bio || "";
    wrap.appendChild(el);
  });
  if (section) section.hidden = false;
}

/* ============================== PAGE: PRICING ========================== */
async function initPricing() {
  const data = await loadPlans();
  const wrap = $("#plans-list");
  const note = $("#plans-note");
  const errorEl = $("#plans-error");
  if (!data || !Array.isArray(data.plans) || !data.plans.length) {
    if (wrap) wrap.hidden = true;
    if (errorEl) errorEl.hidden = false;
    return;
  }
  if (note && data.note) {
    note.textContent = data.note;
    note.hidden = false;
  }
  renderPlanCards(wrap, data, {});
}

function renderPlanCards(wrap, data, { limit, teaser } = {}) {
  if (!wrap) return;
  let plans = data && Array.isArray(data.plans) ? data.plans : [];
  if (limit) plans = plans.slice(0, limit);
  if (!plans.length) return;
  wrap.classList.toggle("cols-3", plans.length % 3 === 0 || plans.length > 2);
  wrap.innerHTML = "";
  plans.forEach((p, i) => {
    const el = document.createElement("article");
    el.className = "plan" + (p.featured ? " plan--featured" : "");
    el.setAttribute("data-reveal", "");
    el.style.animationDelay = `${i * 70}ms`;

    const features =
      !teaser && Array.isArray(p.features) && p.features.length
        ? `<ul>${p.features
            .map((f) => `<li>${escapeHtml(f)}</li>`)
            .join("")}</ul>`
        : "";
    const price = p.price
      ? `<div class="price">${escapeHtml(p.price)}${
          p.per ? ` <span class="per">${escapeHtml(p.per)}</span>` : ""
        }</div>`
      : "";
    const ctaHref = p.ctaHref || "/book.html";
    const ctaLabel = p.cta || "Book a call";
    el.innerHTML = `
      <h3>${escapeHtml(p.name || "")}</h3>
      <p class="plan-desc">${escapeHtml(p.description || "")}</p>
      ${price}
      ${p.note ? `<p class="plan-note">${escapeHtml(p.note)}</p>` : ""}
      ${features}
      <a class="btn ${p.featured ? "btn--accent" : "btn--ghost"}" href="${escapeHtml(
      ctaHref
    )}">${escapeHtml(ctaLabel)} <span class="arrow">→</span></a>`;
    wrap.appendChild(el);
  });
}

/* ============================== PAGE: SERVICES ========================= */
async function initServices() {
  const list = $("#svc-list");
  const sel = $("#elig-service");
  const services = await loadServices();

  if (list) {
    if (!services.length) {
      list.innerHTML =
        '<div class="alert alert--info">Our services list is loading or temporarily unavailable. Please <a href="/enquiry.html">send an enquiry</a> and we\'ll help.</div>';
    } else {
      renderServiceCards(list, services);
    }
  }

  if (sel) fillServiceSelect(sel, services, { placeholder: "Which area can we help with?" });

  const form = $("#elig-form");
  if (!form) return;
  const ts = await mountTurnstile($("#elig-turnstile"));
  const alertEl = $("#elig-alert");
  const resultEl = $("#elig-result");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    resultEl.hidden = true;
    const token = ts.getToken();
    if (!token) {
      showAlert(alertEl, "bad", "Please complete the security check below.");
      return;
    }
    const btn = $("#elig-submit");
    setBusy(btn, true, "Checking…");
    try {
      const args = {
        service: sel.value,
        summary: $("#elig-summary").value || undefined,
      };
      const r = await gateway("check_eligibility", args, token);
      const kind = r.eligible ? "good" : "info";
      resultEl.className = `alert alert--${kind}`;
      resultEl.innerHTML = `
        <div>
          <strong>${
            r.eligible
              ? "Great — this looks like a strong fit."
              : "We might not be the right fit — let's talk it through."
          }</strong>
          ${r.reason ? `<p style="margin:.5rem 0 0">${escapeHtml(r.reason)}</p>` : ""}
          ${
            r.recommended_next_step
              ? `<p style="margin:.5rem 0 0"><em>Recommended next step:</em> ${escapeHtml(
                  r.recommended_next_step
                )}</p>`
              : ""
          }
          <p style="margin:.75rem 0 0">
            <a class="btn btn--accent" href="/book.html?service=${encodeURIComponent(
              sel.value
            )}">Book an intro call <span class="arrow">→</span></a>
          </p>
        </div>`;
      resultEl.hidden = false;
    } catch (err) {
      showAlert(alertEl, "bad", escapeHtml(err.message));
    } finally {
      ts.reset();
      setBusy(btn, false);
    }
  });
}

/* =============================== PAGE: ENQUIRY ========================== */
async function initEnquiry() {
  const sel = $("#enq-service");
  fillServiceSelect(sel, await loadServices(), { placeholder: "What's it about?" });
  preselectFromQuery(sel);

  const form = $("#enq-form");
  const ts = await mountTurnstile($("#enq-turnstile"));
  const alertEl = $("#enq-alert");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    if (!$("#enq-consent").checked) {
      showAlert(alertEl, "bad", "Please confirm consent before submitting.");
      return;
    }
    const token = ts.getToken();
    if (!token) {
      showAlert(alertEl, "bad", "Please complete the security check below.");
      return;
    }
    const btn = $("#enq-submit");
    setBusy(btn, true, "Sending…");
    try {
      const args = {
        service: sel.value,
        contact: {
          name: $("#enq-name").value.trim(),
          email: $("#enq-email").value.trim(),
          phoneNumber: $("#enq-phone").value.trim() || undefined,
        },
        message: $("#enq-message").value.trim() || undefined,
      };
      const r = await gateway("create_enquiry", args, token);
      form.hidden = true;
      showAlert(
        alertEl,
        "good",
        `<div><strong>Thanks — your message is with us.</strong>
         <p style="margin:.5rem 0 0">We'll be in touch shortly.${
           r.enquiry_id
             ? ` Your reference is <strong>${escapeHtml(r.enquiry_id)}</strong>.`
             : ""
         }</p></div>`
      );
    } catch (err) {
      showAlert(alertEl, "bad", escapeHtml(err.message));
      ts.reset();
    } finally {
      setBusy(btn, false);
    }
  });
}

/* =============================== PAGE: BOOKING ========================== */
async function initBooking() {
  const sel = $("#book-service");
  const services = await loadServices();
  fillServiceSelect(sel, services, { placeholder: "What would you like to discuss?" });
  preselectFromQuery(sel);

  const fromEl = $("#book-from");
  const toEl = $("#book-to");
  fromEl.value = todayInput();
  fromEl.min = todayInput();
  toEl.value = daysFromTodayInput(14);
  toEl.min = todayInput();

  const slotsWrap = $("#book-slots");
  const slotsAlert = $("#slots-alert");
  const detailSection = $("#book-detail");
  const findBtn = $("#book-find");
  let selectedStart = null;

  $("#book-find-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(slotsAlert);
    selectedStart = null;
    detailSection.hidden = true;
    if (!sel.value) {
      showAlert(slotsAlert, "bad", "Please choose a service first.");
      return;
    }
    setBusy(findBtn, true, "Searching…");
    slotsWrap.innerHTML = "";
    try {
      const r = await gateway("check_availability", {
        service: sel.value,
        from: toISO(fromEl.value),
        to: toISO(toEl.value, true),
      });
      const slots = (r.slots || []).filter(Boolean);
      if (!slots.length) {
        showAlert(
          slotsAlert,
          "info",
          "No times available in that window. Try a wider date range, or send an enquiry and we'll find a time."
        );
        return;
      }
      renderSlots(slots);
    } catch (err) {
      showAlert(slotsAlert, "bad", escapeHtml(err.message));
    } finally {
      setBusy(findBtn, false);
    }
  });

  function renderSlots(slots) {
    const byDay = new Map();
    for (const iso of slots.sort()) {
      const key = new Date(iso).toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(iso);
    }
    slotsWrap.innerHTML = "";
    for (const [, isos] of byDay) {
      const h = document.createElement("h3");
      h.style.cssText = "font-size:1.05rem;margin:1.5rem 0 .75rem";
      h.textContent = fmtDay(isos[0]);
      slotsWrap.appendChild(h);
      const grid = document.createElement("div");
      grid.className = "slot-grid";
      for (const iso of isos) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        b.setAttribute("aria-pressed", "false");
        b.innerHTML = `<small>${escapeHtml(
          new Date(iso).toLocaleDateString(undefined, { weekday: "short" })
        )}</small>${escapeHtml(fmtTime(iso))}`;
        b.addEventListener("click", () => {
          $$(".slot", slotsWrap).forEach((s) =>
            s.setAttribute("aria-pressed", "false")
          );
          b.setAttribute("aria-pressed", "true");
          selectedStart = iso;
          $("#book-chosen").textContent = fmtDateTime(iso);
          detailSection.hidden = false;
          detailSection.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        grid.appendChild(b);
      }
      slotsWrap.appendChild(grid);
    }
  }

  const ts = await mountTurnstile($("#book-turnstile"));
  const bookAlert = $("#book-alert");
  $("#book-detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(bookAlert);
    if (!selectedStart) {
      showAlert(bookAlert, "bad", "Please pick a time slot above.");
      return;
    }
    if (!$("#book-consent").checked) {
      showAlert(bookAlert, "bad", "Please confirm consent before booking.");
      return;
    }
    const token = ts.getToken();
    if (!token) {
      showAlert(bookAlert, "bad", "Please complete the security check below.");
      return;
    }
    const btn = $("#book-submit");
    setBusy(btn, true, "Booking…");
    try {
      const args = {
        service: sel.value,
        start: selectedStart,
        attendee: {
          name: $("#book-name").value.trim(),
          email: $("#book-email").value.trim(),
          phoneNumber: $("#book-phone").value.trim() || undefined,
        },
        notes: $("#book-notes").value.trim() || undefined,
      };
      const r = await gateway("book_consultation", args, token);
      $("#book-find-section").hidden = true;
      detailSection.hidden = true;
      showAlert(
        bookAlert,
        "good",
        `<div>
          <strong>${escapeHtml(r.confirmation || "Your call is booked.")}</strong>
          <p style="margin:.6rem 0 0">${escapeHtml(fmtDateTime(selectedStart))}${
          r.status ? ` — ${escapeHtml(r.status)}` : ""
        }</p>
          ${
            r.booking_uid
              ? `<p style="margin:.4rem 0 0">Booking reference: <strong>${escapeHtml(
                  r.booking_uid
                )}</strong> — keep this to manage your call.</p>`
              : ""
          }
          ${
            r.meeting_url
              ? `<p style="margin:.6rem 0 0"><a class="btn btn--accent" href="${encodeURI(
                  r.meeting_url
                )}" target="_blank" rel="noopener">Join meeting link <span class="arrow">→</span></a></p>`
              : ""
          }
        </div>`
      );
      bookAlert.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      showAlert(bookAlert, "bad", escapeHtml(err.message));
      ts.reset();
    } finally {
      setBusy(btn, false);
    }
  });
}

/* =========================== PAGE: MANAGE BOOKING ======================= */
async function initManage() {
  const step1 = $("#manage-step1");
  const step2 = $("#manage-step2");
  const stepsNav = $("#manage-steps");
  const actionSel = $("#manage-action");
  const newStartField = $("#manage-newstart-field");
  let challengeId = null;

  actionSel.addEventListener("change", () => {
    newStartField.hidden = actionSel.value !== "reschedule";
    $("#manage-newstart").required = actionSel.value === "reschedule";
  });

  const ts1 = await mountTurnstile($("#manage-turnstile1"));
  const alert1 = $("#manage-alert1");

  $("#manage-request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alert1);
    const token = ts1.getToken();
    if (!token) {
      showAlert(alert1, "bad", "Please complete the security check below.");
      return;
    }
    const btn = $("#manage-request-submit");
    setBusy(btn, true, "Sending code…");
    try {
      const action = actionSel.value;
      const args = {
        booking_ref: $("#manage-ref").value.trim(),
        email: $("#manage-email").value.trim(),
        action,
      };
      if (action === "reschedule") {
        const ns = toISO($("#manage-newstart").value);
        if (!ns) {
          showAlert(alert1, "bad", "Please choose a new date and time.");
          setBusy(btn, false);
          return;
        }
        args.new_start = ns;
      }
      const r = await gateway("request_booking_change", args, token);
      challengeId = r.challenge_id || null;
      showAlert(
        alert1,
        "info",
        escapeHtml(
          r.message ||
            "If a matching booking exists, we've emailed a 6-digit code to confirm this change."
        )
      );
      step1.hidden = true;
      step2.hidden = false;
      $$("#manage-steps li").forEach((li, i) =>
        li.classList.toggle("active", i === 1)
      );
      $("#manage-pin").focus?.();
    } catch (err) {
      showAlert(alert1, "bad", escapeHtml(err.message));
      ts1.reset();
    } finally {
      setBusy(btn, false);
    }
  });

  const ts2 = await mountTurnstile($("#manage-turnstile2"));
  const alert2 = $("#manage-alert2");

  $("#manage-confirm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alert2);
    const pin = $("#manage-pin").value.trim();
    if (!/^\d{6}$/.test(pin)) {
      showAlert(alert2, "bad", "Enter the 6-digit code from your email.");
      return;
    }
    if (!challengeId) {
      showAlert(
        alert2,
        "bad",
        "This session expired. Please start again from step one."
      );
      return;
    }
    const token = ts2.getToken();
    if (!token) {
      showAlert(alert2, "bad", "Please complete the security check below.");
      return;
    }
    const btn = $("#manage-confirm-submit");
    setBusy(btn, true, "Confirming…");
    try {
      const r = await gateway(
        "confirm_booking_change",
        { challenge_id: challengeId, pin },
        token
      );
      step2.hidden = true;
      stepsNav.hidden = true;
      showAlert(
        alert2,
        "good",
        `<div><strong>${escapeHtml(
          r.confirmation || "Your booking has been updated."
        )}</strong>
        ${r.status ? `<p style="margin:.5rem 0 0">Status: ${escapeHtml(r.status)}</p>` : ""}
        ${
          r.booking_uid
            ? `<p style="margin:.3rem 0 0">Reference: <strong>${escapeHtml(
                r.booking_uid
              )}</strong></p>`
            : ""
        }</div>`
      );
    } catch (err) {
      showAlert(alert2, "bad", escapeHtml(err.message));
      ts2.reset();
    } finally {
      setBusy(btn, false);
    }
  });

  $("#manage-restart")?.addEventListener("click", (e) => {
    e.preventDefault();
    location.reload();
  });
}

/* ============================== PAGE: CONTACT =========================== */
const WEEK_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

async function initContact() {
  const loading = $("#contact-loading");
  const content = $("#contact-content");
  const errorEl = $("#contact-error");

  const info = await loadBusinessInfo();
  if (loading) loading.hidden = true;
  if (!info || typeof info !== "object") {
    if (errorEl) errorEl.hidden = false;
    return;
  }
  if (content) content.hidden = false;

  if (info.about) {
    const about = $("#contact-about");
    if (about) {
      about.textContent = info.about;
      about.hidden = false;
    }
  }

  renderContactDetails(info);
  renderHours(info);
  renderFees(info);
  renderFaqs(info);

  const anyShown = [
    "#contact-section",
    "#hours-section",
    "#fees-section",
    "#faq-section",
  ].some((sel) => {
    const e = $(sel);
    return e && !e.hidden;
  });
  if (!anyShown && errorEl) errorEl.hidden = false;
}

function renderContactDetails(info) {
  const dl = $("#contact-info");
  const section = $("#contact-section");
  if (!dl) return;
  const rows = [];
  const addr = info.address || info.location;
  if (addr) rows.push(["Address", document.createTextNode(addr)]);
  if (info.phone) {
    const a = document.createElement("a");
    a.href = `tel:${String(info.phone).replace(/[^\d+]/g, "")}`;
    a.textContent = info.phone;
    rows.push(["Phone", a]);
  }
  if (info.contactEmail) {
    const a = document.createElement("a");
    a.href = `mailto:${info.contactEmail}`;
    a.textContent = info.contactEmail;
    rows.push(["Email", a]);
  }
  if (info.serviceArea)
    rows.push(["Service area", document.createTextNode(info.serviceArea)]);

  if (!rows.length) {
    if (section) section.hidden = true;
    return;
  }
  dl.innerHTML = "";
  for (const [label, node] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.appendChild(node);
    dl.append(dt, dd);
  }
}

function renderHours(info) {
  const wrap = $("#hours-section");
  const body = $("#hours-body");
  const hours = info && info.hours;
  if (!body || !hours || typeof hours !== "object") {
    if (wrap) wrap.hidden = true;
    return;
  }
  const keys = Object.keys(hours);
  const known = WEEK_ORDER.filter((d) => keys.some((k) => k.toLowerCase() === d));
  const extra = keys.filter((k) => !WEEK_ORDER.includes(k.toLowerCase()));
  const ordered = [...known, ...extra];
  if (!ordered.length) {
    if (wrap) wrap.hidden = true;
    return;
  }

  let today = "";
  try {
    today = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: info.timezone || undefined,
    })
      .format(new Date())
      .toLowerCase();
  } catch {
    /* invalid timezone — skip highlight */
  }

  body.innerHTML = "";
  for (const day of ordered) {
    const key = keys.find((k) => k.toLowerCase() === day.toLowerCase()) || day;
    const tr = document.createElement("tr");
    if (key.toLowerCase() === today) tr.className = "is-today";
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = key;
    const td = document.createElement("td");
    td.textContent = hours[key];
    tr.append(th, td);
    body.appendChild(tr);
  }
  if (wrap) wrap.hidden = false;
}

function renderFees(info) {
  const wrap = $("#fees-section");
  const target = $("#fees-text");
  if (!target || !info.fees) {
    if (wrap) wrap.hidden = true;
    return;
  }
  target.innerHTML = "";
  for (const para of String(info.fees).split(/\n{2,}/)) {
    const p = document.createElement("p");
    p.textContent = para.trim();
    if (p.textContent) target.appendChild(p);
  }
  if (wrap) wrap.hidden = false;
}

function renderFaqs(info) {
  const wrap = $("#faq-section");
  const list = $("#faq-list");
  const faqs = Array.isArray(info.faqs) ? info.faqs.filter((f) => f && f.q) : [];
  if (!list || !faqs.length) {
    if (wrap) wrap.hidden = true;
    return;
  }
  list.innerHTML = "";
  faqs.forEach((f) => {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    s.textContent = f.q;
    const a = document.createElement("p");
    a.className = "faq-a";
    a.textContent = f.a || "";
    d.append(s, a);
    list.appendChild(d);
  });
  if (wrap) wrap.hidden = false;
}

/* ---------------------------------------------------- shared bits per page */
function preselectFromQuery(sel) {
  if (!sel) return;
  const want = new URLSearchParams(location.search).get("service");
  if (want && [...sel.options].some((o) => o.value === want)) {
    sel.value = want;
  }
}

/* ------------------------------------------------------------- bootstrapping */
document.addEventListener("DOMContentLoaded", () => {
  initReveal();
  hydrateChrome().catch((e) => console.error("Chrome hydration failed:", e));
  const page = document.body.dataset.page;
  const init = {
    home: initHome,
    services: initServices,
    pricing: initPricing,
    enquiry: initEnquiry,
    booking: initBooking,
    manage: initManage,
    contact: initContact,
  }[page];
  if (init) init().catch((e) => console.error("Init failed:", e));
});
