/**
 * =====================================================================
 * ASTRA — Vision View (The Immersive Astronaut POV)
 * =====================================================================
 * This is the heart of the application. It:
 *   • Requests the live camera feed and renders it full-screen
 *   • Renders the complete astronaut helmet HUD
 *   • Wires up every interactive control (camera, scan, copilot, etc.)
 *   • Manages timers, animation loops, and cleanup
 *
 * Critical: all media streams are stopped in destroy() and on exit,
 * preventing memory leaks and stuck camera LEDs.
 * =====================================================================
 */

import { CameraControls } from './camera-controls';
import {
  describeCameraError,
  isCameraSupported,
  isSecureContext,
  mapErrorToStatus,
} from './camera';
import { TelemetryGenerator } from './telemetry';
import { analyzeVitals } from './health-engine';
import { summarizeRisks, levelLabel, levelColor } from './risk-engine';
import { runSimulation, DEFAULT_SIM_INPUT, type SimulationInput } from './simulation';
import {
  renderTelemetryLeft,
  renderTelemetryRight,
  renderAlerts,
  renderMissionClock,
  renderCrewId,
  renderCommLink,
  renderBodySystems,
  renderScanResult,
} from './hud';
import { appState } from './state';
import { formatDuration, escapeHtml, uid } from './utils';
import { safeSetJSON } from './storage';
import type { Astronaut, CopilotMessage, HealthScanResult } from './types';

const ASTRONAUT: Astronaut = {
  name: 'Cmdr. A. Vega',
  missionId: 'ASTRA-MARS-07',
  suitId: 'EVA-SUIT-42',
  missionName: 'MARS TRANSIT — PHASE 2',
};

export class VisionView {
  private root: HTMLElement;
  private onExit: () => void;
  private camera: CameraControls | null = null;
  private telemetry: TelemetryGenerator;
  private tickHandle: number | null = null;
  private clockHandle: number | null = null;
  private scan: HealthScanResult;
  private startTime = Date.now();
  private video: HTMLVideoElement | null = null;
  private demoMode = false;
  private copilotMessages: CopilotMessage[] = [];
  private soundEnabled = true;
  private hudBrightness = 1;
  private emergencyActive = false;
  private destroyed = false;
  private waveformCtx: CanvasRenderingContext2D | null = null;
  private waveformPhase = 0;
  private unsubState: (() => void) | null = null;
  private rafHandle: number | null = null;

  constructor(root: HTMLElement, onExit: () => void) {
    this.root = root;
    this.onExit = onExit;
    this.telemetry = new TelemetryGenerator();
    this.scan = analyzeVitals(this.telemetry.get());
  }

  async mount(): Promise<void> {
    appState.setMode('vision');
    this.render();
    this.bindControls();

    // Camera initialization
    if (!isCameraSupported() || !isSecureContext()) {
      this.demoMode = true;
      appState.setCameraStatus('unavailable');
      this.showDemoBackground();
      this.toast('Camera unavailable — running in DEMO MODE with simulated environment.');
    } else {
      appState.setCameraStatus('requesting');
      const ok = await this.initCamera();
      if (!ok) {
        this.demoMode = true;
        this.showDemoBackground();
      }
    }

    this.startClock();
    this.startTelemetryLoop();
    this.startWaveform();

    this.unsubState = appState.subscribe((s) => {
      if (this.destroyed) return;
      this.soundEnabled = s.soundEnabled;
      this.hudBrightness = s.hudBrightness;
      this.emergencyActive = s.emergencyActive;
      this.applyBrightness();
    });
  }

  destroy(): void {
    this.destroyed = true;

    if (this.camera) {
      this.camera.destroy();
      this.camera = null;
    }
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.clockHandle !== null) {
      clearInterval(this.clockHandle);
      this.clockHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.unsubState) {
      this.unsubState();
      this.unsubState = null;
    }

