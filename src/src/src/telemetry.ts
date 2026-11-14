/**
 * =====================================================================
 * ASTRA — Telemetry Engine
 * =====================================================================
 * Generates realistic, bounded, smoothly-varying simulated vitals
 * for a nominal astronaut. Uses a random-walk model so values drift
 * organically without spiking unrealistically.
 *
 * ⚠️ ALL VALUES ARE SIMULATED DEMO DATA.
 *    A browser camera cannot measure SpO2, blood pressure, radiation,
 *    bone density or immune function. These are placeholders for
 *    future hardware integration (pulse oximeter, dosimeter, etc.).
 * =====================================================================
 */

import type { Vitals } from './types';
import { clamp, randomBetween, roundTo } from './utils';

// ---------------------------------------------------------------------
// Nominal astronaut baseline (simulated demo data)
// ---------------------------------------------------------------------
export const NOMINAL_BASELINE: Vitals = {
  heartRate: 68,
  spo2: 98,
  respiratoryRate: 15,
  bodyTemp: 36.7,
  suitPressure: 29.6,
  cabinTemp: 22.5,
  oxygen: 20.9,
  co2: 0.04,
  radiation: 0.35,
};

// Bounds for each metric (min, max) — prevents runaway drift
const BOUNDS: Record<keyof Vitals, [number, number]> = {
  heartRate: [48, 140],
  spo2: [88, 100],
  respiratoryRate: [8, 34],
  bodyTemp: [35.5, 39.8],
  suitPressure: [27.0, 32.0],
  cabinTemp: [18.0, 32.0],
  oxygen: [17.5, 21.5],
  co2: [0.01, 1.2],
  radiation: [0.05, 6.0],
};

// Step size per tick — controls drift speed
const STEP: Record<keyof Vitals, number> = {
  heartRate: 2.4,
  spo2: 0.35,
  respiratoryRate: 0.7,
  bodyTemp: 0.12,
  suitPressure: 0.15,
  cabinTemp: 0.25,
  oxygen: 0.12,
  co2: 0.008,
  radiation: 0.03,
};

// ---------------------------------------------------------------------
// TelemetryGenerator — random-walk vitals
// ---------------------------------------------------------------------
export class TelemetryGenerator {
  private current: Vitals;

  constructor(baseline: Vitals = NOMINAL_BASELINE) {
    this.current = { ...baseline };
  }

  /**
   * Advance one tick and return the updated vitals.
   */
  tick(): Vitals {
    const c = this.current;
    const next: Vitals = { ...c };

    (Object.keys(c) as Array<keyof Vitals>).forEach((key) => {
      const [lo, hi] = BOUNDS[key];
      const delta = randomBetween(-STEP[key], STEP[key]);
      // Mean-reversion: gently pull back toward baseline
      const baseline = NOMINAL_BASELINE[key];
      const reversion = (baseline - c[key]) * 0.02;
      next[key] = clamp(c[key] + delta + reversion, lo, hi);
    });

    this.current = next;
    return this.get();
  }

  /**
   * Get a snapshot copy of the current vitals.
   */
  get(): Vitals {
    return { ...this.current };
  }

  /**
   * Reset to a baseline (default: nominal).
   */
  reset(baseline: Vitals = NOMINAL_BASELINE): void {
    this.current = { ...baseline };
  }

