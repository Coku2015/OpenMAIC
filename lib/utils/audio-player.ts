/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations.
 * Resolves pre-generated TTS audio bytes pool-first through the shared read
 * path, with the Dexie `audioFiles` table as the legacy fallback.
 *
 */

import { createLogger } from '@/lib/logger';
import { primeAudioOnFirstGesture } from '@/lib/utils/audio-unlock';
import {
  isBrowserPersistenceEnabled,
  getPersistenceRequestHeaders,
} from '@/lib/persistence/bootstrap';
import { diagLog } from '@/lib/utils/playback-diagnostics';

const log = createLogger('AudioPlayer');

/** Bytes an audio id currently resolves to, pool first. Loaded lazily to keep
 * this module importable without the media graph. */
async function resolveBytes(audioId: string): Promise<Blob | null> {
  try {
    const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
    return await resolveAudioBlob(audioId);
  } catch {
    return null;
  }
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private requestToken: number = 0;
  /** The object URL backing the current audio element, if any. */
  private blobUrl: string | null = null;
  /**
   * The in-flight legacy narration fetch of the current play, if any. Aborted
   * when the play is superseded (a replacement play, stop, or destroy), so a
   * stale fetch is cancelled at the network layer instead of settling before
   * its supersession is noticed.
   */
  private fetchAbort: AbortController | null = null;

  constructor() {
    // WebKit touch devices reject play() calls that land outside the user
    // gesture — the engine's resolve-bytes-then-play flow does exactly that.
    // Priming inside the first tap (see audio-unlock.ts) lifts the restriction
    // for the rest of the page's lifetime. No-op on desktop browsers.
    primeAudioOnFirstGesture();
  }

  /** Abort the in-flight legacy narration fetch, if one exists. */
  private abortLegacyFetch(): void {
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }
  }

  /**
   * Revoke an object URL this player created, forgetting it when it is still
   * the current source. Idempotent: natural end, rejected play, stop, and
   * replacement each call it once for their own URL.
   */
  private releaseBlobUrl(blobUrl: string | null | undefined): void {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    if (this.blobUrl === blobUrl) this.blobUrl = null;
  }

  private stopAudioElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
    // Stop or replacement before natural end must not leak the fetched
    // narration: the element is dropped here, so its URL is released with it.
    this.releaseBlobUrl(this.blobUrl);
  }

  /**
   * Play audio for a speech reference.
   *
   * The reference is resolved pool-first through the shared read path, so a
   * stable-id regeneration whose mirror write failed does not keep serving
   * superseded narration; the Dexie `audioFiles` table remains the fallback
   * for legacy and imported rows that were never pool-backed.
   *
   * Conversion to allocated ids is best-effort: a document whose conversion
   * was skipped (the lock-free load path) or deferred (a transient fetch
   * failure) still holds its legacy pair, and an `audioId` with no local
   * bytes is not silence while the URL beside it may still be live. That URL
   * is the fallback of last resort, fetched at playback time; a converted
   * document never carries one.
   *
   * @param audioId Audio asset reference (allocated asset id, or a legacy TTS-derived id)
   * @param legacyUrl The legacy `audioUrl` of an unconverted pair, if present
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, legacyUrl?: string): Promise<boolean> {
    const requestToken = ++this.requestToken;
    const audioLog = (window as unknown as { __audioLog?: unknown[] }).__audioLog;
    audioLog?.push({ t: Date.now(), kind: 'resolve', audioId: audioId.slice(0, 30) });
    diagLog(`播放请求 ${audioId.slice(0, 18)}`);

    // ── 候选源按优先级依次尝试，第一个成功者生效 ──
    const sources: { label: string; src: string; revoke?: () => void }[] = [];

    // 1) 服务器现取字节 → 全新内存 Blob：与设置页试听完全同款形态，
    //    iPad Chrome 实测可播。IndexedDB 读回的 Blob 在 iOS WebKit 上会
    //    NotSupportedError，直连 URL 的 octet-stream 类型同样被拒——
    //    所以这两者都不作为首选。
    if (isBrowserPersistenceEnabled()) {
      try {
        const authHeaders = await getPersistenceRequestHeaders();
        const response = await fetch(`/api/persistence/assets/${audioId}/content`, {
          headers: authHeaders,
        });
        if (requestToken !== this.requestToken) return false;
        if (response.ok) {
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 0) {
            const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
            sources.push({
              label: `服务器音频(${bytes.byteLength}B)`,
              src: url,
              revoke: () => URL.revokeObjectURL(url),
            });
          }
        }
        diagLog(`服务器音频: HTTP ${response.status}, ${sources.length ? '已获取' : '无'}`);
        audioLog?.push({ t: Date.now(), kind: 'server-fetch', status: response.status });
      } catch (fetchErr) {
        diagLog(`服务器取回异常: ${String(fetchErr).slice(0, 40)}`);
      }
    }

    // 2) 本地 Dexie 镜像（生成设备/离线兜底）。读回的 Blob 统一重打标准类型。
    const local = await resolveBytes(audioId);
    if (requestToken !== this.requestToken) return false;
    if (local) {
      const normalized = local.type === 'audio/mpeg' ? local : new Blob([local], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(normalized);
      sources.push({ label: `本地镜像(${normalized.size}B)`, src: url, revoke: () => URL.revokeObjectURL(url) });
      diagLog(`本地镜像: ${normalized.size}B`);
    }

    // 3) 旧版 audioUrl 兜底（未迁移的历史课件）
    if (!sources.length && legacyUrl) {
      sources.push({ label: '旧版链接', src: legacyUrl });
    }

    if (!sources.length) {
      // 没有任何候选源：交由浏览器原生 TTS（如启用）或静默阅读计时
      diagLog('无候选音频源');
      return false;
    }

    for (const source of sources) {
      this.stopAudioElement();
      if (requestToken !== this.requestToken) return false;

      this.audio = new Audio(source.src);
      this.audio.volume = this.muted ? 0 : this.volume;
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;
      this.audio.addEventListener('ended', () => {
        source.revoke?.();
        this.onEndedCallback?.();
      });

      try {
        await this.audio.play();
      } catch (playError) {
        source.revoke?.();
        const name = (playError as { name?: string })?.name ?? 'unknown';
        diagLog(`播放被拒(${source.label}): ${name}`);
        log.error('Failed to play audio:', playError);
        continue; // 尝试下一个候选源
      }
      if (requestToken !== this.requestToken) {
        source.revoke?.();
        return false;
      }
      // 部分浏览器在加载过程中会重置播放速率
      this.audio.playbackRate = this.playbackRate;
      diagLog(`播放成功(${source.label})`);
      audioLog?.push({ t: Date.now(), kind: 'play-ok', source: source.label });
      return true;
    }

    diagLog('全部候选源播放失败');
    audioLog?.push({ t: Date.now(), kind: 'all-sources-failed' });
    return false;
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.requestToken += 1;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.requestToken += 1;
    this.stopAudioElement();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