    this.video = null;
    this.waveformCtx = null;
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  private render(): void {
    const v = this.telemetry.get();
    const scan = this.scan;
    this.root.innerHTML = `
      <div class="vision" id="vision-root">
        <video class="vision-camera" id="vision-video" autoplay playsinline muted></video>
        <div class="vision-demo-bg" id="demo-bg" style="display:none"></div>
        <div class="visor-frame"></div>
        <div class="emergency-flash" id="emergency-flash"></div>

        <div class="hud" id="hud">
          <div class="hud-panel hud-tc" id="hud-tc">
            ${renderMissionClock(ASTRONAUT.missionName, this.utc(), '00:00:00', false)}
          </div>
          <div class="hud-panel hud-tl" id="hud-tl">${renderTelemetryLeft(v)}</div>
          <div class="hud-panel hud-tr" id="hud-tr">${renderTelemetryRight(v)}</div>
          <div class="hud-panel hud-body" id="hud-body">${renderBodySystems(scan)}</div>
          <div class="hud-panel hud-ai" id="hud-ai">${renderAlerts(scan)}</div>
          <div class="hud-panel hud-bl" id="hud-bl">
            ${renderCrewId(ASTRONAUT.name, ASTRONAUT.missionId, ASTRONAUT.suitId)}
          </div>
          <div class="hud-panel hud-br" id="hud-br">
            ${renderCommLink(true, 12.4)}
          </div>
          <div class="hud-bc" id="hud-bc">
            <button class="hud-btn" id="btn-scan" title="Run health scan">Health Scan</button>
            <button class="hud-btn" id="btn-copilot" title="AI medical copilot">AI Copilot</button>
            <button class="hud-btn" id="btn-sim" title="Future health simulator">Simulator</button>
            <button class="hud-btn danger" id="btn-emergency" title="Emergency mode">Emergency</button>
            <button class="hud-btn" id="btn-camera" title="Camera on/off">Cam ON</button>
            <button class="hud-btn" id="btn-switch" title="Switch camera">Flip</button>
            <button class="hud-btn" id="btn-fullscreen" title="Toggle fullscreen">Full</button>
            <button class="hud-btn" id="btn-sound" title="Toggle sound">Sound</button>
            <button class="hud-btn" id="btn-brightness" title="Cycle HUD brightness">HUD</button>
            <button class="hud-btn" id="btn-return" title="Return to dashboard">Return</button>
          </div>
        </div>

        <div class="scan-overlay" id="scan-overlay">
          <div class="scan-line"></div>
          <div class="scan-text" id="scan-text">SCANNING</div>
        </div>

        <div class="toast-container" id="toast-container"></div>
      </div>
    `;
    this.video = this.root.querySelector('#vision-video') as HTMLVideoElement | null;
  }

  private async initCamera(): Promise<boolean> {
    if (!this.video) return false;
    this.camera = new CameraControls({
      video: this.video,
      onStatusChange: (status, facing) => {
        appState.setCameraStatus(
          status === 'active' ? 'active' : status === 'off' ? 'idle' : 'error'
        );
        appState.setCameraFacing(facing);
        this.updateCameraButton();
      },
      onError: (msg) => {
        const err = new Error(msg);
        appState.setCameraStatus(mapErrorToStatus(err));
        this.toast(describeCameraError(err));
      },
    });
    return this.camera.turnOn('environment');
  }

  private showDemoBackground(): void {
    const bg = this.root.querySelector('#demo-bg') as HTMLElement | null;
    if (bg) bg.style.display = 'block';
    const video = this.root.querySelector('#vision-video') as HTMLElement | null;
    if (video) video.style.display = 'none';
    this.updateCameraButton();
  }

  // -------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------

  private bindControls(): void {
    this.on('#btn-scan', () => this.runHealthScan());
    this.on('#btn-copilot', () => this.openCopilot());
    this.on('#btn-sim', () => this.openSimulator());
    this.on('#btn-emergency', () => this.openEmergency());
    this.on('#btn-camera', () => this.toggleCamera());
    this.on('#btn-switch', () => this.switchCamera());
    this.on('#btn-fullscreen', () => this.toggleFullscreen());
    this.on('#btn-sound', () => this.toggleSound());
    this.on('#btn-brightness', () => this.cycleBrightness());
    this.on('#btn-return', () => this.exit());
  }

  private on(selector: string, fn: () => void): void {
    const el = this.root.querySelector(selector);
    if (el) el.addEventListener('click', fn);
  }

  private async toggleCamera(): Promise<void> {
    if (!this.camera) {
      const ok = await this.initCamera();
      if (!ok) return;
      this.demoMode = false;
      const bg = this.root.querySelector('#demo-bg') as HTMLElement | null;
      if (bg) bg.style.display = 'none';
      const video = this.root.querySelector('#vision-video') as HTMLElement | null;
      if (video) video.style.display = 'block';
      this.toast('Camera ON');
      return;
    }
    await this.camera.toggle();
    this.toast(this.camera.isActive() ? 'Camera ON' : 'Camera OFF');
  }

