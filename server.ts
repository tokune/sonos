import { readdir, stat, mkdir, readFile, writeFile, exists } from "fs/promises";
import { join, extname, basename, relative } from "path";
import { networkInterfaces } from "os";

// ─── Config ──────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = join(import.meta.dir, "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const PLAYLISTS_PATH = join(DATA_DIR, "playlists.json");
const DEFAULT_MUSIC_DIR = join(import.meta.dir, "music");

const AUDIO_EXTENSIONS = new Set([
    ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wav", ".wma", ".aiff", ".alac",
]);

const YOUTUBE_REGEX = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)([\w-]{11})/;
const BILIBILI_REGEX = /(?:bilibili\.com\/video\/|b23\.tv\/)/;

function isYouTubeUrl(url: string): boolean {
    return YOUTUBE_REGEX.test(url);
}

function isBilibiliUrl(url: string): boolean {
    return BILIBILI_REGEX.test(url);
}

function isAudioUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
        return AUDIO_EXTENSIONS.has(`.${ext}`);
    } catch {
        return false;
    }
}

async function extractYouTubeAudio(url: string): Promise<{ audioUrl: string; title: string }> {
    const proc = Bun.spawn(["yt-dlp", "-g", "-f", "bestaudio", "--get-title", url], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(stderr.trim() || "yt-dlp failed");
    }

    const lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length < 2) {
        throw new Error("yt-dlp returned unexpected output");
    }

    return {
        title: lines[0],
        audioUrl: lines[1],
    };
}

// ─── Helpers ─────────────────────────────────────────────────────
function getLocalIP(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (net.family === "IPv4" && !net.internal) return net.address;
        }
    }
    return "127.0.0.1";
}

const LOCAL_IP = getLocalIP();

async function ensureDir(dir: string) {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
}

async function loadJSON<T>(path: string, defaultValue: T): Promise<T> {
    try {
        const data = await readFile(path, "utf-8");
        return JSON.parse(data);
    } catch {
        return defaultValue;
    }
}

