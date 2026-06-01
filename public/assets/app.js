/* =========================================================================
   Zac & Will's Lawyers — front-end logic.

   Everything that touches the Customer Gateway goes through gateway(), which
   POSTs { args, turnstileToken } to our own /api/<tool> proxy. The browser
   never knows the gateway URL, the gateway key, or the Turnstile secret.
   ========================================================================= */

/* ----------------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SERVICE_LABELS = {
  personal_injury: "Personal Injury",
  workers_compensation: "Workers' Compensation",
  medical_negligence: "Medical Negligence",
  motor_vehicle_accident: "Motor Vehicle Accident",
};

// Known service IDs for this tenant — used as a fallback if list_services
// is unreachable so the forms still work.
const FALLBACK_SERVICES = Object.keys(SERVICE_LABELS);

function labelFor(id) {
  if (SERVICE_LABELS[id]) return SERVICE_LABELS[id];
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
    label: s.name || s.title || s.label || labelFor(id),
    description: s.description || s.summary || s.blurb || "",
  };
}

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
    const list = raw.map(normalizeService).filter(Boolean);
    _servicesCache = list.length ? list : FALLBACK_SERVICES.map(normalizeService);
  } catch {
    _servicesCache = FALLBACK_SERVICES.map(normalizeService);
  }
  return _servicesCache;
}

function fillServiceSelect(sel, services, { placeholder = "Select a matter type…" } = {}) {
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
  const cfg = await CONFIG;
  await loadTurnstileScript();
  // window.turnstile can appear a tick after the script load event.
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
    theme: "light",
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

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function toISO(value, endOfDay = false) {
  // Accepts a yyyy-mm-dd (date input) or full datetime-local value.
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString();
  }
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

function todayInput() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function daysFromTodayInput(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------- reveal stagger */
function initReveal() {
  $$("[data-reveal]").forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i * 80, 600)}ms`;
  });
}

/* ============================== PAGE: SERVICES =========================== */
async function initServices() {
  const list = $("#svc-list");
  const sel = $("#elig-service");
  const services = await loadServices();

  if (list) {
    list.innerHTML = "";
    services.forEach((svc, i) => {
      const row = document.createElement("div");
      row.className = "svc-row";
      row.setAttribute("data-reveal", "");
      row.style.animationDelay = `${i * 70}ms`;
      row.innerHTML = `
        <span class="idx">${String(i + 1).padStart(2, "0")}</span>
        <div>
          <h3>${escapeHtml(svc.label)}</h3>
          <p>${escapeHtml(svc.description || defaultBlurb(svc.id))}</p>
        </div>
        <a class="btn btn--ghost" href="/book.html?service=${encodeURIComponent(
          svc.id
        )}">Book a consult <span class="arrow">→</span></a>`;
      list.appendChild(row);
    });
  }

  if (sel) fillServiceSelect(sel, services);

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
        incident_date: $("#elig-date").value || undefined,
        state: $("#elig-state").value || undefined,
        summary: $("#elig-summary").value || undefined,
      };
      const r = await gateway("check_eligibility", args, token);
      const kind = r.eligible ? "good" : "info";
      resultEl.className = `alert alert--${kind}`;
      resultEl.innerHTML = `
        <div>
          <strong>${
            r.eligible
              ? "This looks like something we can help with."
              : "We may not be the right fit — but let's check."
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
            <a class="btn btn--oxblood" href="/book.html?service=${encodeURIComponent(
              sel.value
            )}">Book a free consult <span class="arrow">→</span></a>
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

function defaultBlurb(id) {
  const map = {
    personal_injury:
      "Compensation for injuries caused by another party's negligence — public liability, slips and falls, and more.",
    workers_compensation:
      "Claims for injuries sustained at work, including disputed and rejected claims.",
    medical_negligence:
      "Action where substandard medical care has caused avoidable harm.",
    motor_vehicle_accident:
      "Claims arising from road accidents, whether driver, passenger, cyclist or pedestrian.",
  };
  return map[id] || "Speak with our team about your circumstances.";
}

/* =============================== PAGE: ENQUIRY ========================== */
async function initEnquiry() {
  const sel = $("#enq-service");
  fillServiceSelect(sel, await loadServices());
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
        `<div><strong>Thank you — your enquiry is with us.</strong>
         <p style="margin:.5rem 0 0">A member of our team will be in touch shortly.${
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
  fillServiceSelect(sel, services);
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
      showAlert(slotsAlert, "bad", "Please choose a matter type first.");
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
    // group by day
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

  // details + confirm
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
          <strong>${escapeHtml(
            r.confirmation || "Your consultation is booked."
          )}</strong>
          <p style="margin:.6rem 0 0">${escapeHtml(
            fmtDateTime(selectedStart)
          )}${r.status ? ` — ${escapeHtml(r.status)}` : ""}</p>
          ${
            r.booking_uid
              ? `<p style="margin:.4rem 0 0">Booking reference: <strong>${escapeHtml(
                  r.booking_uid
                )}</strong> — keep this to manage your appointment.</p>`
              : ""
          }
          ${
            r.meeting_url
              ? `<p style="margin:.6rem 0 0"><a class="btn btn--oxblood" href="${encodeURI(
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
      // Always show the same neutral message — never reveal if the booking exists.
      showAlert(
        alert1,
        "info",
        escapeHtml(
          r.message ||
            "If a matching booking exists, we've emailed a 6-digit code to confirm this change."
        )
      );
      // Advance to PIN step.
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
      // Wrong/expired PIN — let them retry; new token required each attempt.
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

  let info;
  try {
    info = await gateway("get_business_info", {});
  } catch {
    if (loading) loading.hidden = true;
    if (errorEl) errorEl.hidden = false;
    return;
  }
  if (loading) loading.hidden = true;
  if (!info || typeof info !== "object") {
    if (errorEl) errorEl.hidden = false;
    return;
  }
  if (content) content.hidden = false;

  // Intro / about
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

  // If every section came back empty, show the graceful fallback instead.
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
  // Known days first (in week order), then any unexpected extras.
  const keys = Object.keys(hours);
  const known = WEEK_ORDER.filter((d) => keys.some((k) => k.toLowerCase() === d));
  const extra = keys.filter((k) => !WEEK_ORDER.includes(k.toLowerCase()));
  const ordered = [...known, ...extra];
  if (!ordered.length) {
    if (wrap) wrap.hidden = true;
    return;
  }

  // Determine "today" in the firm's timezone for highlighting.
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
    const key =
      keys.find((k) => k.toLowerCase() === day.toLowerCase()) || day;
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
  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());
  const page = document.body.dataset.page;
  const init = {
    services: initServices,
    enquiry: initEnquiry,
    booking: initBooking,
    manage: initManage,
    contact: initContact,
  }[page];
  if (init) init().catch((e) => console.error("Init failed:", e));
});