  /**
   * Force a specific reading (used by tests / simulator).
   */
  set(key: keyof Vitals, value: number): void {
    const [lo, hi] = BOUNDS[key];
    this.current[key] = clamp(value, lo, hi);
  }
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

/**
 * Format each vital for display.
 */
export function formatVitals(v: Vitals): Record<string, string> {
  return {
    heartRate: `${roundTo(v.heartRate, 0)} bpm`,
    spo2: `${roundTo(v.spo2, 1)} %`,
    respiratoryRate: `${roundTo(v.respiratoryRate, 0)} /min`,
    bodyTemp: `${roundTo(v.bodyTemp, 1)} °C`,
    suitPressure: `${roundTo(v.suitPressure, 1)} kPa`,
    cabinTemp: `${roundTo(v.cabinTemp, 1)} °C`,
    oxygen: `${roundTo(v.oxygen, 1)} %`,
    co2: `${roundTo(v.co2 * 100, 2)} %`,
    radiation: `${roundTo(v.radiation, 2)} µSv/h`,
  };
}

/**
 * Format a single metric without units (for compact displays).
 */
export function formatMetric(key: keyof Vitals, value: number): string {
  switch (key) {
    case 'heartRate':
    case 'respiratoryRate':
      return `${roundTo(value, 0)}`;
    case 'co2':
      return `${roundTo(value * 100, 2)}`;
    case 'radiation':
      return `${roundTo(value, 2)}`;
    default:
      return `${roundTo(value, 1)}`;
  }
}

// ---------------------------------------------------------------------
// Classification — compare current reading vs baseline
// ---------------------------------------------------------------------
export type MetricStatus = 'nominal' | 'elevated' | 'warning' | 'critical';

export function classifyMetric(
  key: keyof Vitals,
  value: number,
  baseline: Vitals = NOMINAL_BASELINE
): MetricStatus {
  const b = baseline[key];
  const deviation = Math.abs(value - b);
  const rel = b !== 0 ? deviation / Math.abs(b) : 0;

  // Per-metric relative thresholds [elevated, warning, critical]
  const thresholds: Record<keyof Vitals, [number, number, number]> = {
    heartRate: [0.15, 0.3, 0.5],
    spo2: [0.02, 0.04, 0.06],
    respiratoryRate: [0.15, 0.3, 0.5],
    bodyTemp: [0.02, 0.04, 0.06],
    suitPressure: [0.02, 0.04, 0.06],
    cabinTemp: [0.1, 0.2, 0.3],
    oxygen: [0.03, 0.06, 0.1],
    co2: [0.5, 1.0, 2.0],
    radiation: [1.0, 2.0, 4.0],
  };

  const [t1, t2, t3] = thresholds[key];
  if (rel < t1) return 'nominal';
  if (rel < t2) return 'elevated';
  if (rel < t3) return 'warning';
  return 'critical';
}

// ---------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------

/**
 * Estimate "stress index" from heart rate + respiratory rate + SpO2.
 * Returns 0–100 (higher = more stressed). Simulated demo data.
 */
export function computeStressIndex(v: Vitals): number {
  const hrScore = clamp(((v.heartRate - 60) / 40) * 100, 0, 100);
  const rrScore = clamp(((v.respiratoryRate - 12) / 12) * 100, 0, 100);
  const spo2Score = clamp(((100 - v.spo2) / 8) * 100, 0, 100);
  return Math.round((hrScore * 0.5 + rrScore * 0.3 + spo2Score * 0.2));
}

/**
 * Estimate "fatigue index" from HR, SpO2, and body temp deviation.
 * Returns 0–100 (higher = more fatigued). Simulated demo data.
 */
export function computeFatigueIndex(v: Vitals): number {
  const hrScore = clamp(((v.heartRate - 70) / 30) * 100, 0, 100);
  const spo2Score = clamp(((99 - v.spo2) / 6) * 100, 0, 100);
  const tempScore = clamp((Math.abs(v.bodyTemp - 36.7) / 1.5) * 100, 0, 100);
  return Math.round((hrScore * 0.4 + spo2Score * 0.4 + tempScore * 0.2));
}

/**
 * Estimate "recovery score" — inverse of stress+fatigue.
 */
export function computeRecoveryScore(v: Vitals): number {
  const stress = computeStressIndex(v);
  const fatigue = computeFatigueIndex(v);
  return Math.max(0, 100 - Math.round((stress + fatigue) / 2));
}

/**
 * Compute an overall health score (0–100).
 */
export function computeOverallScore(v: Vitals): number {
  const keys = Object.keys(NOMINAL_BASELINE) as Array<keyof Vitals>;
  const scores = keys.map((k) => {
    const status = classifyMetric(k, v[k]);
    return { nominal: 100, elevated: 75, warning: 50, critical: 25 }[status];
  });
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}
