/**
 * =====================================================================
 * ASTRA — HUD Renderers
 * =====================================================================
 * Pure functions that return HTML strings for each HUD panel.
 * All dynamic text is escaped to prevent XSS.
 *
 * Design principle: each render function is idempotent — calling it
 * with the same inputs produces the same HTML, which makes diffing
 * and re-rendering cheap.
 * =====================================================================
 */

import type { Vitals, RiskAlert, HealthScanResult, BodySystem } from './types';
import { formatVitals, classifyMetric } from './telemetry';
import { levelLabel, levelColor } from './risk-engine';
import { escapeHtml } from './utils';

// ---------------------------------------------------------------------
// Telemetry panels
// ---------------------------------------------------------------------

/**
 * Left panel — suit / cabin environment.
 */
export function renderTelemetryLeft(v: Vitals): string {
  const f = formatVitals(v);
  return `
    <div class="hud-label">Suit / Cabin Telemetry</div>
    <div class="hud-row"><span class="hud-row-label">Suit Pressure</span><span class="hud-row-value">${f.suitPressure}</span></div>
    <div class="hud-row"><span class="hud-row-label">Cabin Temp</span><span class="hud-row-value">${f.cabinTemp}</span></div>
    <div class="hud-row"><span class="hud-row-label">Oxygen</span><span class="hud-row-value">${f.oxygen}</span></div>
    <div class="hud-row"><span class="hud-row-label">CO₂</span><span class="hud-row-value">${f.co2}</span></div>
    <div class="hud-row"><span class="hud-row-label">Radiation</span><span class="hud-row-value">${f.radiation}</span></div>
    <div class="hud-label" style="margin-top:0.4rem;font-size:0.48rem;opacity:0.6;">SIMULATED DEMO DATA</div>
  `;
}

/**
 * Right panel — biometrics + heartbeat waveform canvas.
 */
export function renderTelemetryRight(v: Vitals): string {
  const f = formatVitals(v);
  const hrLevel = classifyMetric('heartRate', v.heartRate);
  const spo2Level = classifyMetric('spo2', v.spo2);
  const rrLevel = classifyMetric('respiratoryRate', v.respiratoryRate);
  const tempLevel = classifyMetric('bodyTemp', v.bodyTemp);

  return `
    <div class="hud-label">Biometrics</div>
    <div class="hud-row"><span class="hud-row-label">Heart Rate</span><span class="hud-row-value" style="color:${levelColor(hrLevel)}">${f.heartRate}</span></div>
    <div class="hud-row"><span class="hud-row-label">SpO₂</span><span class="hud-row-value" style="color:${levelColor(spo2Level)}">${f.spo2}</span></div>
    <div class="hud-row"><span class="hud-row-label">Resp. Rate</span><span class="hud-row-value" style="color:${levelColor(rrLevel)}">${f.respiratoryRate}</span></div>
    <div class="hud-row"><span class="hud-row-label">Body Temp</span><span class="hud-row-value" style="color:${levelColor(tempLevel)}">${f.bodyTemp}</span></div>
    <div class="waveform"><canvas id="hr-wave" width="200" height="32"></canvas></div>
    <div class="hud-label" style="margin-top:0.2rem;font-size:0.48rem;opacity:0.6;">SIMULATED DEMO DATA</div>
  `;
}

// ---------------------------------------------------------------------
// Mission clock (top center)
// ---------------------------------------------------------------------

export function renderMissionClock(
  missionName: string,
  utcTime: string,
  elapsed: string,
  eva: boolean
): string {
  return `
    <div class="mission-clock">${escapeHtml(elapsed)}</div>
    <div class="mission-name">${escapeHtml(missionName)}</div>
    <div class="mission-status ${eva ? 'eva' : ''}">${eva ? 'EVA' : 'IN-MISSION'}</div>
    <div class="mission-name" style="margin-top:0.2rem;font-size:0.48rem;">UTC ${escapeHtml(utcTime)}</div>
  `;
}

// ---------------------------------------------------------------------
// Crew ID (bottom left)
// ---------------------------------------------------------------------

export function renderCrewId(name: string, missionId: string, suitId: string): string {
  return `
    <div class="hud-label">Crew</div>
    <div class="hud-row"><span class="hud-row-label">Name</span><span class="hud-row-value">${escapeHtml(name)}</span></div>
    <div class="hud-row"><span class="hud-row-label">Mission</span><span class="hud-row-value">${escapeHtml(missionId)}</span></div>
    <div class="hud-row"><span class="hud-row-label">Suit</span><span class="hud-row-value">${escapeHtml(suitId)}</span></div>
  `;
}

// ---------------------------------------------------------------------
// Comm link (bottom right)
// ---------------------------------------------------------------------

