import express, { Request, Response, NextFunction } from 'express';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import session from 'express-session';
import cors from 'cors';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import { Profile } from 'passport';
import * as play from 'play-dl';
import youtubedl from 'youtube-dl-exec';
import ytdl, { Cookie as YtdlCookie } from '@distube/ytdl-core';
import sharp from 'sharp';
import { config } from './config';
import { StreamService } from './player';
import { TrackQueue, Track } from './queue';

const app = express();
const queue = new TrackQueue();
const stream = new StreamService(queue);

let loggedYtDlpUnavailable = false;

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

const ytdlOptions = {
  ...(ytdlAgent ? { agent: ytdlAgent } : {}),
  requestOptions: {
    headers: {
      ...(config.youtubeUserAgent ? { 'user-agent': config.youtubeUserAgent } : {}),
      // Only send raw cookie header if we could not parse JSON cookies for the new format
      ...(!ytdlAgent && config.youtubeCookie ? { cookie: config.youtubeCookie } : {})
    }
  }
};

const fetchYoutubeMetadata = async (url: string): Promise<{ title?: string; duration?: number; thumbnail?: string }> => {
  // Try yt-dlp first (better metadata), then fall back to ytdl-core if Python is too old or yt-dlp is unavailable
  if (config.disableYtDlp) {
    if (!loggedYtDlpUnavailable) {
      console.warn('[yt] yt-dlp disabled via DISABLE_YTDLP, using ytdl-core only');
      loggedYtDlpUnavailable = true;
    }
    return await fetchYoutubeMetadataViaYtdl(url);
  }

  try {
    const cookieFile = buildYtDlpCookieFile();
    console.log('[yt] metadata via yt-dlp', {
      cookieFile: Boolean(cookieFile),
      ua: Boolean(config.youtubeUserAgent)
    });
    const raw = await youtubedl(url, {
      f: config.ytdlpFormat,
      'dump-single-json': true,
      'no-warnings': true,
      'no-playlist': true,
      'skip-download': true,
      simulate: true,
      ...(cookieFile ? { cookies: cookieFile } : {})
    });

    let payload: unknown;
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (parseError) {
      throw new Error('yt-dlp returned malformed metadata');
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error('yt-dlp returned unexpected payload');
    }

    const data = payload as { title?: string; duration?: number; thumbnail?: string; thumbnails?: Array<{ url?: string }> };
    const thumb = data.thumbnail ?? data.thumbnails?.[0]?.url;
    return { title: data.title, duration: data.duration, thumbnail: thumb };
  } catch (ytDlpError) {
    const message = ytDlpError instanceof Error ? ytDlpError.message : String(ytDlpError);
    if (message.includes('unsupported version of Python')) {
      console.warn('[yt] yt-dlp requires Python >=3.10, skipping to ytdl-core');
      loggedYtDlpUnavailable = true;
    } else {
      console.warn('[yt] yt-dlp metadata failed, falling back to ytdl-core:', ytDlpError);
    }
  }

  return await fetchYoutubeMetadataViaYtdl(url);
};

const fetchYoutubeMetadataViaYtdl = async (url: string) => {
  console.log('[yt] metadata via ytdl-core');
  const info = await ytdl.getBasicInfo(url, ytdlOptions);
  const details = info.videoDetails;
  const thumb = details.thumbnails?.[0]?.url;
  const duration = details.lengthSeconds ? Number(details.lengthSeconds) : undefined;
  return { title: details.title, duration: duration ?? undefined, thumbnail: thumb };
};

const normalizeYoutubeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isYoutube = host.includes('youtube.com') || host.includes('youtu.be') || host.includes('music.youtube.com');
    if (!isYoutube) {
      return url;
    }

    // Strip timestamps so tracks always start at 0
    const timeParams = ['t', 'start', 'time_continue', 'timestamp'];
    for (const param of timeParams) {
      parsed.searchParams.delete(param);
    }

    const hash = parsed.hash.replace(/^#/, '');
    if (hash.startsWith('t=') || hash.startsWith('time_continue=')) {
      parsed.hash = '';
    }

    return parsed.toString();
  } catch {
    return url;
  }
};

if (config.soundcloudClientId) {
  void play
    .setToken({ soundcloud: { client_id: config.soundcloudClientId } })
    .catch((error) => console.error('[soundcloud] Failed to set token', error));
}

app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json());
app.use(
  session({
    name: 'schwanzradio.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false
    }
  })
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj as Express.User);
});

const hasStreamAccess = (steamId: string, isAdmin: boolean) => {
  if (isAdmin) {
    return true;
  }

  return config.allowedSteamIds.includes(steamId);
};

passport.use(
  new SteamStrategy(
    {
      apiKey: config.steamApiKey,
      realm: config.steamRealm,
      returnURL: config.steamReturnUrl
    },
    (_identifier: string, profile: Profile, done) => {
      const avatar = profile.photos?.[0]?.value;
      const isAdmin = config.adminSteamIds.includes(profile.id);
      if (!hasStreamAccess(profile.id, isAdmin)) {
        console.warn('[auth] Blocked Steam ID from login attempt:', profile.id);
        return done(null, false);
      }

      done(null, {
        id: profile.id,
        displayName: profile.displayName,
        avatar,
        isAdmin
      });
    }
  )
);

const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ message: 'Steam login required' });
    return;
  }

  const user = req.user!;
  if (!hasStreamAccess(user.id, Boolean(user.isAdmin))) {
    res.status(403).json({ message: 'Account not allowed' });
    return;
  }

  next();
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth/steam', passport.authenticate('steam'));

