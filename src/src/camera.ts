/**
 * =====================================================================
 * ASTRA — Camera Module
 * =====================================================================
 * Wraps the native WebRTC MediaDevices API with:
 *   • Secure context detection
 *   • Facing mode (front/rear) switching
 *   • Descriptive error mapping (permission denied, no camera, etc.)
 *   • Guaranteed track cleanup (no memory leaks, no stuck LED)
 *   • Video element attachment with autoplay fallback
 *
 * All camera frames are processed locally — nothing is uploaded.
 * =====================================================================
 */

import type { CameraFacing, CameraStatus } from './types';

// ---------------------------------------------------------------------
// Module-level stream state (single camera at a time)
// ---------------------------------------------------------------------
let currentStream: MediaStream | null = null;
let currentFacing: CameraFacing = 'environment';

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Check if the browser supports the camera API.
 */
export function isCameraSupported(): boolean {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

/**
 * Check if we're in a secure context (required for camera access).
 * HTTPS or localhost/127.0.0.1 both count.
 */
export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return (
    window.isSecureContext === true ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '[::1]'
  );
}

/**
 * Request camera access with the given facing mode.
 * Stops any existing stream first.
 *
 * @throws Error with a machine-readable message:
 *   CAMERA_UNSUPPORTED | PERMISSION_DENIED | NO_CAMERA | CAMERA_BUSY | CAMERA_ERROR:<name>
 */
export async function requestCamera(facing: CameraFacing): Promise<MediaStream> {
  if (!isCameraSupported()) {
    throw new Error('CAMERA_UNSUPPORTED');
  }

  // Stop any existing tracks before requesting a new stream
  stopAllTracks();

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920, min: 640 },
      height: { ideal: 1080, min: 480 },
      frameRate: { ideal: 30, max: 60 },
    },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(normalizeCameraError(err));
  }

  currentStream = stream;
  currentFacing = facing;

  // Listen for the user revoking permission mid-session
  stream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (currentStream === stream) {
        currentStream = null;
      }
    });
  });

  return stream;
}

/**
 * Stop all active camera tracks. Safe to call multiple times.
 */
export function stopAllTracks(): void {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
    currentStream = null;
  }
}

/**
 * Get the current active stream, if any.
 */
export function getStream(): MediaStream | null {
  return currentStream;
}

/**
 * Get the current facing mode.
 */
export function getFacing(): CameraFacing {
  return currentFacing;
}

/**
 * Attach a stream to a <video> element and start playback.
 * Handles the autoplay-blocked case by retrying on user interaction.
 */
export async function attachStreamToVideo(
  video: HTMLVideoElement,
  stream: MediaStream
): Promise<void> {
  // iOS Safari requires these attributes set before/around srcObject
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;

  try {
    await video.play();
  } catch {
    // Autoplay may be blocked. The ENTER button click counts as a user
    // gesture, so this should rarely happen, but we add a fallback.
    const resume = () => {
      video.play().catch(() => {
        /* still blocked — user can tap camera button */
      });
    };
    document.addEventListener('click', resume, { once: true, passive: true });
    document.addEventListener('touchstart', resume, { once: true, passive: true });
  }
}

/**
 * Map a raw getUserMedia error to a machine-readable code.
 */
function normalizeCameraError(err: unknown): string {
  const e = err as DOMException;
  const name = e?.name ?? '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'PERMISSION_DENIED';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'NO_CAMERA';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'CAMERA_BUSY';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    // Fall back to a generic video request without facing constraint
    return 'CAMERA_CONSTRAINT';
  }
  if (name === 'TypeError') {
    return 'CAMERA_UNSUPPORTED';
  }
  return `CAMERA_ERROR:${name || 'UNKNOWN'}`;
}

/**
 * Map an error to a CameraStatus for state management.
 */
export function mapErrorToStatus(err: unknown): CameraStatus {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('PERMISSION_DENIED')) return 'denied';
  if (msg.includes('NO_CAMERA') || msg.includes('CAMERA_UNSUPPORTED')) return 'unavailable';
  if (msg.includes('CAMERA_BUSY')) return 'error';
  return 'error';
}

/**
 * Human-readable description of a camera error.
 */
export function describeCameraError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg === 'PERMISSION_DENIED') {
    return 'Camera permission was denied. Please allow camera access in your browser settings and try again.';
  }
  if (msg === 'NO_CAMERA') {
    return 'No camera was found on this device. ASTRA will run in demo mode.';
  }
  if (msg === 'CAMERA_BUSY') {
    return 'The camera is currently in use by another application. Please close it and try again.';
  }
  if (msg === 'CAMERA_UNSUPPORTED') {
    return 'Your browser does not support camera access. Please use a modern browser (Chrome, Edge, or Safari) over HTTPS.';
  }
  if (msg === 'CAMERA_CONSTRAINT') {
    return 'Your camera does not support the requested facing mode. Try switching cameras.';
  }
  return `Camera error: ${msg}`;
}

/**
 * Enumerate available video devices (requires permission first on most browsers).
 */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}
