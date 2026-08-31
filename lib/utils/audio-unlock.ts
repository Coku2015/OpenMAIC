/**
 * iOS/WebKit media unlock for programmatic playback.
 *
 * WebKit (Safari, and every iOS browser — they are all WebKit) only allows
 * media playback that starts inside a user gesture. The playback engine
 * resolves audio bytes asynchronously before calling play(), so on touch
 * devices the play() lands outside the gesture and iOS silently rejects it:
 * the timeline advances with no sound. Desktop browsers use stickier
 * activation rules, which is why this only shows up on iPads and phones.
 *
 * Priming one silent element inside the first user gesture marks the page as
 * media-enabled; after that, programmatic play() of freshly created elements
 * is allowed for the lifetime of the document.
 */

let unlocked = false;

/** A valid 0.1 s silent PCM WAV, generated here rather than shipped as a magic string. */
function silentWavDataUri(): string {
  const sampleRate = 8000;
  const sampleCount = 800; // 0.1 s of silence
  const dataSize = sampleCount * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  // Samples stay zero: the priming clip is inaudible at any volume.
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Test hook: lets tests reset the module-level unlock state. */
export function resetAudioUnlockForTests(): void {
  unlocked = false;
}

/** Whether the page has already been media-unlocked by a gesture. */
export function isAudioUnlocked(): boolean {
  return unlocked;
}

/**
 * Install one-shot gesture listeners that prime media playback. Call once per
 * page (idempotent): the first tap anywhere — typically the play button —
 * runs a silent play() inside the gesture and the listeners remove themselves.
 * A rejected play (unsupported context) keeps the listeners so the next
 * gesture retries.
 */
export function primeAudioOnFirstGesture(): void {
  if (unlocked || typeof document === 'undefined') return;

  const handler = () => {
    try {
      const primed = new Audio();
      primed.volume = 1; // the clip itself is silence
      primed.src = silentWavDataUri();
      const attempt = primed.play();
      Promise.resolve(attempt)
        .then(() => {
          unlocked = true;
          cleanup();
        })
        .catch(() => {
          /* stay locked; the next gesture retries */
        });
    } catch {
      /* the next gesture retries */
    }
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', handler, true);
    document.removeEventListener('touchend', handler, true);
    document.removeEventListener('click', handler, true);
  };
  document.addEventListener('pointerdown', handler, { capture: true });
  document.addEventListener('touchend', handler, { capture: true });
  document.addEventListener('click', handler, { capture: true });
}