async function saveJSON(path: string, data: unknown) {
    await ensureDir(DATA_DIR);
    await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

interface AppConfig {
    musicDir: string;
    webdavUrl?: string;
    webdavUsername?: string;
    webdavPassword?: string;
}

interface Playlist {
    id: string;
    name: string;
    tracks: TrackInfo[];
    createdAt: string;
    updatedAt: string;
}

interface TrackInfo {
    path: string; // relative to music dir
    name: string;
    size: number;
}

// ─── State ───────────────────────────────────────────────────────
let config: AppConfig = { musicDir: DEFAULT_MUSIC_DIR };
let playlists: Playlist[] = [];

async function loadState() {
    await ensureDir(DATA_DIR);
    config = await loadJSON<AppConfig>(CONFIG_PATH, { musicDir: DEFAULT_MUSIC_DIR });
    playlists = await loadJSON<Playlist[]>(PLAYLISTS_PATH, []);
}

// ─── Sonos Discovery & Control ───────────────────────────────────
const { DeviceDiscovery, Sonos } = await import("sonos");

interface DeviceInfo {
    host: string;
    port: number;
    name: string;
    groupName?: string;
    model?: string;
}

let cachedDevices: DeviceInfo[] = [];
let lastDiscovery = 0;
const DISCOVERY_CACHE_MS = 30_000;

async function discoverDevices(): Promise<DeviceInfo[]> {
    const now = Date.now();
    if (cachedDevices.length > 0 && now - lastDiscovery < DISCOVERY_CACHE_MS) {
        return cachedDevices;
    }

    return new Promise((resolve) => {
        const devices: DeviceInfo[] = [];
        const timeout = setTimeout(() => {
            cachedDevices = devices;
            lastDiscovery = Date.now();
            resolve(devices);
        }, 5000);

        try {
            DeviceDiscovery((device: any) => {
                const d = new Sonos(device.host, device.port);
                d.getName()
                    .then((name: string) => {
                        devices.push({
                            host: device.host,
                            port: device.port || 1400,
                            name: name || device.host,
                        });
                    })
                    .catch(() => {
                        devices.push({
                            host: device.host,
                            port: device.port || 1400,
                            name: device.host,
                        });
                    });
            });
        } catch (err) {
            clearTimeout(timeout);
            resolve(cachedDevices);
        }
    });
}

function getSonosDevice(ip: string): InstanceType<typeof Sonos> {
    return new Sonos(ip);
}

async function getDeviceState(ip: string) {
    const device = getSonosDevice(ip);
    try {
        const [state, volume, track, muted] = await Promise.all([
            device.getCurrentState().catch(() => "unknown"),
            device.getVolume().catch(() => 0),
            device.currentTrack().catch(() => null),
            device.getMuted().catch(() => false),
        ]);
        return {
            state, // playing, paused, stopped, etc.
            volume,
            muted,
            track: track
                ? {
                    title: track.title || "",
                    artist: track.artist || "",
                    album: track.album || "",
                    albumArtURI: track.albumArtURI || "",
                    duration: track.duration || 0,
                    position: track.position || 0,
                    uri: track.uri || "",
                }
                : null,
        };
    } catch (err: any) {
        return { state: "error", error: err.message };
    }
}

// ─── File Scanner ────────────────────────────────────────────────
interface FileEntry {
    name: string;
    path: string; // relative path
    isDir: boolean;
    size?: number;
    children?: FileEntry[];
    source?: "local" | "webdav";
}

async function scanMusicDir(dir: string, basePath = ""): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    try {
        const items = await readdir(dir);
        for (const item of items) {
            if (item.startsWith(".")) continue;
            const fullPath = join(dir, item);
            const relPath = basePath ? `${basePath}/${item}` : item;
            const s = await stat(fullPath);
            if (s.isDirectory()) {
                const children = await scanMusicDir(fullPath, relPath);
                if (children.length > 0) {
                    entries.push({ name: item, path: relPath, isDir: true, children });
                }
            } else if (AUDIO_EXTENSIONS.has(extname(item).toLowerCase())) {
                entries.push({ name: item, path: relPath, isDir: false, size: s.size });
            }
        }
    } catch { }
    return entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// ─── WebDAV Scanner ──────────────────────────────────────────────
function getWebDAVHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
    };
    if (config.webdavUsername) {
        const cred = btoa(`${config.webdavUsername}:${config.webdavPassword || ""}`);
        headers["Authorization"] = `Basic ${cred}`;
    }
    return headers;
}

async function scanWebDAV(davUrl: string, basePath = ""): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    try {
        const url = davUrl.endsWith("/") ? davUrl : davUrl + "/";
        const res = await fetch(url, {
            method: "PROPFIND",
            headers: getWebDAVHeaders(),
            body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
        });
        if (!res.ok) return entries;
        const xml = await res.text();

        // Simple XML parsing for DAV responses
        const responses = xml.split("<d:response>").slice(1).map(r => r.split("</d:response>")[0] || r);
        // Also handle uppercase / no-prefix variants
        const allResponses = xml.split(/<(?:d:|D:)?response>/i).slice(1).map(r => r.split(/<\/(?:d:|D:)?response>/i)[0] || r);
        const items = allResponses.length > responses.length ? allResponses : responses;

        for (const item of items) {
            // Extract href
            const hrefMatch = item.match(/<(?:d:|D:)?href>([^<]+)<\/(?:d:|D:)?href>/i);
            if (!hrefMatch) continue;
            const href = decodeURIComponent(hrefMatch[1]);

            // Skip the directory itself (first response is always the requested directory)
            const normalizedUrl = new URL(url).pathname.replace(/\/+$/, "");
            const normalizedHref = href.replace(/\/+$/, "");
            if (normalizedHref === normalizedUrl || normalizedHref === "") continue;

            const isCollection = /<(?:d:|D:)?collection/i.test(item);
            const name = href.replace(/\/$/, "").split("/").pop() || "";
            if (!name || name.startsWith(".")) continue;

            const relPath = basePath ? `${basePath}/${name}` : name;

            if (isCollection) {
                const childUrl = url + encodeURIComponent(name) + "/";
                const children = await scanWebDAV(childUrl, relPath);
                if (children.length > 0) {
                    entries.push({ name, path: relPath, isDir: true, children, source: "webdav" });
                }
            } else if (AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) {
                const sizeMatch = item.match(/<(?:d:|D:)?getcontentlength>([^<]+)<\/(?:d:|D:)?getcontentlength>/i);
                const size = sizeMatch ? parseInt(sizeMatch[1]) : 0;
                entries.push({ name, path: relPath, isDir: false, size, source: "webdav" });
            }
        }
    } catch (err) {
        console.error("WebDAV scan error:", err);
    }
    return entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

