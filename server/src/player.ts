import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as play from 'play-dl';
import type { SoundCloudTrack } from 'play-dl';
import ytdl, { Cookie as YtdlCookie } from '@distube/ytdl-core';
import youtubedl from 'youtube-dl-exec';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { YOUTUBE_DL_PATH } = require('youtube-dl-exec/src/constants') as { YOUTUBE_DL_PATH: string };
import { Response } from 'express';
import { config } from './config';
import { Track, TrackQueue } from './queue';

// Prefer a system ffmpeg if provided (more stable on some hosts); fall back to bundled binary
ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || ffmpegInstaller.path);

let loggedYtDlpDisabled = false;

const parseYoutubeCookies = (): YtdlCookie[] | undefined => {
  if (!config.youtubeCookie) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(config.youtubeCookie);
    return Array.isArray(parsed) ? (parsed as unknown as YtdlCookie[]) : undefined;
  } catch {
    return undefined;
  }
};

const youtubeCookies = parseYoutubeCookies();
const ytdlAgent = youtubeCookies ? ytdl.createAgent(youtubeCookies) : undefined;
let ytDlpCookiePath: string | undefined;

const buildYtDlpCookieFile = (): string | undefined => {
  if (ytDlpCookiePath !== undefined) {
    return ytDlpCookiePath;
  }

  if (!youtubeCookies || youtubeCookies.length === 0) {
    return undefined;
  }

  try {
    const lines = ['# Netscape HTTP Cookie File'];
    for (const cookie of youtubeCookies) {
      const domain = (cookie as { domain?: string }).domain ?? '.youtube.com';
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const pathValue = (cookie as { path?: string }).path ?? '/';
      const secure = (cookie as { secure?: boolean }).secure ? 'TRUE' : 'FALSE';
      const expires = Math.trunc((cookie as { expirationDate?: number }).expirationDate ?? 0);
      const name = (cookie as { name?: string; key?: string }).name ?? (cookie as { name?: string; key?: string }).key;
      const value = (cookie as { value?: string }).value ?? '';
      if (!name) {
        continue;
      }

      lines.push([domain, includeSubdomains, pathValue, secure, expires, name, value].join('\t'));
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'ytcookie-'));
    const filePath = path.join(dir, 'cookies.txt');
    writeFileSync(filePath, lines.join('\n'), 'utf8');
    ytDlpCookiePath = filePath;
    return filePath;
  } catch (error) {
    console.warn('[yt] Failed to write yt-dlp cookie file:', error);
    ytDlpCookiePath = undefined;
    return undefined;
  }
};

export interface StreamState {
  current: Track | null;
  queue: Track[];
  listeners: number;
  paused: boolean;
}

type AudioInput = Readable | { url: string; headers?: Record<string, string> };

export class StreamService {
  private readonly broadcast = new PassThrough();
  private readonly taps = new Set<PassThrough>();
  private playing = false;
  private starting = false;
  private paused = false;
  private pausedAt: number | null = null;
  private totalPausedDuration = 0;
  private stopCurrent: (() => void) | null = null;
  private currentFfmpegPid: number | null = null;
  private skipping = false;
  private currentTrack: Track | null = null;
  private lastPlayedTrack: Track | null = null;
  private currentYoutubeThumbnail: string | null = null;
  private currentSoundcloudThumbnail: string | null = null;
  private silenceInterval: NodeJS.Timeout | null = null;

