// Aura Admin Console Frontend — Product Analytics, SRE Golden Signals, Trace Explorer, Feedback Inbox & Improvement Flywheel.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  const fmtNum = (n) => Number(n || 0).toLocaleString('de-DE');
  const fmtTime = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return String(iso);
    }
  };

  const VIEW_META = {
    analytics: ['Product Analytics', 'Nutzung, Onboarding-Funnel, Hardware/VRAM & Modellverteilung'],
    performance: ['SRE & Performance', 'Google Golden Signals: Latenzen (p50/p95/p99), Tool-Matrix & Stabilität'],
    sessions: ['Chat & Trace Explorer', 'DSGVO-geschwärzte Chat-History-Protokolle, Agent-Spans & Eval-Export'],
    feedback: ['Feedback-Inbox', 'Direkte Nutzer-Rückmeldungen aus Aura inkl. automatischem Jira-Export'],
    improvements: ['Improvement Flywheel', 'Top Pain Points, Golden Evals für agent/evals/ & Canary-Rollouts'],
    fleet: ['Installationen & Hardware', 'Anonyme Client-Flotte, Aura-Versionen, RAM/VRAM & Consent-Stufen']
  };

  const state = {
    view: 'analytics',
    days: 30,
    feedbackFilter: 'new',
    selectedSessionId: null,
    lastEvalArtifact: null
  };

  // ---------- API Helper ----------

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {})
      },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 404) {
      if (path.startsWith('/api/admin/')) {
        showLogin();
        throw new Error('Admin-Sitzung erforderlich.');
      }
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- Dark Mode Toggle (Modern Web Guidance: color-scheme meta sync) ----------

  function initThemeToggle() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const btn = $('themeToggleBtn');
    const getSystem = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

    const applyFromStorage = () => {
      let stored = null;
      try {
        stored = localStorage.getItem('color-scheme');
      } catch {}
      if (meta) meta.content = stored === 'light' || stored === 'dark' ? stored : 'light dark';
    };

    window.addEventListener('storage', (e) => {
      if (e.key === 'color-scheme') applyFromStorage();
    });

    if (btn) {
      btn.onclick = () => {
        let stored = null;
        try {
          stored = localStorage.getItem('color-scheme');
        } catch {}
        const rendered = stored === 'light' || stored === 'dark' ? stored : getSystem();
        const target = rendered === 'dark' ? 'light' : 'dark';
        const sys = getSystem();
        try {
          if (target === sys) localStorage.removeItem('color-scheme');
          else localStorage.setItem('color-scheme', target);
        } catch {}
        if (meta) meta.content = target === sys ? 'light dark' : target;
      };
    }
  }

  // ---------- Native Dialog Lifecycle (closedby="any" + pointer fallback + returnValue reset) ----------

  function initDialogs() {
    const dialogs = [...document.querySelectorAll('dialog.native-dlg')];
    const needsFallback = !('closedBy' in HTMLDialogElement.prototype);
    for (const dlg of dialogs) {
      dlg.addEventListener('close', () => {
        dlg.returnValue = '';
      });
      if (needsFallback) {
        const outside = (e) => {
          const r = dlg.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        let pressedOutside = false;
        dlg.addEventListener('pointerdown', (e) => {
          pressedOutside = outside(e);
        });
        dlg.addEventListener('pointerup', (e) => {
          if (pressedOutside && outside(e)) dlg.close();
        });
      }
    }
    document.querySelectorAll('[data-close-dlg]').forEach((b) => {
      b.onclick = () => {
        const d = $(b.dataset.closeDlg);
        if (d && d.open) d.close();
      };
    });
  }

  // ---------- SVG Chart & Bar Helpers ----------

  function renderBars(el, rows, { max, color = 'var(--accent)', formatVal } = {}) {
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="muted small">Noch keine Daten im gewählten Zeitraum.</div>';
      return;
    }
    const peak = max || Math.max(1, ...rows.map((r) => Number(r.count || r.value || 0)));
    el.innerHTML = rows
      .map((r) => {
        const val = Number(r.count ?? r.value ?? 0);
        const pct = Math.min(100, Math.round((val / peak) * 100));
        const label = r.label || r.name || '—';
        const valTxt = formatVal ? formatVal(r) : fmtNum(val);
        return `<div class="bar-row">
          <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="bar-val">${esc(valTxt)}</span>
        </div>`;
      })
      .join('');
  }

  function renderLineChart(el, points, series) {
    if (!el) return;
    if (!points || !points.length) {
      el.innerHTML = '<div class="empty-state small">Noch keine Zeitreihendaten vorhanden.</div>';
      return;
    }
    const W = 560;
    const H = 180;
    const padL = 36;
    const padR = 12;
    const padT = 16;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(
      1,
      ...series.flatMap((s) => points.map((p) => Number(p[s.key] || 0)))
    );

    const xOf = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const yOf = (v) => padT + plotH - (Number(v || 0) / maxVal) * plotH;

    const gridLines = [0, 0.5, 1]
      .map((frac) => {
        const y = padT + plotH * (1 - frac);
        const lbl = Math.round(maxVal * frac);
        return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-dasharray="3 3"/>
                <text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="10">${lbl}</text>`;
      })
      .join('');

    const paths = series
      .map((s) => {
        const d = points
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(1)} ${yOf(p[s.key]).toFixed(1)}`)
          .join(' ');
        return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
      })
      .join('');

    const firstDay = points[0].day || '';
    const lastDay = points[points.length - 1].day || '';
    const legend = series
      .map(
        (s) =>
          `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)"><i style="width:10px;height:3px;background:${s.color};display:inline-block;border-radius:2px"></i>${esc(s.label)}</span>`
      )
      .join(' ');

    el.innerHTML = `
      <div style="display:flex;gap:14px;margin-bottom:6px;flex-wrap:wrap">${legend}</div>
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Zeitreihen-Diagramm">
        ${gridLines}
        ${paths}
        <text x="${padL}" y="${H - 6}" fill="var(--muted)" font-size="10">${esc(firstDay)}</text>
        <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="var(--muted)" font-size="10">${esc(lastDay)}</text>
      </svg>`;
  }

  // ---------- View 1: Product Analytics ----------

  async function loadAnalytics() {
    const d = await api(`/api/admin/overview?days=${state.days}`);
    const k = d.kpis || {};
    const fb = d.feedbackCounts || {};
    const totalRatings = Number(k.ratings_up || 0) + Number(k.ratings_down || 0);
    const csat = totalRatings ? `${Math.round((Number(k.ratings_up || 0) / totalRatings) * 100)} %` : '—';

    updateUnreadBadge(fb.open_feedback || 0);

    $('analyticsKpis').innerHTML = [
      ['DAU / WAU / MAU', `${fmtNum(k.dau)} / ${fmtNum(k.wau)} / ${fmtNum(k.mau)}`, `${fmtNum(k.total_installs)} Installationen gesamt`],
      ['Abgelegte Sessions', fmtNum(k.sessions_period), `Ø Judge-Score: ${k.avg_judge_score || '—'} / 5`],
      ['Zufriedenheit (👍)', csat, `${fmtNum(k.ratings_up)} 👍 · ${fmtNum(k.ratings_down)} 👎`],
      ['Geschätzte Kosten', `${Number(k.est_cost_usd || 0).toFixed(2)} $`, `Letzte ${d.days} Tage (Client-Schätzung)`],
      ['Offenes Feedback', fmtNum(fb.open_feedback), `${fmtNum(fb.in_jira)} in Jira · ${fmtNum(fb.pending_jira)} wartend`]
    ]
      .map(
        ([label, val, sub]) =>
          `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(val)}</div><div class="kpi-sub">${esc(sub)}</div></div>`
      )
      .join('');

    renderLineChart($('activityChart'), d.dailyActivity || [], [
      { key: 'events', label: 'Events', color: 'var(--accent)' },
      { key: 'active_users', label: 'Aktive Clients', color: 'var(--ok)' },
      { key: 'errors', label: 'Fehler', color: 'var(--bad)' }
    ]);

    const f = d.funnel || {};
    const funnelRows = [
      { label: '1. Installiert', count: f.installed || 0 },
      { label: '2. Telemetrie Opt-In', count: f.opted_in || 0 },
      { label: '3. Erster Chat', count: f.first_chat || 0 },
      { label: '4. Erster Agent-v2-Auftrag', count: f.first_agent_task || 0 },
      { label: '5. Trace / Protokoll geteilt', count: f.shared_trace || 0 }
    ];
    renderBars($('funnelChart'), funnelRows, {
      max: Math.max(1, f.installed || 1),
      color: 'var(--ok)',
      formatVal: (r) =>
        `${fmtNum(r.count)} (${Math.round((Number(r.count || 0) / Math.max(1, f.installed || 1)) * 100)} %)`
    });

    renderBars($('osBars'), d.osSplit || [], { color: 'var(--accent)' });
    renderBars($('versionBars'), d.versionSplit || [], { color: 'var(--purple)' });
    renderBars($('hwBars'), d.hardwareSplit || [], {
      color: 'var(--cyan)',
      formatVal: (r) => `${fmtNum(r.count)} (Ø ${r.avg_ram_gb || 0}G RAM / ${r.avg_vram_gb || 0}G VRAM)`
    });
    renderBars($('modelBars'), d.modelSplit || [], { color: 'var(--accent)' });
    renderBars($('featureBars'), d.featureSplit || [], {
      color: 'var(--ok)',
      formatVal: (r) => `${fmtNum(r.count)}${r.errors ? ` (${r.errors} err)` : ''}`
    });
  }

  // ---------- View 2: SRE Performance & Golden Signals ----------

  async function loadPerformance() {
    const d = await api(`/api/admin/performance?days=${state.days}`);
    const ss = d.sessionStats || {};
    const totalSess = Number(ss.total_sessions || 0);
    const errFreePct = totalSess ? `${((Number(ss.error_free_sessions || 0) / totalSess) * 100).toFixed(1)} %` : '100 %';
    const allReqs = (d.latencyByFeature || []).reduce((a, r) => a + Number(r.requests || 0), 0);
    const allErrs = (d.latencyByFeature || []).reduce((a, r) => a + Number(r.errors || 0), 0);
    const errRate = allReqs ? `${((allErrs / allReqs) * 100).toFixed(2)} %` : '0.00 %';

    $('perfKpis').innerHTML = [
      ['Error-Free Sessions', errFreePct, `${fmtNum(ss.error_free_sessions)} / ${fmtNum(totalSess)} fehlerfrei`],
      ['Client-Fehlerrate', errRate, `${fmtNum(allErrs)} Fehler bei ${fmtNum(allReqs)} Events`],
      ['Ø Agent-Schritte', `${ss.avg_turns || 0}`, `Ø ${fmtNum(ss.avg_tokens)} Tokens / Session`],
      ['Gesamtkosten (Traces)', `${Number(ss.total_cost_usd || 0).toFixed(2)} $`, `Zeitraum: ${d.days} Tage`]
    ]
      .map(
        ([l, v, s]) =>
          `<div class="kpi-card"><div class="kpi-label">${esc(l)}</div><div class="kpi-value">${esc(v)}</div><div class="kpi-sub">${esc(s)}</div></div>`
      )
      .join('');

    renderLineChart($('perfTrendChart'), d.latencyTrend || [], [
      { key: 'p50_ms', label: 'p50 (ms)', color: 'var(--ok)' },
      { key: 'p95_ms', label: 'p95 (ms)', color: 'var(--warn)' }
    ]);

    renderBars(
      $('errorCodesList'),
      (d.errorCodes || []).map((e) => ({ label: `${e.error_code} (${e.feature})`, count: e.count })),
      { color: 'var(--bad)' }
    );

    $('latencyTableBody').innerHTML =
      (d.latencyByFeature || [])
        .map(
          (r) => `<tr>
            <th>${esc(r.feature)}</th>
            <td>${fmtNum(r.requests)}</td>
            <td>${r.errors ? `<span class="badge bad">${fmtNum(r.errors)}</span>` : '0'}</td>
            <td><code>${fmtNum(r.p50_ms)}</code></td>
            <td><code>${fmtNum(r.p95_ms)}</code></td>
            <td><code>${fmtNum(r.p99_ms)}</code></td>
          </tr>`
        )
        .join('') || '<tr><td colspan="6" class="muted">Noch keine Latenzdaten vorhanden.</td></tr>';

    $('toolMatrixBody').innerHTML =
      (d.toolMatrix || [])
        .map((r) => {
          const pct = r.total ? Math.round((r.ok_count / r.total) * 100) : 100;
          const cls = pct >= 95 ? 'ok' : pct >= 80 ? 'warn' : 'bad';
          return `<tr>
            <th>${esc(r.tool_name)}</th>
            <td>${esc(r.os_platform)}</td>
            <td>${fmtNum(r.total)}</td>
            <td><span class="badge ${cls}">${pct} %</span></td>
            <td>${fmtNum(r.err_count)}</td>
            <td><code>${fmtNum(r.avg_ms)} ms</code></td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="6" class="muted">Noch keine Tool-Aufrufe protokolliert.</td></tr>';
  }

  // ---------- View 3: Chat-History & Agent Trace Explorer ----------

  async function loadSessions(extraParams = {}) {
    const qs = new URLSearchParams();
    const q = ($('sessionSearch') && $('sessionSearch').value.trim()) || '';
    const rating = ($('sessionRatingFilter') && $('sessionRatingFilter').value) || '';
    const errOnly = Boolean($('sessionErrOnly') && $('sessionErrOnly').checked);
    if (q) qs.set('q', q);
    if (rating) qs.set('rating', rating);
    if (errOnly) qs.set('onlyErrors', 'true');
    if (extraParams.cluster) qs.set('cluster', extraParams.cluster);

    const d = await api(`/api/admin/sessions?${qs.toString()}`);
    const list = d.sessions || [];
    $('sessionCount').textContent = `${list.length} Protokolle`;

    if (!list.length) {
      $('sessionList').innerHTML = '<div class="empty-state small">Keine passenden Protokolle gefunden.</div>';
      return;
    }

    $('sessionList').innerHTML = list
      .map((s) => {
        const active = s.session_id === state.selectedSessionId ? ' active' : '';
        const scoreCls = Number(s.judge_score || 0) >= 4 ? 'ok' : Number(s.judge_score || 0) >= 2.8 ? 'warn' : 'bad';
        return `<button type="button" class="session-row${active}" data-sid="${esc(s.session_id)}">
          <div class="session-tags">
            <span class="badge ${scoreCls}">★ ${s.judge_score ?? '—'}</span>
            ${s.user_rating === 'down' ? '<span class="badge bad">👎</span>' : s.user_rating === 'up' ? '<span class="badge ok">👍</span>' : ''}
            ${s.has_error ? '<span class="badge bad">Fehler</span>' : ''}
            <span class="muted small" style="margin-left:auto">${esc(fmtTime(s.created_at))}</span>
          </div>
          <div class="session-prompt">${esc(s.first_prompt || s.session_id)}</div>
          <div class="muted small">${esc(s.model || s.provider)} · ${esc(s.os_platform)} · ${s.span_count || 0} Spans · ${fmtNum(s.total_latency_ms)} ms</div>
        </button>`;
      })
      .join('');

    $('sessionList')
      .querySelectorAll('[data-sid]')
      .forEach((btn) => {
        btn.onclick = () => openSessionDetail(btn.dataset.sid);
      });
  }

  async function openSessionDetail(sessionId) {
    state.selectedSessionId = sessionId;
    $('sessionList')
      .querySelectorAll('[data-sid]')
      .forEach((b) => b.classList.toggle('active', b.dataset.sid === sessionId));

    const d = await api(`/api/admin/sessions/${encodeURIComponent(sessionId)}`);
    const s = d.session;
    const spans = d.spans || [];
    $('sessionDetailEmpty').classList.add('hidden');
    $('sessionDetail').classList.remove('hidden');

    $('detTitle').textContent = `Session ${s.session_id}`;
    $('detMeta').textContent = `${s.mode} · ${s.provider}/${s.model || '—'} · ${s.os_platform} · Aura v${s.app_version} · ${fmtNum(s.total_latency_ms)} ms · ${fmtNum(s.total_tokens)} Tokens`;

    const dims = s.judge_dimensions || {};
    $('detJudgeBox').innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <strong>Qualitäts-Score: ${s.judge_score ?? '—'} / 5</strong>
        ${s.cluster_tag ? `<span class="badge accent">${esc(s.cluster_tag)}</span>` : ''}
        ${dims.mode ? `<span class="badge">${esc(dims.mode)}</span>` : ''}
      </div>
      <div class="muted small">${esc(s.judge_summary || 'Noch keine Bewertung.')}</div>`;

    const msgs = Array.isArray(s.messages) ? s.messages : [];
    $('detMessages').innerHTML =
      msgs
        .map(
          (m) => `<div class="msg-bubble ${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="msg-role">${esc(m.role)}</div>
            <div>${esc(m.text)}</div>
          </div>`
        )
        .join('') || '<div class="muted small">Keine Chat-Nachrichten in diesem Trace.</div>';

    const maxDur = Math.max(1, ...spans.map((sp) => Number(sp.duration_ms || 0)));
    $('detSpans').innerHTML =
      spans
        .map((sp) => {
          const pct = Math.max(4, Math.min(100, Math.round((Number(sp.duration_ms || 0) / maxDur) * 100)));
          const isErr = sp.status && sp.status !== 'ok';
          return `<div class="span-item">
            <div class="span-top">
              <strong><code>${esc(sp.tool_name || sp.span_type)}</code></strong>
              <span class="badge ${isErr ? 'bad' : 'ok'}">${esc(sp.status)} · ${fmtNum(sp.duration_ms)} ms</span>
            </div>
            <div class="span-bar-wrap"><div class="span-bar${isErr ? ' err' : ''}" style="width:${pct}%"></div></div>
            ${sp.error_type ? `<div class="small" style="color:var(--bad)">${esc(sp.error_type)}</div>` : ''}
            ${
              sp.redacted_io
                ? `<details><summary>Redigierte Ein-/Ausgabe anzeigen</summary><pre>${esc(JSON.stringify(sp.redacted_io, null, 2))}</pre></details>`
                : ''
            }
          </div>`;
        })
        .join('') || '<div class="muted small">Keine einzelnen Werkzeug-Spans vorhanden.</div>';
  }

  // ---------- View 4: Feedback Inbox (Headhunter-Stil + Jira) ----------

  function updateUnreadBadge(n) {
    const b = $('navUnreadBadge');
    if (!b) return;
    b.textContent = String(n);
    b.classList.toggle('hidden', !n);
  }

  function jiraBadge(item, jiraConfigured) {
    if (!jiraConfigured && item.jira_status === 'pending') {
      return '<span class="badge">Jira nicht eingerichtet</span>';
    }
    if (item.status === 'done' && !item.jira_issue_key && item.jira_status === 'pending') {
      return '<span class="badge">Erledigt ohne Jira</span>';
    }
    if (item.jira_status === 'created' && item.jira_issue_key) {
      return `<a class="badge ok" href="${esc(item.jira_issue_url || '#')}" target="_blank" rel="noopener noreferrer">Ticket ${esc(item.jira_issue_key)} ↗</a>`;
    }
    if (item.jira_status === 'commented' && item.jira_issue_key) {
      return `<a class="badge accent" href="${esc(item.jira_issue_url || '#')}" target="_blank" rel="noopener noreferrer">An ${esc(item.jira_issue_key)} gehängt ↗</a>`;
    }
    if (item.jira_status === 'rejected') return '<span class="badge warn">Aussortiert (Vorprüfung)</span>';
    if (item.jira_status === 'failed') return '<span class="badge bad">Jira-Export fehlgeschlagen</span>';
    if (item.jira_status === 'exporting') return '<span class="badge accent">Wird übertragen …</span>';
    return '<span class="badge">Wartet auf Jira</span>';
  }

  async function loadFeedback() {
    const d = await api(`/api/admin/feedback?status=${encodeURIComponent(state.feedbackFilter)}`);
    const c = d.counts || {};
    const jiraCfg = Boolean(d.jira && d.jira.configured);
    updateUnreadBadge(c.unread || 0);

    const banner = $('jiraConfigBanner');
    if (!jiraCfg) {
      banner.classList.remove('hidden');
      banner.innerHTML =
        '<strong>Jira ist in dieser Umgebung noch nicht eingerichtet</strong> (das ist kein Fehler) – alle Rückmeldungen landen zuverlässig hier in der Inbox und werden automatisch nachgeholt, sobald <code>JIRA_EMAIL</code> &amp; <code>JIRA_API_TOKEN</code> im Cluster-Secret hinterlegt sind.';
    } else {
      banner.classList.remove('hidden');
      banner.innerHTML = `<strong>Jira-Anbindung aktiv:</strong> Projekt <code>${esc(d.jira.projectKey)}</code> (${esc(d.jira.baseUrl)}) – Vorprüfung + Duplikatprüfung aktiv, bereit für spätere OpenClaw-Abarbeitung.`;
    }

    $('feedbackSummaryBar').innerHTML = [
      ['Ungelesen', fmtNum(c.unread), 'Warten auf Prüfung'],
      ['In Arbeit', fmtNum(c.in_progress), 'Aktiv triagiert'],
      ['Erledigt', fmtNum(c.done), `Gesamt: ${fmtNum(c.total)}`],
      ['In Jira synchronisiert', fmtNum(c.jira_synced), `${fmtNum(c.jira_pending)} wartend · ${fmtNum(c.jira_rejected)} aussortiert`]
    ]
      .map(
        ([l, v, s]) =>
          `<div class="kpi-card"><div class="kpi-label">${esc(l)}</div><div class="kpi-value">${esc(v)}</div><div class="kpi-sub">${esc(s)}</div></div>`
      )
      .join('');

    const items = d.items || [];
    if (!items.length) {
      $('feedbackList').innerHTML = '<div class="card empty-state">Keine Rückmeldungen in diesem Filter.</div>';
      return;
    }

    $('feedbackList').innerHTML = items
      .map((item) => {
        const kindLabel = item.kind === 'bug' ? 'Fehler' : item.kind === 'idea' ? 'Idee' : 'Rückmeldung';
        const kindCls = item.kind === 'bug' ? 'bad' : item.kind === 'idea' ? 'accent' : '';
        const canRetry = jiraCfg && (item.jira_status === 'failed' || item.jira_status === 'pending') && item.status !== 'done';
        const canForce = jiraCfg && item.jira_status === 'rejected' && item.status !== 'done';
        const whyData = item.jira_triage || item.jira_dedupe || item.jira_error
          ? { triage: item.jira_triage, dedupe: item.jira_dedupe, error: item.jira_error }
          : null;

        return `<article class="fb-card" data-fb-id="${item.id}">
          <div class="fb-card-head">
            <span class="badge ${kindCls}">${kindLabel}</span>
            <span class="fb-title">${esc(item.title || `Rückmeldung #${item.id}`)}</span>
            ${jiraBadge(item, jiraCfg)}
            <span class="muted small" style="margin-left:auto">#${item.id} · ${esc(fmtTime(item.created_at))}</span>
          </div>
          <div class="fb-msg">${esc(item.message)}</div>
          <div class="fb-actions">
            ${
              item.status !== 'done'
                ? `<button type="button" class="btn small primary" data-fb-status="done">Erledigt</button>
                   <button type="button" class="btn small" data-fb-status="in_progress">In Arbeit</button>`
                : `<button type="button" class="btn small" data-fb-status="new">Wieder öffnen</button>`
            }
            ${item.session_id ? `<button type="button" class="btn small" data-open-trace="${esc(item.session_id)}">Chat-Trace öffnen ↗</button>` : ''}
            ${canRetry ? `<button type="button" class="btn small" data-jira-retry="false">Nach Jira senden</button>` : ''}
            ${canForce ? `<button type="button" class="btn small" data-jira-retry="true">Trotzdem übertragen</button>` : ''}
          </div>
          <details class="fb-details"><summary>Technischer Kontext (Client &amp; Server)</summary><pre>${esc(JSON.stringify(item.context || {}, null, 2))}</pre></details>
          ${whyData ? `<details class="fb-details"><summary>Warum dieses Thema? (Vorprüfung &amp; Duplikatprüfung)</summary><pre>${esc(JSON.stringify(whyData, null, 2))}</pre></details>` : ''}
        </article>`;
      })
      .join('');

    $('feedbackList')
      .querySelectorAll('.fb-card')
      .forEach((card) => {
        const id = card.dataset.fbId;
        card.querySelectorAll('[data-fb-status]').forEach((b) => {
          b.onclick = async () => {
            await api(`/api/admin/feedback/${id}/status`, { method: 'PUT', body: { status: b.dataset.fbStatus } });
            await loadFeedback();
          };
        });
        card.querySelectorAll('[data-jira-retry]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            await api(`/api/admin/feedback/${id}/jira-retry`, {
              method: 'POST',
              body: { force: b.dataset.jiraRetry === 'true' }
            });
            await loadFeedback();
          };
        });
        card.querySelectorAll('[data-open-trace]').forEach((b) => {
          b.onclick = () => {
            switchView('sessions');
            openSessionDetail(b.dataset.openTrace);
          };
        });
      });
  }

  // ---------- View 5: Closed-Loop Improvement Flywheel ----------

  async function loadImprovements() {
    const d = await api('/api/admin/improvements');
    const clusters = d.clusters || [];
    const evals = d.evalCases || [];
    const props = d.proposals || [];

    $('clustersGrid').innerHTML =
      clusters
        .map(
          (c) => `<div class="cluster-card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <code>${esc(c.cluster_tag)}</code>
              <span class="badge ${c.avg_score < 3 ? 'bad' : 'warn'}">★ ${c.avg_score}</span>
            </div>
            <div class="small muted">${fmtNum(c.session_count)} Sessions · ${fmtNum(c.thumbs_down)} 👎 · ${fmtNum(c.error_sessions)} Fehler</div>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button type="button" class="btn small" data-cluster-traces="${esc(c.cluster_tag)}">Traces ansehen</button>
              <button type="button" class="btn small primary" data-cluster-prop="${esc(c.cluster_tag)}">Fix planen</button>
            </div>
          </div>`
        )
        .join('') || '<div class="card empty-state" style="grid-column:1/-1">Noch keine Problem-Cluster erkannt – erscheinen automatisch, sobald Traces mit Fehlern oder 👎 eingehen.</div>';

    $('clustersGrid')
      .querySelectorAll('[data-cluster-traces]')
      .forEach((b) => {
        b.onclick = () => {
          switchView('sessions', { skipLoad: true });
          loadSessions({ cluster: b.dataset.clusterTraces });
        };
      });

    $('clustersGrid')
      .querySelectorAll('[data-cluster-prop]')
      .forEach((b) => {
        b.onclick = () => {
          $('propCluster').value = b.dataset.clusterProp;
          $('propTitle').value = `Fix für ${b.dataset.clusterProp}`;
          $('proposalDialog').showModal();
        };
      });

    $('evalCount').textContent = `${evals.length} Cases`;
    $('evalList').innerHTML =
      evals
        .map(
          (ev) => `<div class="mini-card">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong>${esc(ev.title)}</strong>
              <span class="badge accent">${esc(ev.category)}</span>
            </div>
            <div class="small muted" style="margin:4px 0">${esc(ev.prompt_redacted).slice(0, 140)}</div>
            <div class="small muted">Datei: <code>${esc(ev.exported_filename || 'eval.json')}</code> · ${esc(fmtTime(ev.created_at))}</div>
          </div>`
        )
        .join('') || '<div class="empty-state small">Noch keine Golden Evals exportiert. Öffne eine Session im Trace Explorer und klicke „Als Golden Eval exportieren“.</div>';

    $('proposalList').innerHTML =
      props
        .map(
          (p) => `<div class="mini-card" data-prop-id="${p.id}">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong>${esc(p.title)}</strong>
              <span class="badge ${p.status === 'active' ? 'ok' : p.status === 'canary' ? 'warn' : p.status === 'rolled_back' ? 'bad' : ''}">${esc(p.status)} · ${p.rollout_pct}%</span>
            </div>
            <div class="small muted" style="margin:4px 0">${esc(p.target_type)}${p.cluster_tag ? ` · ${esc(p.cluster_tag)}` : ''}</div>
            <div class="small" style="margin-bottom:8px">${esc(p.rationale)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn small" data-rollout="5" data-status="canary">Canary 5 %</button>
              <button type="button" class="btn small" data-rollout="25" data-status="canary">Ramp 25 %</button>
              <button type="button" class="btn small primary" data-rollout="100" data-status="active">100 % Aktiv</button>
              <button type="button" class="btn small danger" data-rollout="0" data-status="rolled_back">Rollback</button>
            </div>
          </div>`
        )
        .join('') || '<div class="empty-state small">Noch keine Verbesserungs-Proposals angelegt.</div>';

    $('proposalList')
      .querySelectorAll('[data-prop-id]')
      .forEach((card) => {
        const id = card.dataset.propId;
        card.querySelectorAll('[data-rollout]').forEach((b) => {
          b.onclick = async () => {
            await api(`/api/admin/improvements/proposals/${id}`, {
              method: 'PUT',
              body: { rolloutPct: Number(b.dataset.rollout), status: b.dataset.status }
            });
            await loadImprovements();
          };
        });
      });
  }

  // ---------- View 6: Fleet & Installations ----------

  async function loadFleet() {
    const d = await api('/api/admin/installations');
    const list = d.installations || [];
    $('fleetCount').textContent = `${list.length} Installationen`;
    $('fleetTableBody').innerHTML =
      list
        .map(
          (i) => `<tr>
            <th>${esc(i.install_id.slice(0, 12))}…</th>
            <td>${esc(i.os_platform)} / ${esc(i.os_arch)}</td>
            <td><code>v${esc(i.app_version)}</code></td>
            <td>${i.ram_gb ? `${i.ram_gb} GB` : '—'} / ${i.vram_gb ? `${i.vram_gb} GB` : 'CPU'} (${esc(i.gpu_tier)})</td>
            <td>${esc(i.provider)}</td>
            <td><span class="badge ${i.consent_tier === 'traces' ? 'accent' : 'ok'}">${esc(i.consent_tier)}</span></td>
            <td>${esc(fmtTime(i.last_seen))}</td>
          </tr>`
        )
        .join('') || '<tr><td colspan="7" class="muted">Noch keine Clients gemeldet.</td></tr>';
  }

  // ---------- Navigation & Actions ----------

  async function refreshCurrentView() {
    try {
      if (state.view === 'analytics') await loadAnalytics();
      else if (state.view === 'performance') await loadPerformance();
      else if (state.view === 'sessions') await loadSessions();
      else if (state.view === 'feedback') await loadFeedback();
      else if (state.view === 'improvements') await loadImprovements();
      else if (state.view === 'fleet') await loadFleet();
    } catch (err) {
      console.error('View refresh error:', err);
    }
  }

  function switchView(name, { skipLoad = false } = {}) {
    state.view = name;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
    const [title, sub] = VIEW_META[name] || ['Aura Admin', ''];
    $('pageTitle').textContent = title;
    $('pageSub').textContent = sub;
    if (!skipLoad) refreshCurrentView();
  }

  function showLogin() {
    $('appShell').classList.add('hidden');
    $('loginGate').classList.remove('hidden');
  }

  function showApp(user) {
    $('loginGate').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('adminName').textContent = user.name || 'Admin';
    $('adminEmail').textContent = user.email || '';
    refreshCurrentView();
  }

  async function bootAuth() {
    const [cfg, health] = await Promise.all([
      fetch('/api/auth/config').then((r) => r.json()).catch(() => ({})),
      fetch('/api/health').then((r) => r.json()).catch(() => ({}))
    ]);
    if (health.env) $('envBadge').textContent = `k3s · ${health.env}`;
    const grafanaUrl = cfg.grafanaUrl || health.grafanaUrl || '';
    if (grafanaUrl && /^https?:\/\//.test(grafanaUrl)) {
      $('grafanaLink').href = grafanaUrl;
      $('grafanaLink').classList.remove('hidden');
    }

    if (cfg.devLoginEnabled) $('devLoginForm').classList.remove('hidden');
    if (cfg.googleConfigured && cfg.googleClientId) {
      $('googleSignInWrap').classList.remove('hidden');
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => {
        if (!window.google || !window.google.accounts) return;
        window.google.accounts.id.initialize({
          client_id: cfg.googleClientId,
          callback: async (resp) => {
            try {
              const out = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
              showApp(out.user);
            } catch (err) {
              $('loginStatus').textContent = err.message;
            }
          }
        });
        window.google.accounts.id.renderButton($('googleBtnTarget'), { theme: 'outline', size: 'large', width: 360 });
      };
      document.head.appendChild(s);
    }

    try {
      const me = await api('/api/auth/me');
      if (me && me.authenticated) {
        showApp(me.user);
        return;
      }
    } catch {}
    showLogin();
  }

  // ---------- Event Wiring ----------

  initThemeToggle();
  initDialogs();

  document.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });

  $('daysSelect').onchange = () => {
    state.days = Number($('daysSelect').value) || 30;
    refreshCurrentView();
  };
  $('refreshBtn').onclick = refreshCurrentView;

  $('logoutBtn').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    showLogin();
  };

  $('devLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginStatus').textContent = 'Prüfe Token …';
    try {
      const out = await api('/api/auth/dev', { method: 'POST', body: { token: $('devTokenInput').value } });
      $('devTokenInput').value = '';
      $('loginStatus').textContent = '';
      showApp(out.user);
    } catch (err) {
      $('loginStatus').textContent = err.message;
    }
  });

  $('sessionFilterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loadSessions();
  });

  $('btnJudgeSession').onclick = async () => {
    if (!state.selectedSessionId) return;
    $('btnJudgeSession').disabled = true;
    try {
      await api(`/api/admin/sessions/${encodeURIComponent(state.selectedSessionId)}/evaluate`, { method: 'POST' });
      await openSessionDetail(state.selectedSessionId);
    } finally {
      $('btnJudgeSession').disabled = false;
    }
  };

  $('btnExportEval').onclick = async () => {
    if (!state.selectedSessionId) return;
    const res = await api(`/api/admin/sessions/${encodeURIComponent(state.selectedSessionId)}/export-eval`, {
      method: 'POST',
      body: {}
    });
    state.lastEvalArtifact = res.artifact;
    $('evalJsonPre').textContent = JSON.stringify(res.artifact.spec, null, 2);
    $('evalDialog').showModal();
  };

  $('btnCopyEval').onclick = async () => {
    if (!state.lastEvalArtifact) return;
    await navigator.clipboard.writeText(JSON.stringify(state.lastEvalArtifact.spec, null, 2));
    $('btnCopyEval').textContent = 'Kopiert ✓';
    setTimeout(() => ($('btnCopyEval').textContent = 'JSON kopieren'), 1500);
  };

  $('btnDownloadEval').onclick = () => {
    if (!state.lastEvalArtifact) return;
    const blob = new Blob([JSON.stringify(state.lastEvalArtifact.spec, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.lastEvalArtifact.filename || 'eval_case.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  document.querySelectorAll('[data-fb-filter]').forEach((tab) => {
    tab.onclick = () => {
      state.feedbackFilter = tab.dataset.fbFilter;
      document.querySelectorAll('[data-fb-filter]').forEach((t) => t.classList.toggle('active', t === tab));
      loadFeedback();
    };
  });

  $('btnNewProposal').onclick = () => {
    $('proposalForm').reset();
    $('propPatch').value = '{}';
    $('proposalDialog').showModal();
  };

  $('proposalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let patch;
    try {
      patch = JSON.parse($('propPatch').value || '{}');
    } catch {
      alert('Config-Patch muss gültiges JSON sein.');
      return;
    }
    await api('/api/admin/improvements/proposals', {
      method: 'POST',
      body: {
        title: $('propTitle').value.trim(),
        targetType: $('propTarget').value,
        rolloutPct: Number($('propRollout').value || 0),
        clusterTag: $('propCluster').value.trim(),
        rationale: $('propRationale').value.trim(),
        configPatch: patch
      }
    });
    $('proposalDialog').close('saved');
    await loadImprovements();
  });

  bootAuth();
})();