  private async switchCamera(): Promise<void> {
    if (!this.camera) {
      this.toast('Camera not active.');
      return;
    }
    await this.camera.switchFacing();
    this.toast(
      `Camera switched to ${this.camera.getFacingMode() === 'environment' ? 'rear' : 'front'}`
    );
  }

  private updateCameraButton(): void {
    const btn = this.root.querySelector('#btn-camera') as HTMLButtonElement | null;
    if (!btn) return;
    const active = this.camera?.isActive() ?? false;
    btn.textContent = active ? 'Cam OFF' : 'Cam ON';
    btn.classList.toggle('active', active);
  }

  private toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {
        this.toast('Fullscreen not available.');
      });
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  private toggleSound(): void {
    const next = appState.toggleSound();
    this.soundEnabled = next;
    const btn = this.root.querySelector('#btn-sound') as HTMLButtonElement | null;
    if (btn) btn.classList.toggle('active', next);
    this.toast(next ? 'Sound ON' : 'Sound OFF');
  }

  private cycleBrightness(): void {
    const levels = [0.6, 0.8, 1, 1.2];
    const idx = levels.findIndex((l) => Math.abs(l - this.hudBrightness) < 0.01);
    const next = levels[(idx + 1) % levels.length];
    appState.setBrightness(next);
    this.hudBrightness = next;
    this.applyBrightness();
    this.toast(`HUD brightness: ${Math.round(next * 100)}%`);
  }

  private applyBrightness(): void {
    const root = this.root.querySelector('#vision-root') as HTMLElement | null;
    if (root) root.style.setProperty('--hud-brightness', String(this.hudBrightness));
  }

  private exit(): void {
    this.destroy();
    this.onExit();
  }

  // -------------------------------------------------------------------
  // Health scan
  // -------------------------------------------------------------------

  private async runHealthScan(): Promise<void> {
    const overlay = this.root.querySelector('#scan-overlay') as HTMLElement | null;
    const text = this.root.querySelector('#scan-text') as HTMLElement | null;
    if (!overlay || !text) return;

    overlay.classList.add('active');
    const steps = ['SCANNING', 'ANALYSING', 'EVALUATING', 'COMPLETE'];
    for (const s of steps) {
      text.textContent = s;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.scan = analyzeVitals(this.telemetry.get());
    overlay.classList.remove('active');
    this.updatePanels();
    this.openModal('HEALTH SCAN RESULTS', renderScanResult(this.scan));
  }

  // -------------------------------------------------------------------
  // Copilot
  // -------------------------------------------------------------------

  private openCopilot(): void {
    if (!this.copilotMessages.length) {
      this.copilotMessages.push({
        role: 'copilot',
        text: 'ASTRA Medical Copilot online. Ask about your health indicators, risk factors, or countermeasures. (Demo data only — not medical advice.)',
        timestamp: Date.now(),
      });
    }
    const body = `
      <div class="copilot-messages" id="copilot-msgs">${this.renderCopilotMessages()}</div>
      <div class="copilot-input-row">
        <input class="copilot-input" id="copilot-input" placeholder="Ask ASTRA..." autocomplete="off" />
        <button class="hud-btn" id="copilot-send">Send</button>
      </div>
    `;
    this.openModal('AI MEDICAL COPILOT', body);
    const input = this.root.querySelector('#copilot-input') as HTMLInputElement | null;
    const send = this.root.querySelector('#copilot-send') as HTMLButtonElement | null;
    if (input && send) {
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        this.copilotMessages.push({ role: 'user', text, timestamp: Date.now() });
        const reply = this.generateCopilotReply(text);
        this.copilotMessages.push({ role: 'copilot', text: reply, timestamp: Date.now() });
        input.value = '';
        const msgs = this.root.querySelector('#copilot-msgs');
        if (msgs) {
          msgs.innerHTML = this.renderCopilotMessages();
          msgs.scrollTop = msgs.scrollHeight;
        }
      };
      send.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      input.focus();
    }
  }

  private renderCopilotMessages(): string {
    return this.copilotMessages
      .map((m) => `<div class="copilot-msg ${m.role}">${escapeHtml(m.text)}</div>`)
      .join('');
  }

  private generateCopilotReply(input: string): string {
    const q = input.toLowerCase();
    const v = this.telemetry.get();
    const risks = summarizeRisks(this.scan);

    if (q.includes('heart') || q.includes('hr')) {
      return `Current heart rate is ${Math.round(v.heartRate)} bpm. ${
        risks.byLevel.critical || risks.byLevel.warning
          ? 'There are active alerts — review the AI panel.'
          : 'This is within the simulated nominal range.'
      } (Demo data.)`;
    }
    if (q.includes('oxygen') || q.includes('spo2') || q.includes('o2')) {
      return `SpO₂ is currently ${v.spo2.toFixed(1)}% and cabin O₂ is ${v.oxygen.toFixed(1)}%. (Demo data.)`;
    }
    if (q.includes('stress') || q.includes('sleep') || q.includes('tired')) {
      return 'Long-duration missions often cause sleep disruption. Maintain a consistent sleep schedule, limit stimulants before rest, and use scheduled rest periods. (Decision-support only.)';
    }
    if (q.includes('radiation')) {
      return `Current simulated radiation is ${v.radiation.toFixed(2)} µSv/h. Limit EVA time and monitor cumulative dose. (Demo data.)`;
    }
    if (q.includes('emergency') || q.includes('help') || q.includes('urgent')) {
      return 'If this is a medical emergency, activate EMERGENCY mode from the bottom controls. It provides onboard guidance and incident recording. (Demo only — not real medical advice.)';
    }
    if (q.includes('bone') || q.includes('muscle')) {
      return 'Musculoskeletal countermeasures: resistance exercise, adequate vitamin D, and periodic monitoring. Bone density cannot be measured from a camera — it requires dedicated hardware. (Demo data.)';
    }
    if (q.includes('recommend') || q.includes('advice') || q.includes('what should')) {
      return `Top recommendation: ${
        risks.sortedAlerts[0]?.recommendation ?? 'continue nominal operations.'
      }`;
    }
    return `I can help with heart rate, SpO₂, oxygen, stress/sleep, radiation, and emergency guidance. Current overall risk: ${levelLabel(
      risks.topLevel
    )}. (All values are simulated demo data — not a diagnosis.)`;
  }

  // -------------------------------------------------------------------
  // Simulator
  // -------------------------------------------------------------------

  private openSimulator(): void {
    const body = `
      <div class="sim-slider-row">
        <label>Sleep <span id="sim-sleep-val">7.5 h</span></label>
        <input type="range" id="sim-sleep" min="4" max="10" step="0.5" value="${DEFAULT_SIM_INPUT.sleepHours}" />
      </div>
      <div class="sim-slider-row">
        <label>Exercise <span id="sim-ex-val">45 min</span></label>
        <input type="range" id="sim-ex" min="0" max="120" step="5" value="${DEFAULT_SIM_INPUT.exerciseMinutes}" />
      </div>
      <div class="sim-slider-row">
        <label>Hydration <span id="sim-hyd-val">85 %</span></label>
        <input type="range" id="sim-hyd" min="50" max="100" step="5" value="${DEFAULT_SIM_INPUT.hydrationPct}" />
      </div>
      <div class="sim-slider-row">
        <label>Stress <span id="sim-stress-val">4 / 10</span></label>
        <input type="range" id="sim-stress" min="1" max="10" step="1" value="${DEFAULT_SIM_INPUT.stressLevel}" />
      </div>
      <div class="sim-slider-row">
        <label>Radiation exposure <span id="sim-rad-val">1x</span></label>
        <input type="range" id="sim-rad" min="0" max="5" step="0.5" value="${DEFAULT_SIM_INPUT.radiationExposure}" />
      </div>
      <button class="hud-btn" id="sim-run" style="width:100%">Run 7-Day Projection</button>
      <div class="sim-result" id="sim-result">Adjust parameters and run the simulation.</div>
    `;
    this.openModal('FUTURE HEALTH SIMULATOR', body);

    const read = (): SimulationInput => ({
      sleepHours: parseFloat((this.root.querySelector('#sim-sleep') as HTMLInputElement).value),
      exerciseMinutes: parseFloat((this.root.querySelector('#sim-ex') as HTMLInputElement).value),
      hydrationPct: parseFloat((this.root.querySelector('#sim-hyd') as HTMLInputElement).value),
      stressLevel: parseFloat((this.root.querySelector('#sim-stress') as HTMLInputElement).value),
      radiationExposure: parseFloat((this.root.querySelector('#sim-rad') as HTMLInputElement).value),
    });

    const bindLabel = (id: string, sliderId: string, fmt: (n: number) => string) => {
      const slider = this.root.querySelector(`#${sliderId}`) as HTMLInputElement | null;
      const label = this.root.querySelector(`#${id}`) as HTMLElement | null;
      if (slider && label) {
        const update = () => {
          label.textContent = fmt(parseFloat(slider.value));
        };
        slider.addEventListener('input', update);
        update();
      }
    };
    bindLabel('sim-sleep-val', 'sim-sleep', (n) => `${n} h`);
    bindLabel('sim-ex-val', 'sim-ex', (n) => `${n} min`);
    bindLabel('sim-hyd-val', 'sim-hyd', (n) => `${n} %`);
    bindLabel('sim-stress-val', 'sim-stress', (n) => `${n} / 10`);
    bindLabel('sim-rad-val', 'sim-rad', (n) => `${n}x`);

    const runBtn = this.root.querySelector('#sim-run') as HTMLButtonElement | null;
    if (runBtn) {
      runBtn.addEventListener('click', () => {
        const result = runSimulation(read());
        const out = this.root.querySelector('#sim-result') as HTMLElement | null;
        if (!out) return;
        const rows = result.days
          .map(
            (d) => `
              <div class="system-row">
                <span>Day ${d.day}</span>
                <span style="color:${levelColor(d.riskLevel)};font-weight:700">${levelLabel(d.riskLevel)}</span>
              </div>
              <div style="font-size:0.7rem;color:var(--astra-dim);padding:0 0 0.4rem;">${escapeHtml(d.note)}</div>
            `
          )
          .join('');
        out.innerHTML = `
          <div style="color:${levelColor(result.days[6].riskLevel)};font-weight:700;margin-bottom:0.5rem;">
            ${escapeHtml(result.summary)}
          </div>
          ${rows}
          <div class="hud-label" style="margin-top:0.5rem;font-size:0.55rem;opacity:0.6;">SIMULATED DEMO DATA</div>
        `;
      });
    }
  }

  // -------------------------------------------------------------------
  // Emergency
  // -------------------------------------------------------------------

  private openEmergency(): void {
    const body = `
      <div style="color:var(--astra-red);font-weight:700;letter-spacing:0.1em;margin-bottom:1rem;">
        EMERGENCY MEDICAL MODE ACTIVE
      </div>
      <div class="hud-label">Onboard Guidance</div>
      <ol style="font-size:0.82rem;line-height:1.7;color:var(--astra-text);padding-left:1.2rem;">
        <li>Ensure astronaut is in a safe, pressurised environment.</li>
        <li>Check responsiveness and airway.</li>
        <li>Verify suit pressure and cabin O₂/CO₂ readings.</li>
        <li>Contact flight surgeon at next comm window.</li>
        <li>Record incident details below.</li>
      </ol>
      <div class="hud-label" style="margin-top:1rem">Record Incident</div>
      <textarea id="emergency-notes" style="width:100%;min-height:90px;background:rgba(4,18,34,0.8);border:1px solid var(--astra-hud-border);border-radius:4px;color:var(--astra-text);font-family:var(--font-mono);font-size:0.78rem;padding:0.6rem;resize:vertical;" placeholder="Describe symptoms, environment, and actions taken..."></textarea>
      <div style="display:flex;gap:0.5rem;margin-top:0.8rem;">
        <button class="hud-btn danger" id="emergency-save" style="flex:1">Save Incident Report</button>
        <button class="hud-btn" id="emergency-clear" style="flex:1">Clear Emergency</button>
      </div>
      <div class="hud-label" style="margin-top:0.5rem;font-size:0.55rem;opacity:0.6;">
        DECISION SUPPORT ONLY — NOT A MEDICAL DIAGNOSIS
      </div>
    `;
    this.openModal('EMERGENCY MEDICAL ASSISTANCE', body);
    appState.setEmergency(true);
    this.emergencyActive = true;
    const flash = this.root.querySelector('#emergency-flash');
    if (flash) flash.classList.add('active');

    const save = this.root.querySelector('#emergency-save') as HTMLButtonElement | null;
    const clear = this.root.querySelector('#emergency-clear') as HTMLButtonElement | null;
    if (save) {
      save.addEventListener('click', () => {
        const notes =
          (this.root.querySelector('#emergency-notes') as HTMLTextAreaElement)?.value ?? '';
        safeSetJSON(`emergency-${uid()}`, {
          notes,
          timestamp: Date.now(),
          astronaut: ASTRONAUT,
          vitals: this.telemetry.get(),
        });
        this.toast('Incident report saved locally.');
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        appState.setEmergency(false);
        this.emergencyActive = false;
        const f = this.root.querySelector('#emergency-flash');
        if (f) f.classList.remove('active');
        this.closeModal();
        this.toast('Emergency mode cleared.');
      });
    }
  }

  // -------------------------------------------------------------------
  // Modal helper
  // -------------------------------------------------------------------

  private openModal(title: string, bodyHtml: string): void {
    this.closeModal();
    const modal = document.createElement('div');
    modal.className = 'hud-modal';
    modal.id = 'hud-modal';
    modal.innerHTML = `
      <div class="hud-modal-content">
        <button class="hud-modal-close" id="modal-close" aria-label="Close">×</button>
        <h3>${escapeHtml(title)}</h3>
        <div>${bodyHtml}</div>
      </div>
    `;
    this.root.querySelector('#vision-root')?.appendChild(modal);
    modal.querySelector('#modal-close')?.addEventListener('click', () => this.closeModal());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal();
    });
  }

  private closeModal(): void {
    const m = this.root.querySelector('#hud-modal');
    if (m) m.remove();
  }

  // -------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------

  private startClock(): void {
    const update = () => {
      if (this.destroyed) return;
      const tc = this.root.querySelector('#hud-tc');
      if (!tc) return;
      const elapsed = formatDuration(Date.now() - this.startTime);
      tc.innerHTML = renderMissionClock(ASTRONAUT.missionName, this.utc(), elapsed, false);
    };
    update();
    this.clockHandle = window.setInterval(update, 1000);
  }

  private startTelemetryLoop(): void {
    this.tickHandle = window.setInterval(() => {
      if (this.destroyed) return;
      this.telemetry.tick();
      this.scan = analyzeVitals(this.telemetry.get());
      this.updatePanels();
    }, 3000);
  }

  private updatePanels(): void {
    const v = this.telemetry.get();
    const tl = this.root.querySelector('#hud-tl');
    const tr = this.root.querySelector('#hud-tr');
    const ai = this.root.querySelector('#hud-ai');
    const body = this.root.querySelector('#hud-body');
    if (tl) tl.innerHTML = renderTelemetryLeft(v);
    if (tr) tr.innerHTML = renderTelemetryRight(v);
    if (ai) ai.innerHTML = renderAlerts(this.scan);
    if (body) body.innerHTML = renderBodySystems(this.scan);
    this.waveformCtx = null;
    appState.setAlertCount(this.scan.alerts.length);
  }

  private startWaveform(): void {
    const draw = () => {
      if (this.destroyed) return;
      const canvas = this.root.querySelector('#hr-wave') as HTMLCanvasElement | null;
      if (canvas) {
        if (!this.waveformCtx || this.waveformCtx.canvas !== canvas) {
          this.waveformCtx = canvas.getContext('2d');
        }
        const ctx = this.waveformCtx;
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          ctx.strokeStyle = '#34e7ff';
          ctx.lineWidth = 1.4;
          ctx.shadowBlur = 8;
          ctx.shadowColor = 'rgba(52,231,255,0.8)';
          ctx.beginPath();
          const hr = this.telemetry.get().heartRate;
          const period = Math.max(28, 9000 / hr);
          for (let x = 0; x < w; x++) {
            const t = (x + this.waveformPhase) / period;
            const phase = t - Math.floor(t);
            let y: number;
            if (phase < 0.1) y = h / 2;
            else if (phase < 0.15) y = h / 2 - (h * 0.5) * ((phase - 0.1) / 0.05);
            else if (phase < 0.25) y = h / 2 + (h * 0.35) * ((phase - 0.15) / 0.1);
            else if (phase < 0.35) y = h / 2 - (h * 0.15) * ((phase - 0.25) / 0.1);
            else y = h / 2;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      this.waveformPhase = (this.waveformPhase + 2) % 10000;
      this.rafHandle = requestAnimationFrame(draw);
    };
    this.rafHandle = requestAnimationFrame(draw);
  }

  // -------------------------------------------------------------------
  // Utils
  // -------------------------------------------------------------------

  private utc(): string {
    const d = new Date();
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(
      2,
      '0'
    )}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  }

  private toast(msg: string): void {
    const container = this.root.querySelector('#toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}