export function renderCommLink(online: boolean, delaySeconds: number): string {
  const status = online ? 'ONLINE' : 'OFFLINE';
  const color = online ? 'var(--astra-green)' : 'var(--astra-red)';
  return `
    <div class="hud-label">Earth Comm Link</div>
    <div class="hud-row"><span class="hud-row-label">Status</span><span class="hud-row-value" style="color:${color}">${status}</span></div>
    <div class="hud-row"><span class="hud-row-label">Signal Delay</span><span class="hud-row-value">${delaySeconds.toFixed(1)} s</span></div>
    <div class="hud-row"><span class="hud-row-label">Band</span><span class="hud-row-value">X-Band</span></div>
  `;
}

// ---------------------------------------------------------------------
// Alerts panel (right middle)
// ---------------------------------------------------------------------

export function renderAlerts(scan: HealthScanResult): string {
  if (!scan.alerts.length) {
    return `
      <div class="hud-label">AI Health Intelligence</div>
      <div class="alert-item" style="color:var(--astra-green)">
        <span class="alert-level nominal">NOMINAL</span>
        All systems nominal.
      </div>
    `;
  }

  const items = scan.alerts
    .slice(0, 4)
    .map((a: RiskAlert) => `
      <div class="alert-item">
        <span class="alert-level ${a.level}">${levelLabel(a.level)}</span>
        ${escapeHtml(a.title)}
        <div style="color:var(--astra-dim);font-size:0.56rem;margin-top:0.1rem;">${escapeHtml(a.detail)}</div>
      </div>
    `)
    .join('');

  return `<div class="hud-label">AI Health Intelligence</div>${items}`;
}

// ---------------------------------------------------------------------
// Body systems (left middle)
// ---------------------------------------------------------------------

export function renderBodySystems(scan: HealthScanResult): string {
  const systems: Array<{ key: BodySystem; label: string }> = [
    { key: 'cardiovascular', label: 'Cardio' },
    { key: 'respiratory', label: 'Resp.' },
    { key: 'immune', label: 'Immune' },
    { key: 'musculoskeletal', label: 'Musc.' },
    { key: 'neurological', label: 'Neuro' },
  ];

  const dots = systems
    .map((s) => {
      const level = scan.systems[s.key].level;
      return `<div class="body-sys ${level}" title="${escapeHtml(scan.systems[s.key].note)}"><span class="dot"></span>${s.label}</div>`;
    })
    .join('');

  return `
    <div class="hud-label" style="text-align:center">Body Systems</div>
    <svg viewBox="0 0 60 120" aria-hidden="true">
      <circle cx="30" cy="14" r="9" fill="none" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="23" x2="30" y2="70" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="35" x2="14" y2="55" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="35" x2="46" y2="55" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="70" x2="18" y2="105" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="70" x2="42" y2="105" stroke="var(--astra-cyan)" stroke-width="1.2" opacity="0.7"/>
      <circle cx="30" cy="42" r="4" fill="var(--astra-cyan)" opacity="0.5">
        <animate attributeName="r" values="4;5;4" dur="2s" repeatCount="indefinite"/>
      </circle>
    </svg>
    ${dots}
  `;
}

// ---------------------------------------------------------------------
// Health scan result (modal body)
// ---------------------------------------------------------------------

export function renderScanResult(result: HealthScanResult): string {
  const systems: Array<{ key: BodySystem; label: string }> = [
    { key: 'cardiovascular', label: 'Cardiovascular' },
    { key: 'respiratory', label: 'Respiratory' },
    { key: 'immune', label: 'Immune' },
    { key: 'musculoskeletal', label: 'Musculoskeletal' },
    { key: 'neurological', label: 'Neurological' },
  ];

  const rows = systems
    .map((s) => {
      const sys = result.systems[s.key];
      return `
        <div class="system-row">
          <span>${s.label}</span>
          <span style="color:${levelColor(sys.level)};font-weight:700">${levelLabel(sys.level)}</span>
        </div>
        <div style="font-size:0.7rem;color:var(--astra-dim);padding:0 0 0.4rem;">${escapeHtml(sys.note)}</div>
      `;
    })
    .join('');

  const recs = result.recommendations
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join('');

  return `
    <div class="scan-score">${result.score}<span style="font-size:0.9rem;color:var(--astra-dim)">/100</span></div>
    <div class="hud-label" style="text-align:center">
      Overall: <span style="color:${levelColor(result.overall)}">${levelLabel(result.overall)}</span>
    </div>
    <div class="scan-results" style="margin-top:0.8rem">${rows}</div>
    <div class="hud-label" style="margin-top:0.8rem">Recommendations</div>
    <ul style="font-size:0.78rem;line-height:1.6;color:var(--astra-text);padding-left:1.2rem;">${recs}</ul>
    <div class="hud-label" style="margin-top:0.5rem;font-size:0.55rem;opacity:0.6;">
      SIMULATED DEMO DATA — NOT A MEDICAL DIAGNOSIS
    </div>
  `;
}
