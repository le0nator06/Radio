import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const rootEnvPath = path.resolve(__dirname, '../..', '.env');
if (existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  dotenv.config();
}

const parseIdList = (value?: string) =>
  value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

const numberFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const booleanFromEnv = (value: string | undefined, fallback = false) => {
  if (value == null) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

// Prefer JSON cookies from file if YT_COOKIE_FILE is set
const cookieFromFile = (() => {
  const filePath = process.env.YT_COOKIE_FILE;
  if (!filePath) return '';
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (existsSync(abs)) {
      const contents = readFileSync(abs, 'utf8').trim();
      if (contents) {
        return contents;
      }
    }
  } catch {
    // ignore and fall back to env
  }
  return '';
})();

export const config = {
  port: numberFromEnv(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  sessionSecret: process.env.SESSION_SECRET ?? 'change-me-in-production',
  steamApiKey: process.env.STEAM_API_KEY ?? '',
  steamRealm: process.env.STEAM_REALM ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000',
  steamReturnUrl:
    process.env.STEAM_RETURN_URL ?? `${process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000'}/auth/steam/return`,
  adminSteamIds: parseIdList(process.env.STEAM_ADMIN_IDS),
  allowedSteamIds: parseIdList(process.env.STEAM_ALLOWED_IDS),
  soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? '',
  // Avoid nullish coalescing in compiled JS to keep broad runtime compatibility
  youtubeCookie:
    cookieFromFile ||
    (process.env.YT_COOKIE ? process.env.YT_COOKIE : '') ||
    (process.env.YOUTUBE_COOKIE ? process.env.YOUTUBE_COOKIE : ''),
  youtubeUserAgent:
    process.env.YT_UA ??
    process.env.YOUTUBE_UA ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  // Default: prefer non-HLS audio-only to avoid short playlists
  ytdlpFormat:
    process.env.YTDLP_FORMAT ||
    'bestaudio[protocol!=m3u8][protocol!=m3u8_native][protocol!=dash]/bestaudio[ext=m4a]/bestaudio/best',
  disableYtDlp: booleanFromEnv(process.env.DISABLE_YTDLP),
  // Use yt-dlp directly instead of trying ytdl-core first (faster when ytdl-core keeps failing)
  ytdlpFirst: booleanFromEnv(process.env.YTDLP_FIRST)
};

if (!config.steamApiKey) {
  console.warn('[config] Missing STEAM_API_KEY, Steam login will fail.');
}

if (config.adminSteamIds.length) {
  console.log('[config] Admin Steam IDs loaded:', config.adminSteamIds.length);
}

if (config.allowedSteamIds.length) {
  console.log('[config] Allowed Steam IDs loaded:', config.allowedSteamIds.length);
}

if (!config.soundcloudClientId) {
  console.warn('[config] Missing SOUNDCLOUD_CLIENT_ID, SoundCloud links are disabled.');
}

if (!config.youtubeCookie) {
  console.warn('[config] No YT cookie configured; set YT_COOKIE or YT_COOKIE_FILE to reduce YouTube 429 errors.');
}

if (config.disableYtDlp) {
  console.warn('[config] DISABLE_YTDLP is set; skipping yt-dlp and using ytdl-core only.');
}

if (config.ytdlpFirst) {
  console.log('[config] YTDLP_FIRST is set; using yt-dlp directly for faster YouTube streaming.');
}