function markLocalSource(entries: FileEntry[]): FileEntry[] {
    return entries.map(e => ({
        ...e,
        source: "local" as const,
        children: e.children ? markLocalSource(e.children) : undefined,
    }));
}

// ─── HTTP Router ─────────────────────────────────────────────────
function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
}

function cors() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}

async function parseBody(req: Request): Promise<any> {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

async function handleAPI(req: Request, path: string): Promise<Response> {
    const method = req.method;

    // ── Device routes ──
    if (path === "/api/devices" && method === "GET") {
        const devices = await discoverDevices();
        return json(devices);
    }

    const deviceMatch = path.match(/^\/api\/devices\/([^/]+)\/(.+)$/);
    if (deviceMatch) {
        const ip = decodeURIComponent(deviceMatch[1]);
        const action = deviceMatch[2];
        const device = getSonosDevice(ip);

        switch (action) {
            case "state":
                return json(await getDeviceState(ip));
            case "play":
                if (method === "POST") {
                    const body = await parseBody(req);
                    if (body.uri) {
                        await device.play(body.uri);
                    } else {
                        await device.play();
                    }
                    return json({ ok: true });
                }
                break;
            case "pause":
                if (method === "POST") {
                    await device.pause();
                    return json({ ok: true });
                }
                break;
            case "stop":
                if (method === "POST") {
                    await device.stop();
                    return json({ ok: true });
                }
                break;
            case "next":
                if (method === "POST") {
                    await device.next();
                    return json({ ok: true });
                }
                break;
            case "previous":
                if (method === "POST") {
                    await device.previous();
                    return json({ ok: true });
                }
                break;
            case "volume":
                if (method === "POST") {
                    const body = await parseBody(req);
                    await device.setVolume(body.volume ?? 30);
                    return json({ ok: true });
                }
                if (method === "GET") {
                    const vol = await device.getVolume();
                    return json({ volume: vol });
                }
                break;
            case "seek":
                if (method === "POST") {
                    const body = await parseBody(req);
                    await device.seek(body.seconds ?? 0);
                    return json({ ok: true });
                }
                break;
            case "mute":
                if (method === "POST") {
                    const body = await parseBody(req);
                    const currentMuted = await device.getMuted();
                    await device.setMuted(body.muted ?? !currentMuted);
                    return json({ ok: true, muted: body.muted ?? !currentMuted });
                }
                break;
            case "queue":
                if (method === "GET") {
                    const queue = await device.getQueue();
                    return json(queue);
                }
                break;
            case "queue/clear":
                if (method === "POST") {
                    await device.flush();
                    return json({ ok: true });
                }
                break;
            case "queue/add":
                if (method === "POST") {
                    const body = await parseBody(req);
                    if (body.uri) {
                        await device.queue(body.uri);
                        return json({ ok: true });
                    }
                    return json({ error: "uri required" }, 400);
                }
                break;
            case "queue/remove":
                if (method === "POST") {
                    const body = await parseBody(req);
                    const trackNum = body.index;
                    if (trackNum === undefined) return json({ error: "index required" }, 400);
                    try {
                        // removeTracksFromQueue expects track number (1-based)
                        await (device as any).removeTracksFromQueue(trackNum + 1, 1);
                        return json({ ok: true });
                    } catch (err: any) {
                        return json({ error: err.message }, 500);
                    }
                }
                break;
            case "queue/shuffle":
                if (method === "POST") {
                    const body = await parseBody(req);
                    const shuffle = body.shuffle ?? true;
                    try {
                        // Use setPlayMode to toggle shuffle
                        const mode = shuffle ? "SHUFFLE" : "NORMAL";
                        await (device as any).setPlayMode(mode);
                        return json({ ok: true, mode });
                    } catch (err: any) {
                        return json({ error: err.message }, 500);
                    }
                }
                break;
            case "queue/playindex":
                if (method === "POST") {
                    const body = await parseBody(req);
                    const idx = body.index;
                    if (idx === undefined) return json({ error: "index required" }, 400);
                    try {
                        // selectTrack expects 1-based index
                        await (device as any).selectTrack(idx + 1);
                        await device.play();
                        return json({ ok: true });
                    } catch (err: any) {
                        return json({ error: err.message }, 500);
                    }
                }
                break;
            case "playmode":
                if (method === "GET") {
                    try {
                        const mode = await (device as any).getPlayMode();
                        return json({ mode });
                    } catch (err: any) {
                        return json({ mode: "NORMAL" });
                    }
                }
                break;
        }
    }

    // ── URL play routes ──
    if (path === "/api/url/info" && method === "POST") {
        const body = await parseBody(req);
        const { url } = body;
        if (!url) return json({ error: "url required" }, 400);

        let type = "unknown";
        let title = "";

        if (isYouTubeUrl(url)) {
            type = "youtube";
            try {
                const info = await extractYouTubeAudio(url);
                title = info.title;
            } catch {
                title = "YouTube Video";
            }
        } else if (isBilibiliUrl(url)) {
            type = "bilibili";
            try {
                const info = await extractYouTubeAudio(url);
                title = info.title;
            } catch {
                title = "Bilibili Video";
            }
        } else if (isAudioUrl(url)) {
            type = "audio";
            try {
                const parsed = new URL(url);
                title = decodeURIComponent(parsed.pathname.split("/").pop() || url);
            } catch {
                title = url;
            }
        }

        return json({ type, title, url });
    }

    if (path === "/api/url/play" && method === "POST") {
        const body = await parseBody(req);
        const { url, deviceIP } = body;
        if (!url || !deviceIP) return json({ error: "url and deviceIP required" }, 400);

        const device = getSonosDevice(deviceIP);

        try {
            let playUrl = url;
            let title = url;

            if (isYouTubeUrl(url) || isBilibiliUrl(url)) {
                const info = await extractYouTubeAudio(url);
                playUrl = info.audioUrl;
                title = info.title;
            } else if (isAudioUrl(url)) {
                try {
                    const parsed = new URL(url);
                    title = decodeURIComponent(parsed.pathname.split("/").pop() || url);
                } catch { }
            }

            await device.play(playUrl);
            return json({ ok: true, title, playUrl });
        } catch (err: any) {
            return json({ error: err.message }, 500);
        }
    }

    // ── Files routes ──
    if (path === "/api/files" && method === "GET") {
        const localFiles = markLocalSource(await scanMusicDir(config.musicDir));
        let allFiles = localFiles;
        if (config.webdavUrl) {
            try {
                const webdavFiles = await scanWebDAV(config.webdavUrl);
                allFiles = [...localFiles, ...webdavFiles];
            } catch { }
        }
        return json(allFiles);
    }

    if (path === "/api/files/all" && method === "GET") {
        const localFiles = markLocalSource(await scanMusicDir(config.musicDir));
        const flattenFiles = (entries: FileEntry[]): FileEntry[] => {
            const result: FileEntry[] = [];
            for (const e of entries) {
                if (e.isDir && e.children) {
                    result.push(...flattenFiles(e.children));
                } else if (!e.isDir) {
                    result.push(e);
                }
            }
            return result;
        };
        let flat = flattenFiles(localFiles);
        if (config.webdavUrl) {
            try {
                const webdavFiles = await scanWebDAV(config.webdavUrl);
                flat = [...flat, ...flattenFiles(webdavFiles)];
            } catch { }
        }
        return json(flat);
    }

    if (path === "/api/files/play-all" && method === "POST") {
        const body = await parseBody(req);
        const { deviceIP, shuffle } = body;
        if (!deviceIP) return json({ error: "deviceIP required" }, 400);

        const localFiles = markLocalSource(await scanMusicDir(config.musicDir));
        const flattenFiles = (entries: FileEntry[]): FileEntry[] => {
            const result: FileEntry[] = [];
            for (const e of entries) {
                if (e.isDir && e.children) {
                    result.push(...flattenFiles(e.children));
                } else if (!e.isDir) {
                    result.push(e);
                }
            }
            return result;
        };
        let allFiles = flattenFiles(localFiles);
        if (config.webdavUrl) {
            try {
                const webdavFiles = await scanWebDAV(config.webdavUrl);
                allFiles = [...allFiles, ...flattenFiles(webdavFiles)];
            } catch { }
        }
        if (shuffle) {
            // Fisher-Yates shuffle
            for (let i = allFiles.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [allFiles[i], allFiles[j]] = [allFiles[j]!, allFiles[i]!];
            }
        }

        const device = getSonosDevice(deviceIP);
        try {
            await device.flush();
            for (const file of allFiles) {
                const musicUrl = file.source === "webdav"
                    ? `http://${LOCAL_IP}:${PORT}/api/webdav-music/${encodeURIComponent(file.path)}`
                    : `http://${LOCAL_IP}:${PORT}/api/music/${encodeURIComponent(file.path)}`;
                await device.queue(musicUrl);
            }
            await device.selectQueue();
            await device.play();
            return json({ ok: true, count: allFiles.length });
        } catch (err: any) {
            return json({ error: err.message }, 500);
        }
    }

    if (path === "/api/files/play" && method === "POST") {
        const body = await parseBody(req);
        const { filePath, deviceIP, source } = body;
        if (!filePath || !deviceIP) return json({ error: "filePath and deviceIP required" }, 400);

        const musicUrl = source === "webdav"
            ? `http://${LOCAL_IP}:${PORT}/api/webdav-music/${encodeURIComponent(filePath)}`
            : `http://${LOCAL_IP}:${PORT}/api/music/${encodeURIComponent(filePath)}`;
        const device = getSonosDevice(deviceIP);
        try {
            await device.play(musicUrl);
            return json({ ok: true, url: musicUrl });
        } catch (err: any) {
            return json({ error: err.message }, 500);
        }
    }

    // ── Music file streaming ──
    if (path.startsWith("/api/music/")) {
        const filePath = decodeURIComponent(path.replace("/api/music/", ""));
        const fullPath = join(config.musicDir, filePath);

        // Security check
        if (!fullPath.startsWith(config.musicDir)) {
            return json({ error: "forbidden" }, 403);
        }

        try {
            const file = Bun.file(fullPath);
            if (!(await file.exists())) return json({ error: "not found" }, 404);
            return new Response(file, {
                headers: {
                    "Content-Type": file.type || "audio/mpeg",
                    "Access-Control-Allow-Origin": "*",
                    "Accept-Ranges": "bytes",
                },
            });
        } catch {
            return json({ error: "not found" }, 404);
        }
    }

    // ── WebDAV music proxy streaming ──
    if (path.startsWith("/api/webdav-music/")) {
        if (!config.webdavUrl) return json({ error: "WebDAV not configured" }, 400);
        const filePath = decodeURIComponent(path.replace("/api/webdav-music/", ""));
        const baseUrl = config.webdavUrl.endsWith("/") ? config.webdavUrl : config.webdavUrl + "/";
        const fileUrl = baseUrl + filePath.split("/").map(encodeURIComponent).join("/");

        try {
            const headers: Record<string, string> = {};
            if (config.webdavUsername) {
                headers["Authorization"] = `Basic ${btoa(`${config.webdavUsername}:${config.webdavPassword || ""}`)}`;
            }
            // Forward range header for seeking
            const rangeHeader = req.headers.get("Range");
            if (rangeHeader) headers["Range"] = rangeHeader;

            const upstream = await fetch(fileUrl, { headers });
            if (!upstream.ok) return json({ error: "WebDAV fetch failed" }, upstream.status);

            const ext = extname(filePath).toLowerCase();
            const mimeMap: Record<string, string> = {
                ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4",
                ".aac": "audio/aac", ".ogg": "audio/ogg", ".wav": "audio/wav",
                ".wma": "audio/x-ms-wma", ".aiff": "audio/aiff", ".alac": "audio/mp4",
            };

            const respHeaders: Record<string, string> = {
                "Content-Type": mimeMap[ext] || upstream.headers.get("Content-Type") || "audio/mpeg",
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
            };
            const cl = upstream.headers.get("Content-Length");
            if (cl) respHeaders["Content-Length"] = cl;
            const cr = upstream.headers.get("Content-Range");
            if (cr) respHeaders["Content-Range"] = cr;

            return new Response(upstream.body, {
                status: upstream.status,
                headers: respHeaders,
            });
        } catch (err: any) {
            return json({ error: "WebDAV stream error: " + err.message }, 500);
        }
    }

    // ── WebDAV test connection ──
    if (path === "/api/webdav/test" && method === "POST") {
        const body = await parseBody(req);
        const { url, username, password } = body;
        if (!url) return json({ error: "url required" }, 400);
        try {
            const headers: Record<string, string> = {
                "Content-Type": "application/xml; charset=utf-8",
                "Depth": "0",
            };
            if (username) {
                headers["Authorization"] = `Basic ${btoa(`${username}:${password || ""}`)}`;
            }
            const res = await fetch(url.endsWith("/") ? url : url + "/", {
                method: "PROPFIND",
                headers,
                body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
            });
            if (res.ok || res.status === 207) {
                return json({ ok: true, status: res.status });
            }
            return json({ ok: false, error: `HTTP ${res.status} ${res.statusText}` });
        } catch (err: any) {
            return json({ ok: false, error: err.message });
        }
    }

    // ── WebDAV browse directories ──
    if (path === "/api/webdav/browse" && method === "POST") {
        const body = await parseBody(req);
        const { url, username, password } = body;
        if (!url) return json({ error: "url required" }, 400);
        try {
            const headers: Record<string, string> = {
                "Content-Type": "application/xml; charset=utf-8",
                "Depth": "1",
            };
            if (username) {
                headers["Authorization"] = `Basic ${btoa(`${username}:${password || ""}`)}`;
            }
            const targetUrl = url.endsWith("/") ? url : url + "/";
            const res = await fetch(targetUrl, {
                method: "PROPFIND",
                headers,
                body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`,
            });
            if (!res.ok && res.status !== 207) {
                return json({ ok: false, error: `HTTP ${res.status}` });
            }
            const xml = await res.text();
            const allResponses = xml.split(/<(?:d:|D:)?response>/i).slice(1).map(r => r.split(/<\/(?:d:|D:)?response>/i)[0] || r);

            const dirs: { name: string; path: string }[] = [];
            let audioCount = 0;
            const normalizedUrl = new URL(targetUrl).pathname.replace(/\/+$/, "");

            for (const item of allResponses) {
                const hrefMatch = item.match(/<(?:d:|D:)?href>([^<]+)<\/(?:d:|D:)?href>/i);
                if (!hrefMatch) continue;
                const href = decodeURIComponent(hrefMatch[1]);
                const normalizedHref = href.replace(/\/+$/, "");
                if (normalizedHref === normalizedUrl || normalizedHref === "") continue;

                const isCollection = /<(?:d:|D:)?collection/i.test(item);
                const name = href.replace(/\/$/, "").split("/").pop() || "";
                if (!name || name.startsWith(".")) continue;

                if (isCollection) {
                    dirs.push({ name, path: targetUrl + encodeURIComponent(name) + "/" });
                } else if (AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) {
                    audioCount++;
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            return json({ ok: true, dirs, audioCount, currentUrl: targetUrl });
        } catch (err: any) {
            return json({ ok: false, error: err.message });
        }
    }

    // ── Config routes ──
    if (path === "/api/config" && method === "GET") {
        // Don't expose password in full
        const safeConfig = {
            ...config,
            webdavPassword: config.webdavPassword ? "********" : "",
        };
        return json(safeConfig);
    }

    if (path === "/api/config" && method === "PUT") {
        const body = await parseBody(req);
        let changed = false;

        if (body.musicDir) {
            // Validate directory exists
            try {
                const s = await stat(body.musicDir);
                if (!s.isDirectory()) return json({ error: "Not a directory" }, 400);
                config.musicDir = body.musicDir;
                changed = true;
            } catch {
                return json({ error: "Directory does not exist" }, 400);
            }
        }

        // WebDAV config update
        if (body.webdavUrl !== undefined) {
            config.webdavUrl = body.webdavUrl || "";
            changed = true;
        }
        if (body.webdavUsername !== undefined) {
            config.webdavUsername = body.webdavUsername || "";
            changed = true;
        }
        if (body.webdavPassword !== undefined && body.webdavPassword !== "********") {
            config.webdavPassword = body.webdavPassword || "";
            changed = true;
        }

        if (changed) {
            await saveJSON(CONFIG_PATH, config);
            return json({ ok: true, config: { ...config, webdavPassword: config.webdavPassword ? "********" : "" } });
        }
        return json({ error: "No valid fields to update" }, 400);
    }

    // ── Playlist routes ──
    if (path === "/api/playlists" && method === "GET") {
        return json(playlists);
    }

    if (path === "/api/playlists" && method === "POST") {
        const body = await parseBody(req);
        const playlist: Playlist = {
            id: crypto.randomUUID(),
            name: body.name || "Untitled",
            tracks: body.tracks || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        playlists.push(playlist);
        await saveJSON(PLAYLISTS_PATH, playlists);
        return json(playlist, 201);
    }

    const playlistMatch = path.match(/^\/api\/playlists\/([^/]+)(\/.*)?$/);
    if (playlistMatch) {
        const id = playlistMatch[1];
        const sub = playlistMatch[2] || "";
        const idx = playlists.findIndex((p) => p.id === id);

        if (sub === "/play" && method === "POST") {
            if (idx === -1) return json({ error: "not found" }, 404);
            const body = await parseBody(req);
            const deviceIP = body.deviceIP;
            if (!deviceIP) return json({ error: "deviceIP required" }, 400);
            const device = getSonosDevice(deviceIP);
            const playlist = playlists[idx];

            // Clear queue and add all tracks
            try {
                await device.flush();
                for (const track of playlist.tracks) {
                    const musicUrl = (track as any).source === "webdav"
                        ? `http://${LOCAL_IP}:${PORT}/api/webdav-music/${encodeURIComponent(track.path)}`
                        : `http://${LOCAL_IP}:${PORT}/api/music/${encodeURIComponent(track.path)}`;
                    await device.queue(musicUrl);
                }
                await device.selectQueue();
                await device.play();
                return json({ ok: true });
            } catch (err: any) {
                return json({ error: err.message }, 500);
            }
        }

        if (method === "GET") {
            if (idx === -1) return json({ error: "not found" }, 404);
            return json(playlists[idx]);
        }

        if (method === "PUT") {
            if (idx === -1) return json({ error: "not found" }, 404);
            const body = await parseBody(req);
            playlists[idx] = {
                ...playlists[idx],
                name: body.name ?? playlists[idx].name,
                tracks: body.tracks ?? playlists[idx].tracks,
                updatedAt: new Date().toISOString(),
            };
            await saveJSON(PLAYLISTS_PATH, playlists);
            return json(playlists[idx]);
        }

        if (method === "DELETE") {
            if (idx === -1) return json({ error: "not found" }, 404);
            playlists.splice(idx, 1);
            await saveJSON(PLAYLISTS_PATH, playlists);
            return json({ ok: true });
        }
    }

    return json({ error: "not found" }, 404);
}

// ─── Static Files + Server ───────────────────────────────────────
await loadState();
await ensureDir(join(import.meta.dir, "music"));

const PUBLIC_DIR = join(import.meta.dir, "public");

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (req.method === "OPTIONS") return cors();

        // API routes
        if (path.startsWith("/api/")) {
            try {
                return await handleAPI(req, path);
            } catch (err: any) {
                console.error("API error:", err);
                return json({ error: err.message || "Internal server error" }, 500);
            }
        }

        // Static files
        let filePath = join(PUBLIC_DIR, path === "/" ? "index.html" : path);
        try {
            const file = Bun.file(filePath);
            if (await file.exists()) return new Response(file);
        } catch { }

        // SPA fallback
        const indexFile = Bun.file(join(PUBLIC_DIR, "index.html"));
        return new Response(indexFile);
    },
});

console.log(`
╔══════════════════════════════════════════════╗
║        🔊 Sonos Manager Started             ║
╠══════════════════════════════════════════════╣
║  Local:    http://localhost:${PORT}             ║
║  Network:  http://${LOCAL_IP}:${PORT}      ║
║  Music:    ${config.musicDir.padEnd(33)}║
╚══════════════════════════════════════════════╝
`);
