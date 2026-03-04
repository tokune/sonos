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
        }
    }

    // ── Files routes ──
    if (path === "/api/files" && method === "GET") {
        const files = await scanMusicDir(config.musicDir);
        return json(files);
    }

    if (path === "/api/files/play" && method === "POST") {
        const body = await parseBody(req);
        const { filePath, deviceIP } = body;
        if (!filePath || !deviceIP) return json({ error: "filePath and deviceIP required" }, 400);

        const musicUrl = `http://${LOCAL_IP}:${PORT}/api/music/${encodeURIComponent(filePath)}`;
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

    // ── Config routes ──
    if (path === "/api/config" && method === "GET") {
        return json(config);
    }

    if (path === "/api/config" && method === "PUT") {
        const body = await parseBody(req);
        if (body.musicDir) {
            // Validate directory exists
            try {
                const s = await stat(body.musicDir);
                if (!s.isDirectory()) return json({ error: "Not a directory" }, 400);
                config.musicDir = body.musicDir;
                await saveJSON(CONFIG_PATH, config);
                return json({ ok: true, config });
            } catch {
                return json({ error: "Directory does not exist" }, 400);
            }
        }
        return json({ error: "musicDir required" }, 400);
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
                    const musicUrl = `http://${LOCAL_IP}:${PORT}/api/music/${encodeURIComponent(track.path)}`;
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