  // MP3 silence frame (very short silent MP3 frame)
  private static readonly SILENCE_FRAME = Buffer.from(
    'fffbe4000000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  );

  // Larger silence buffer for flushing client audio buffers on pause (~1 second of silence at 128kbps)
  private static readonly SILENCE_FLUSH = Buffer.concat(
    Array(100).fill(StreamService.SILENCE_FRAME)
  );

  constructor(private readonly queue: TrackQueue) {
    this.broadcast.setMaxListeners(0);
    // Start broadcasting silence to keep clients alive
    this.startSilenceBroadcast();
  }

  private startSilenceBroadcast(): void {
    // Send silence frames every 50ms when not playing to keep connections alive
    this.silenceInterval = setInterval(() => {
      if (!this.playing && this.taps.size > 0) {
        this.broadcastChunk(StreamService.SILENCE_FRAME);
      }
    }, 50);
  }

  private sendSilence(): void {
    // Immediately send silence frames to fill gaps during transitions
    if (this.taps.size > 0) {
      this.broadcastChunk(StreamService.SILENCE_FRAME);
    }
  }

  private flushWithSilence(): void {
    // Send a large chunk of silence to flush client audio buffers
    for (const tap of this.taps) {
      if (!tap.destroyed) {
        tap.write(StreamService.SILENCE_FLUSH);
      }
    }
  }

  private broadcastChunk(chunk: Buffer): void {
    // When paused, send silence instead of actual audio
    const dataToSend = this.paused ? StreamService.SILENCE_FRAME : chunk;
    for (const tap of this.taps) {
      if (!tap.destroyed) {
        tap.write(dataToSend);
      }
    }
  }

  attachClient(res: Response): void {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.status(200);

    const tap = new PassThrough();
    tap.pipe(res);
    this.taps.add(tap);

    // Send initial silence frame to kickstart the connection
    tap.write(StreamService.SILENCE_FRAME);

    res.on('close', () => {
      tap.destroy();
      this.taps.delete(tap);
    });
  }

  getState(): StreamState {
    const track = this.currentTrack ?? this.lastPlayedTrack;
    let adjustedTrack = track;
    
    if (track?.startedAt) {
      // Calculate current pause duration if currently paused
      // While paused, freeze timeline: do not add the in-progress pause duration here.
      const currentPauseDuration = this.paused ? 0 : 0;
      // Adjust startedAt to account for total time spent paused (committed pauses only)
      const adjustedStartedAt = track.startedAt + this.totalPausedDuration + currentPauseDuration;
      adjustedTrack = { ...track, startedAt: adjustedStartedAt };
    }
    
    return {
      current: adjustedTrack,
      queue: this.queue.snapshot(),
      listeners: this.taps.size,
      paused: this.paused
    };
  }

  getCurrentThumbnail(source: 'youtube' | 'soundcloud'): string | null {
    return source === 'youtube' ? this.currentYoutubeThumbnail : this.currentSoundcloudThumbnail;
  }

  setPaused(paused: boolean): void {
    if (paused && !this.paused) {
      // Starting pause - record when we paused
      this.pausedAt = Date.now();
      // Set paused flag FIRST so broadcastChunk starts sending silence
      this.paused = true;
      // Pause the ffmpeg process to stop encoding
      if (this.currentFfmpegPid) {
        try {
          process.kill(this.currentFfmpegPid, 'SIGSTOP');
          console.log(`[playback] Stream paused (ffmpeg PID ${this.currentFfmpegPid} stopped)`);
        } catch (error) {
          console.warn(`[playback] Could not pause ffmpeg process:`, error);
        }
      } else {
        console.log(`[playback] Stream paused`);
      }
      // Then flush client buffers with a large chunk of silence
      this.flushWithSilence();
    } else if (!paused && this.paused && this.pausedAt) {
      // Resuming - add the pause duration to total
      this.totalPausedDuration += Date.now() - this.pausedAt;
      this.pausedAt = null;
      this.paused = false;
      // Resume the ffmpeg process
      if (this.currentFfmpegPid) {
        try {
          process.kill(this.currentFfmpegPid, 'SIGCONT');
          console.log(`[playback] Stream resumed (ffmpeg PID ${this.currentFfmpegPid} continued)`);
        } catch (error) {
          console.warn(`[playback] Could not resume ffmpeg process:`, error);
        }
      } else {
        console.log(`[playback] Stream resumed`);
      }
    } else {
      this.paused = paused;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  async ensurePlaying(): Promise<void> {
    // Verhindere parallele Starts, wenn mehrere Requests kurz hintereinander
    // `ensurePlaying` aufrufen, bevor der erste Track wirklich laeuft.
    if (this.playing || this.starting) {
      return;
    }

    this.starting = true;
    try {
      await this.playNext();
    } finally {
      this.starting = false;
    }
  }

  skipCurrent(): void {
    // Prevent error handlers from also calling playNext
    this.skipping = true;
    // Stop the current ffmpeg pipeline if present and move to next track
    if (this.stopCurrent) {
      this.stopCurrent();
      this.stopCurrent = null;
    }
    this.currentFfmpegPid = null;
    this.playing = false;
    this.currentTrack = null;
    // Use setTimeout to let error handlers fire first, then start next
    setTimeout(() => {
      this.skipping = false;
      void this.playNext();
    }, 150);
  }

  private async playNext(): Promise<void> {
    // Prevent multiple simultaneous track starts - only check playing, not starting
    // (starting is managed by ensurePlaying for API calls)
    if (this.playing) {
      console.log('[playback] Already playing, skipping playNext call');
      return;
    }

    const next = this.queue.dequeue();
    if (!next) {
      console.log('[playback] Queue empty, waiting');
      this.currentTrack = null;
      // Clear lastPlayedTrack when queue is empty so UI shows "waiting"
      this.lastPlayedTrack = null;
      this.currentYoutubeThumbnail = null;
      this.currentSoundcloudThumbnail = null;
      this.playing = false;
      return;
    }

    // Neuer Track startet - lastPlayedTrack wird erst beim Start ueberschrieben
    try {
      console.log(`[playback] Starting: ${next.title} (${next.source})`);
      await this.playTrack(next);
    } catch (error) {
      console.error(`[playback] Failed to play track: ${next.title}`, error);
      this.currentTrack = null;
      this.lastPlayedTrack = null;
      this.playing = false;
      setTimeout(() => void this.playNext(), 1000);
    }
  }

  private async playTrack(track: Track): Promise<void> {
    if (!track.url) {
      throw new Error('Track URL missing');
    }

    const input = await this.createAudioStream(track);

    // Reset pause tracking for new track
    this.pausedAt = null;
    this.totalPausedDuration = 0;

    // Set track without startedAt - will be set when audio actually starts
    const playingTrack: Track = { ...track };
    this.currentTrack = playingTrack;
    this.lastPlayedTrack = playingTrack;
    this.playing = true;

    // Update thumbnail for the current source
    if (track.source === 'youtube') {
      this.currentYoutubeThumbnail = track.thumbnail ?? null;
      this.currentSoundcloudThumbnail = null;
    } else if (track.source === 'soundcloud') {
      this.currentSoundcloudThumbnail = track.thumbnail ?? null;
      this.currentYoutubeThumbnail = null;
    }

    console.log(`[ffmpeg] Setting up encoder for: ${track.title}`);

    const command = this.buildFfmpegCommand(input)
      .inputOptions(['-re']) // Read input at native frame rate (realtime)
      .format('mp3')
      .audioBitrate(128)
      .outputOptions(['-threads 1'])
      .on('start', (commandLine: string) => {
        // Extract PID from the spawned ffmpeg process using any cast to access internal property
        const cmdAny = command as any;
        if (cmdAny.ffmpegProc && cmdAny.ffmpegProc.pid) {
          this.currentFfmpegPid = cmdAny.ffmpegProc.pid;
          console.log(`[ffmpeg] Process started with PID: ${this.currentFfmpegPid}`);
        }
      })
      .on('error', (error: Error) => {
        console.error('[ffmpeg] Encoder error:', error);
        if (this.isReadable(input)) {
          input.destroy(error);
        }
        this.playing = false;
        this.stopCurrent = null;
        this.currentFfmpegPid = null;
        // Don't call playNext if we're intentionally skipping
        if (!this.skipping) {
          setTimeout(() => void this.playNext(), 100);
        }
      })
      .on('end', () => {
        console.log('[ffmpeg] Encoding finished for:', track.title);
        if (this.isReadable(input)) {
          input.destroy();
        }
        this.playing = false;
        this.stopCurrent = null;
        this.currentFfmpegPid = null;
        // Send silence immediately to fill gap during transition
        this.sendSilence();
        // Don't call playNext if we're intentionally skipping
        if (!this.skipping) {
          setTimeout(() => void this.playNext(), 100);
        }
      });

    const output = command.pipe();

    // Expose a stopper to skip current track
    this.stopCurrent = () => {
      try {
        command.kill('SIGKILL');
      } catch {
        // ignore
      }
      if (this.isReadable(input)) {
        input.destroy();
      }
      output.destroy();
    };
    
    output.on('error', (error: Error) => {
      console.error('[ffmpeg-output] Stream error:', error);
      this.playing = false;
      this.stopCurrent = null;
      // Don't call playNext if we're intentionally skipping
      if (!this.skipping) {
        setTimeout(() => void this.playNext(), 100);
      }
    });

    let hasStarted = false;
    output.on('data', (chunk: Buffer) => {
      if (!hasStarted) {
        console.log(`[stream] Broadcasting started (${chunk.length} bytes)`);
        hasStarted = true;
        // Set startedAt when audio actually starts playing
        const now = Date.now();
        this.currentTrack = { ...playingTrack, startedAt: now };
        this.lastPlayedTrack = this.currentTrack;
      }
      this.broadcastChunk(chunk);
    });

    // Safety timeout: if no data after 30 seconds, skip to next track (slower hosts may need extra time)
    const timeoutHandle = setTimeout(() => {
      if (!hasStarted && this.currentTrack?.id === track.id) {
        console.warn('[stream] No audio data after 30s, skipping track');
        if (this.isReadable(input)) {
          input.destroy(new Error('Stream timeout'));
        }
        output.destroy();
        this.playing = false;
        // Schedule next track but don't wait
        setTimeout(() => void this.playNext(), 100);
      }
    }, 30000);

    output.once('data', () => {
      clearTimeout(timeoutHandle);
    });
  }

  private isReadable(input: AudioInput): input is Readable {
    return typeof (input as Readable).pipe === 'function';
  }

  private headersToFfmpegOption(headers: Record<string, string> | undefined): string[] {
    if (!headers || Object.keys(headers).length === 0) {
      return [];
    }
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    return ['-headers', headerLines];
  }

  private buildFfmpegCommand(input: AudioInput) {
    if (this.isReadable(input)) {
      return ffmpeg(input);
    }

    const isHls = Boolean(input.url && input.url.toLowerCase().includes('m3u8'));
    const options = [
      ...this.headersToFfmpegOption(input.headers),
      ...(isHls ? ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto'] : [])
    ];
    return options.length ? ffmpeg(input.url).inputOptions(options) : ffmpeg(input.url);
  }

  private async createAudioStream(track: Track): Promise<AudioInput> {
    if (track.source === 'soundcloud') {
      try {
        return await this.streamWithSoundCloud(track.url);
      } catch (scError) {
        console.warn('[stream] SoundCloud stream failed, trying yt-dlp as fallback', scError);
        return await this.streamWithYtDlp(track.url);
      }
    }

    // If YTDLP_FIRST is set, skip ytdl-core entirely for faster startup
    if (config.ytdlpFirst) {
      console.log('[stream] YTDLP_FIRST set; using yt-dlp directly');
      return await this.streamWithYtDlp(track.url);
    }

    // Otherwise prefer ytdl-core for streaming; fall back to yt-dlp if allowed.
    const tryYtdlFirst = async () => {
      try {
        return await this.streamWithYtdl(track.url);
      } catch (ytdlError) {
        console.warn('[stream] ytdl-core stream failed, considering yt-dlp fallback', ytdlError);
        throw ytdlError;
      }
    };

    if (config.disableYtDlp) {
      if (!loggedYtDlpDisabled) {
        console.warn('[stream] DISABLE_YTDLP set; using ytdl-core only');
        loggedYtDlpDisabled = true;
      }
      return await tryYtdlFirst();
    }

    try {
      // Attempt ytdl-core first for stability.
      return await tryYtdlFirst();
    } catch {
      // Fall back to yt-dlp if ytdl-core fails.
      try {
        console.log('[stream] Using yt-dlp for audio', {
          cookieFile: Boolean(buildYtDlpCookieFile()),
          ua: Boolean(config.youtubeUserAgent)
        });
        return await this.streamWithYtDlp(track.url);
      } catch (ytDlpError) {
        console.warn('[stream] yt-dlp fallback failed after ytdl-core error', ytDlpError);
        throw ytDlpError;
      }
    }
  }

  private async streamWithSoundCloud(url: string): Promise<Readable> {
    console.log(`[soundcloud] Resolving: ${url}`);
    const info = await play.soundcloud(url);
    if (!('durationInSec' in info)) {
      throw new Error('SoundCloud playlists are not supported');
    }

    console.log(`[soundcloud] Got track info: ${(info as {name?: string}).name}`);
    const scTrack = info as SoundCloudTrack;
    const source = await play.stream_from_info(scTrack);
    
    if (!source || !source.stream) {
      throw new Error('Failed to get SoundCloud stream from play-dl');
    }

    console.log(`[soundcloud] Got stream, piping to ffmpeg`);
    const stream = source.stream as Readable;
    
    // Ensure stream doesn't end prematurely
    stream.on('error', (error: Error) => {
      console.error('[soundcloud] Stream error:', error);
    });
    
    return stream;
  }

  private async streamWithYtdl(url: string): Promise<Readable> {
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL supplied');
    }

    return await new Promise<Readable>((resolve, reject) => {
      console.log('[ytdl] requesting audio stream');
      const readable = ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        ...(ytdlAgent ? { agent: ytdlAgent } : {}),
        requestOptions: {
          headers: {
            ...(config.youtubeUserAgent ? { 'user-agent': config.youtubeUserAgent } : {}),
            // Only send raw cookie header if we could not parse JSON cookies for the new format
            ...(!ytdlAgent && config.youtubeCookie ? { cookie: config.youtubeCookie } : {})
          }
        }
      });

      let timeoutId: NodeJS.Timeout;

      const cleanup = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        readable.off('info', handleInfo);
        readable.off('error', handleError);
      };

      const handleInfo = (): void => {
        console.log('[ytdl] stream info acquired');
        cleanup();
        resolve(readable);
      };

      const handleError = (error: Error): void => {
        console.warn('[ytdl] stream error', error);
        cleanup();
        reject(error);
      };

      // Short timeout - if ytdl-core doesn't work quickly, fall back to yt-dlp
      timeoutId = setTimeout(() => {
        cleanup();
        readable.destroy();
        reject(new Error('ytdl-core timed out acquiring stream info (5s)'));
      }, 5000);

      readable.once('info', handleInfo);
      readable.once('error', handleError);
    });
  }