app.get(
  '/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: `${config.clientOrigin}?error=login_failed` }),
  (req, res) => {
    // Check if authentication succeeded but user has no access
    if (!req.user) {
      res.redirect(`${config.clientOrigin}?error=no_permission`);
      return;
    }
    res.redirect(config.clientOrigin);
  }
);

app.post('/auth/logout', (req, res, next) => {
  req.logout((logoutError) => {
    if (logoutError) {
      next(logoutError);
      return;
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }

      res.clearCookie('schwanzradio.sid');
      res.json({ ok: true });
    });
  });
});

app.get('/api/me', (req, res) => {
  const user = req.user ?? null;
  const canQueue = user ? hasStreamAccess(user.id, Boolean(user.isAdmin)) : false;
  res.json({ user, canQueue });
});

app.get('/api/status', (_req, res) => {
  res.json(stream.getState());
});

// Pause/resume the global stream (any authenticated user)
app.post('/api/pause', requireAuth, (req, res) => {
  const { paused } = req.body as { paused?: boolean };
  if (typeof paused !== 'boolean') {
    res.status(400).json({ message: 'Missing or invalid "paused" boolean' });
    return;
  }

  stream.setPaused(paused);
  res.json({ ok: true, paused: stream.isPaused() });
});

// Skip the current track (any authenticated user)
app.post('/api/skip', requireAuth, (_req, res) => {
  stream.skipCurrent();
  res.json({ ok: true });
});

// Remove a track from the queue (any authenticated user)
app.delete('/api/queue/:trackId', requireAuth, (req, res) => {
  const { trackId } = req.params;
  const removed = queue.remove(trackId);
  if (!removed) {
    res.status(404).json({ message: 'Track not found in queue' });
    return;
  }
  res.json({ ok: true });
});

// Move a track in the queue (any authenticated user)
app.patch('/api/queue/:trackId', requireAuth, (req, res) => {
  const { trackId } = req.params;
  const { index } = req.body as { index?: number };
  if (typeof index !== 'number') {
    res.status(400).json({ message: 'Missing or invalid "index" number' });
    return;
  }
  const moved = queue.move(trackId, index);
  if (!moved) {
    res.status(404).json({ message: 'Track not found in queue' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/queue', requireAuth, async (req, res, next) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ message: 'Missing url' });
      return;
    }

    const trimmed = url.trim();
    const kind = await play.validate(trimmed);
    const requester = {
      id: req.user!.id,
      displayName: req.user!.displayName,
      avatar: req.user!.avatar
    };

    let track: Track;
    if (kind === 'yt_video') {
      const normalizedUrl = normalizeYoutubeUrl(trimmed);
      const info = await fetchYoutubeMetadata(normalizedUrl);
      track = queue.enqueue({
        source: 'youtube',
        url: normalizedUrl,
        title: info.title ?? 'YouTube track',
        thumbnail: info.thumbnail,
        duration: info.duration,
        requestedBy: requester
      });
    } else if (kind === 'so_track') {
      if (!config.soundcloudClientId) {
        res.status(503).json({ message: 'SoundCloud support is disabled on this server.' });
        return;
      }

      const info = await play.soundcloud(trimmed);
      if (!('durationInSec' in info)) {
        res.status(422).json({ message: 'Only individual SoundCloud tracks are supported.' });
        return;
      }

      const scTrack = info as {
        name?: string;
        durationInSec?: number;
        thumbnail?: string;
        user?: { thumbnail?: string };
      };

      track = queue.enqueue({
        source: 'soundcloud',
        url: trimmed,
        title: scTrack.name ?? 'SoundCloud track',
        thumbnail: scTrack.thumbnail ?? scTrack.user?.thumbnail,
        duration: scTrack.durationInSec,
        requestedBy: requester
      });
    } else {
      res.status(422).json({ message: 'Only YouTube videos or SoundCloud tracks are supported.' });
      return;
    }

    await stream.ensurePlaying();

    res.status(201).json({ track });
  } catch (error) {
    next(error);
  }
});

app.get('/stream', (_req, res) => {
  stream.attachClient(res);
});

// Thumbnail endpoints for current track
const serveThumbnail = (source: 'youtube' | 'soundcloud') => async (_req: Request, res: Response) => {
  const thumbnailUrl = stream.getCurrentThumbnail(source);

  if (!thumbnailUrl) {
    res.status(404).json({ message: `No ${source} track currently playing` });
    return;
  }

  try {
    const upstream = await fetch(thumbnailUrl);

    if (!upstream.ok) {
      res.status(502).json({ message: 'Failed to fetch thumbnail from upstream' });
      return;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer));

    // Convert all thumbnails to PNG; resize SoundCloud to 256x256
    if (source === 'soundcloud') {
      buffer = await sharp(buffer)
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toBuffer();
    } else {
      buffer = await sharp(buffer).png().toBuffer();
    }
    res.setHeader('Content-Type', 'image/png');

    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    console.error(`[thumbnail] Failed to proxy ${source} thumbnail:`, error);
    res.status(500).json({ message: 'Failed to fetch thumbnail' });
  }
};

app.get('/youtube/thumbnail.png', serveThumbnail('youtube'));
app.get('/soundcloud/thumbnail.png', serveThumbnail('soundcloud'));

// Serve built frontend if present (Docker image copies client/dist here)
const clientDistPath = path.resolve(__dirname, '../../client/dist');
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  // Catch-all fallback using middleware to avoid path-to-regexp wildcard issues on Express 5
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/stream') {
      next();
      return;
    }

    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  console.warn('[static] client build not found; skipping static hosting');
}

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled', error);
  res.status(500).json({ message: 'Unexpected server error' });
});

app.listen(config.port, () => {
  console.log(`SchwanzRadio backend listening on http://localhost:${config.port}`);
});