  private async streamWithYtDlp(url: string): Promise<Readable> {
    const cookieFile = buildYtDlpCookieFile();

    // Pipe audio directly from yt-dlp subprocess to ensure playback starts at 0.
    // This avoids mid-track issues caused by HLS segment offsets or range params.
    console.log('[yt-dlp] spawning subprocess for direct audio pipe', {
      cookieFile: Boolean(cookieFile)
    });

    // Prefer direct audio formats over HLS/DASH to avoid sleep delays
    // ba = best audio, !hls/!dash excludes slow streaming formats
    const format = process.env.YTDLP_FORMAT || 'ba[protocol!=m3u8][protocol!=m3u8_native][protocol!=hls]/ba/bestaudio/best';
    
    const args = [
      '--no-playlist',
      '-f', format,
      '-o', '-',  // output to stdout
      '--no-part',
      '--no-continue',
      '--no-warnings',  // reduce noise
      ...(cookieFile ? ['--cookies', cookieFile] : []),
      url
    ];

    // Try system yt-dlp first, fall back to bundled binary from youtube-dl-exec
    const ytDlpBinary = process.env.YTDLP_PATH || YOUTUBE_DL_PATH || 'yt-dlp';
    console.log('[yt-dlp] using binary:', ytDlpBinary);

    const child = spawn(ytDlpBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.log('[yt-dlp stderr]', msg);
      }
    });

    child.on('error', (err) => {
      console.error('[yt-dlp] spawn error:', err);
    });

    child.on('close', (code) => {
      if (code && code !== 0) {
        console.warn('[yt-dlp] exited with code', code);
      }
    });

    // Wait for yt-dlp to start outputting data (allow extra time for HLS fragment downloads)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        child.kill('SIGTERM');
        reject(new Error('yt-dlp did not start streaming within 90s'));
      }, 90000);

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('close', onClose);
      };

      const onData = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = (code: number | null) => {
        cleanup();
        if (code !== 0) {
          reject(new Error(`yt-dlp exited with code ${code} before streaming`));
        } else {
          resolve();
        }
      };

      child.stdout.once('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
    });

    console.log('[yt-dlp] streaming started');
    return child.stdout;
  }

  private async fetchRemoteStream(
    target: string,
    headers: Record<string, string>,
    redirects = 0
  ): Promise<Readable> {
    if (redirects > 5) {
      throw new Error('Too many redirects while fetching audio stream');
    }

    return await new Promise<Readable>((resolve, reject) => {
      const request = (target.startsWith('https:') ? https : http).get(
        target,
        { headers },
        (res) => {
          const { statusCode, headers: responseHeaders } = res;

          if (statusCode && statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
            res.resume();
            const nextUrl = new URL(responseHeaders.location, target).toString();
            this.fetchRemoteStream(nextUrl, headers, redirects + 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (!statusCode || statusCode >= 400) {
            res.resume();
            reject(new Error(`Upstream responded with status ${statusCode ?? 'unknown'}`));
            return;
          }

          const contentType = (responseHeaders['content-type'] ?? '').toString().toLowerCase();
          const isAudio = contentType.startsWith('audio/');
          const isHls = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl');
          if (!isAudio && !isHls) {
            res.resume();
            reject(new Error(`Upstream returned non-audio content-type: ${contentType || 'unknown'}`));
            return;
          }

          resolve(res);
        }
      );

      request.on('error', reject);
      request.setTimeout(10000, () => {
        request.destroy(new Error('Timed out fetching audio stream'));
      });
    });
  }
}
