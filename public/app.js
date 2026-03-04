// ─── Sonos Manager Frontend ──────────────────────────────────────
(() => {
    "use strict";

    // ─── State ───────────────────────────────────────────────────
    const state = {
        devices: [],
        selectedDevice: null,
        playState: null,
        files: [],
        playlists: [],
        currentView: "files",
        currentPath: [], // breadcrumb path segments
        currentFiles: [], // files at current path level
        selectedPlaylist: null,
        pollInterval: null,
    };

    // ─── API ─────────────────────────────────────────────────────
    const api = {
        async get(url) {
            const res = await fetch(url);
            return res.json();
        },
        async post(url, body = {}) {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return res.json();
        },
        async put(url, body = {}) {
            const res = await fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return res.json();
        },
        async del(url) {
            const res = await fetch(url, { method: "DELETE" });
            return res.json();
        },
    };

    // ─── Elements ────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        deviceSelect: $("#deviceSelect"),
        refreshDevices: $("#refreshDevices"),
        settingsBtn: $("#settingsBtn"),
        fileList: $("#fileList"),
        breadcrumb: $("#breadcrumb"),
        playlistContent: $("#playlistContent"),
        playlistViewTitle: $("#playlistViewTitle"),
        queueContent: $("#queueContent"),
        clearQueueBtn: $("#clearQueueBtn"),
        playerBar: $("#playerBar"),
        trackArt: $("#trackArt"),
        trackTitle: $("#trackTitle"),
        trackArtist: $("#trackArtist"),
        playPauseBtn: $("#playPauseBtn"),
        prevBtn: $("#prevBtn"),
        nextBtn: $("#nextBtn"),
        muteBtn: $("#muteBtn"),
        progressBar: $("#progressBar"),
        currentTime: $("#currentTime"),
        totalTime: $("#totalTime"),
        volumeBar: $("#volumeBar"),
        settingsModal: $("#settingsModal"),
        musicDirInput: $("#musicDirInput"),
        saveMusicDir: $("#saveMusicDir"),
        serverAddr: $("#serverAddr"),
        deviceCount: $("#deviceCount"),
        createPlaylistModal: $("#createPlaylistModal"),
        playlistNameInput: $("#playlistNameInput"),
        confirmCreatePlaylist: $("#confirmCreatePlaylist"),
        sidebarPlaylists: $("#sidebarPlaylists"),
        playlistList: $("#playlistList"),
    };

    // ─── Toast ───────────────────────────────────────────────────
    let toastContainer = document.querySelector(".toast-container");
    if (!toastContainer) {
        toastContainer = document.createElement("div");
        toastContainer.className = "toast-container";
        document.body.appendChild(toastContainer);
    }

    function toast(message, type = "info") {
        const el = document.createElement("div");
        el.className = `toast ${type}`;
        el.textContent = message;
        toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    // ─── Formatters ──────────────────────────────────────────────
    function formatTime(sec) {
        if (!sec || isNaN(sec)) return "0:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    function formatSize(bytes) {
        if (!bytes) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1048576).toFixed(1) + " MB";
    }

    // ─── Device Management ──────────────────────────────────────
    async function loadDevices() {
        try {
            els.refreshDevices.classList.add("spin");
            state.devices = await api.get("/api/devices");
            renderDeviceSelect();
            els.deviceCount.textContent = state.devices.length;
        } catch (err) {
            toast("设备发现失败: " + err.message, "error");
        } finally {
            els.refreshDevices.classList.remove("spin");
        }
    }

    function renderDeviceSelect() {
        els.deviceSelect.innerHTML = "";
        if (state.devices.length === 0) {
            els.deviceSelect.innerHTML = '<option value="">未发现设备</option>';
            return;
        }
        state.devices.forEach((d) => {
            const opt = document.createElement("option");
            opt.value = d.host;
            opt.textContent = `${d.name} (${d.host})`;
            els.deviceSelect.appendChild(opt);
        });

        // Auto-select first or restore selection
        if (state.selectedDevice && state.devices.find((d) => d.host === state.selectedDevice)) {
            els.deviceSelect.value = state.selectedDevice;
        } else {
            state.selectedDevice = state.devices[0]?.host || null;
            els.deviceSelect.value = state.selectedDevice || "";
        }
    }

    // ─── Playback State Polling ──────────────────────────────────
    async function pollState() {
        if (!state.selectedDevice) return;
        try {
            const s = await api.get(`/api/devices/${encodeURIComponent(state.selectedDevice)}/state`);
            state.playState = s;
            renderPlayer(s);
        } catch { }
    }

    function renderPlayer(s) {
        if (!s || s.state === "error") return;

        // Play/Pause button
        const isPlaying = s.state === "playing";
        els.playPauseBtn.querySelector(".play-icon").style.display = isPlaying ? "none" : "block";
        els.playPauseBtn.querySelector(".pause-icon").style.display = isPlaying ? "block" : "none";

        // Track info
        if (s.track) {
            els.trackTitle.textContent = s.track.title || "未知曲目";
            els.trackArtist.textContent = s.track.artist || "未知艺术家";

            if (s.track.albumArtURI) {
                els.trackArt.innerHTML = `<img src="${s.track.albumArtURI}" alt="cover" onerror="this.parentElement.innerHTML='<svg width=24 height=24 viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.5&quot; opacity=&quot;0.5&quot;><path d=&quot;M9 18V5l12-2v13&quot;/><circle cx=&quot;6&quot; cy=&quot;18&quot; r=&quot;3&quot;/><circle cx=&quot;18&quot; cy=&quot;16&quot; r=&quot;3&quot;/></svg>'">`;
            }

            // Progress
            if (s.track.duration > 0) {
                els.progressBar.max = s.track.duration;
                els.progressBar.value = s.track.position || 0;
                els.currentTime.textContent = formatTime(s.track.position);
                els.totalTime.textContent = formatTime(s.track.duration);
            }
        }

        // Volume
        els.volumeBar.value = s.volume || 0;

        // Mute
        const isMuted = s.muted;
        els.muteBtn.querySelector(".vol-icon").style.display = isMuted ? "none" : "block";
        els.muteBtn.querySelector(".mute-icon").style.display = isMuted ? "block" : "none";
    }

    function startPolling() {
        stopPolling();
        pollState();
        state.pollInterval = setInterval(pollState, 2000);
    }

    function stopPolling() {
        if (state.pollInterval) {
            clearInterval(state.pollInterval);
            state.pollInterval = null;
        }
    }

    // ─── Player Controls ────────────────────────────────────────
    async function playerControl(action, body = {}) {
        if (!state.selectedDevice) {
            toast("请先选择一个设备", "error");
            return;
        }
        try {
            await api.post(`/api/devices/${encodeURIComponent(state.selectedDevice)}/${action}`, body);
            setTimeout(pollState, 300);
        } catch (err) {
            toast("控制失败: " + err.message, "error");
        }
    }

    // ─── File Browser ────────────────────────────────────────────
    async function loadFiles() {
        try {
            state.files = await api.get("/api/files");
            state.currentPath = [];
            state.currentFiles = state.files;
            renderFiles();
        } catch (err) {
            toast("加载文件失败: " + err.message, "error");
        }
    }

    function navigateToPath(pathSegments) {
        state.currentPath = pathSegments;
        let current = state.files;
        for (const seg of pathSegments) {
            const dir = current.find((f) => f.name === seg && f.isDir);
            if (dir && dir.children) current = dir.children;
            else break;
        }
        state.currentFiles = current;
        renderFiles();
    }

    function renderBreadcrumb() {
        els.breadcrumb.innerHTML = "";
        const rootBtn = document.createElement("button");
        rootBtn.className = "breadcrumb-item";
        rootBtn.textContent = "📁 根目录";
        rootBtn.onclick = () => navigateToPath([]);
        els.breadcrumb.appendChild(rootBtn);

        state.currentPath.forEach((seg, i) => {
            const sep = document.createElement("span");
            sep.className = "breadcrumb-sep";
            sep.textContent = " / ";
            els.breadcrumb.appendChild(sep);

            const btn = document.createElement("button");
            btn.className = "breadcrumb-item";
            btn.textContent = seg;
            btn.onclick = () => navigateToPath(state.currentPath.slice(0, i + 1));
            els.breadcrumb.appendChild(btn);
        });
    }

    function renderFiles() {
        renderBreadcrumb();
        const list = state.currentFiles;

        if (!list || list.length === 0) {
            els.fileList.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <p>此目录暂无音乐文件</p>
          <p class="hint">在设置中配置音乐目录，或添加音频文件</p>
        </div>`;
            return;
        }

        els.fileList.innerHTML = list
            .map((f) => {
                if (f.isDir) {
                    return `
          <div class="file-item" data-dir="${f.name}">
            <div class="file-icon folder">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            </div>
            <span class="file-name">${f.name}</span>
            <span class="file-size">${f.children ? f.children.length + " 项" : ""}</span>
          </div>`;
                } else {
                    return `
          <div class="file-item" data-path="${f.path}">
            <div class="file-icon audio">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            </div>
            <span class="file-name">${f.name}</span>
            <span class="file-size">${formatSize(f.size)}</span>
            <div class="file-actions">
              <button class="btn sm primary play-file" data-path="${f.path}" title="播放">▶ 播放</button>
              <button class="btn sm add-to-playlist" data-path="${f.path}" data-name="${f.name}" data-size="${f.size || 0}" title="添加到播放列表">+ 列表</button>
            </div>
          </div>`;
                }
            })
            .join("");

        // Directory navigation
        els.fileList.querySelectorAll("[data-dir]").forEach((el) => {
            el.addEventListener("click", () => {
                navigateToPath([...state.currentPath, el.dataset.dir]);
            });
        });

        // Play file
        els.fileList.querySelectorAll(".play-file").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!state.selectedDevice) {
                    toast("请先选择设备", "error");
                    return;
                }
                try {
                    await api.post("/api/files/play", {
                        filePath: btn.dataset.path,
                        deviceIP: state.selectedDevice,
                    });
                    toast("开始播放", "success");
                    setTimeout(pollState, 500);
                } catch (err) {
                    toast("播放失败: " + err.message, "error");
                }
            });
        });

        // Add to playlist
        els.fileList.querySelectorAll(".add-to-playlist").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                showAddToPlaylistMenu(btn, {
                    path: btn.dataset.path,
                    name: btn.dataset.name,
                    size: parseInt(btn.dataset.size) || 0,
                });
            });
        });
    }

    // ─── Add to Playlist Dropdown ────────────────────────────────
    function showAddToPlaylistMenu(anchorEl, track) {
        // Remove existing dropdown
        document.querySelectorAll(".dropdown-menu").forEach((el) => el.remove());

        if (state.playlists.length === 0) {
            toast("请先创建播放列表", "info");
            return;
        }

        const menu = document.createElement("div");
        menu.className = "dropdown-menu";
        menu.style.cssText = `
      position: fixed;
      background: var(--bg-secondary);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-md);
      padding: 6px;
      box-shadow: var(--shadow-lg);
      z-index: 500;
      min-width: 180px;
      animation: slideUp 0.2s ease;
    `;

        state.playlists.forEach((pl) => {
            const item = document.createElement("button");
            item.style.cssText = `
        display: block;
        width: 100%;
        padding: 8px 14px;
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 13px;
        font-family: var(--font);
        text-align: left;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: background 0.2s;
      `;
            item.textContent = pl.name;
            item.onmouseenter = () => (item.style.background = "var(--surface-hover)");
            item.onmouseleave = () => (item.style.background = "none");
            item.onclick = async () => {
                menu.remove();
                await addTrackToPlaylist(pl.id, track);
            };
            menu.appendChild(item);
        });

        const rect = anchorEl.getBoundingClientRect();
        document.body.appendChild(menu);
        menu.style.left = rect.left + "px";
        menu.style.top = rect.bottom + 4 + "px";

        // Close on click outside
        setTimeout(() => {
            const close = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener("click", close);
                }
            };
            document.addEventListener("click", close);
        }, 0);
    }

    async function addTrackToPlaylist(playlistId, track) {
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (!pl) return;

        // Avoid duplicates
        if (pl.tracks.some((t) => t.path === track.path)) {
            toast("歌曲已在播放列表中", "info");
            return;
        }

        pl.tracks.push(track);
        try {
            await api.put(`/api/playlists/${playlistId}`, { tracks: pl.tracks });
            toast(`已添加到「${pl.name}」`, "success");
            renderSidebarPlaylists();
            if (state.selectedPlaylist === playlistId) renderPlaylistDetail(pl);
        } catch (err) {
            toast("添加失败: " + err.message, "error");
        }
    }

    // ─── Playlists ───────────────────────────────────────────────
    async function loadPlaylists() {
        try {
            state.playlists = await api.get("/api/playlists");
            renderSidebarPlaylists();
        } catch (err) {
            toast("加载播放列表失败: " + err.message, "error");
        }
    }

    function renderSidebarPlaylists() {
        els.playlistList.innerHTML = state.playlists
            .map(
                (pl) => `
      <div class="playlist-item-sidebar ${state.selectedPlaylist === pl.id ? "active" : ""}" data-id="${pl.id}">
        <span>${pl.name}</span>
        <span class="track-count">${pl.tracks.length}</span>
      </div>`
            )
            .join("");

        els.playlistList.querySelectorAll(".playlist-item-sidebar").forEach((el) => {
            el.addEventListener("click", () => {
                state.selectedPlaylist = el.dataset.id;
                switchView("playlists");
                const pl = state.playlists.find((p) => p.id === el.dataset.id);
                if (pl) renderPlaylistDetail(pl);
            });
        });
    }

    function renderPlaylistsGrid() {
        state.selectedPlaylist = null;
        els.playlistViewTitle.textContent = "播放列表";
        els.playlistContent.innerHTML = "";

        if (state.playlists.length === 0) {
            els.playlistContent.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M21 15V6M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="9" x2="14" y2="9"/><line x1="2" y1="14" x2="10" y2="14"/></svg>
          <p>暂无播放列表</p>
          <p class="hint">点击"新建播放列表"创建一个</p>
        </div>`;
            return;
        }

        const grid = document.createElement("div");
        grid.className = "playlist-grid";

        state.playlists.forEach((pl) => {
            const card = document.createElement("div");
            card.className = "playlist-card";
            card.innerHTML = `
        <div class="playlist-card-name">${pl.name}</div>
        <div class="playlist-card-info">${pl.tracks.length} 首歌曲</div>
        <div class="playlist-card-actions">
          <button class="btn sm primary play-pl" data-id="${pl.id}">▶ 播放</button>
          <button class="btn sm danger del-pl" data-id="${pl.id}">删除</button>
        </div>
      `;
            card.addEventListener("click", (e) => {
                if (e.target.closest("button")) return;
                state.selectedPlaylist = pl.id;
                renderPlaylistDetail(pl);
            });
            grid.appendChild(card);
        });

        els.playlistContent.appendChild(grid);

        // Play playlist
        els.playlistContent.querySelectorAll(".play-pl").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!state.selectedDevice) {
                    toast("请先选择设备", "error");
                    return;
                }
                try {
                    await api.post(`/api/playlists/${btn.dataset.id}/play`, { deviceIP: state.selectedDevice });
                    toast("播放列表已开始播放", "success");
                    setTimeout(pollState, 500);
                } catch (err) {
                    toast("播放失败: " + err.message, "error");
                }
            });
        });

        // Delete playlist
        els.playlistContent.querySelectorAll(".del-pl").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!confirm("确认删除此播放列表？")) return;
                try {
                    await api.del(`/api/playlists/${btn.dataset.id}`);
                    state.playlists = state.playlists.filter((p) => p.id !== btn.dataset.id);
                    renderPlaylistsGrid();
                    renderSidebarPlaylists();
                    toast("播放列表已删除", "success");
                } catch (err) {
                    toast("删除失败: " + err.message, "error");
                }
            });
        });
    }

    function renderPlaylistDetail(pl) {
        els.playlistViewTitle.textContent = pl.name;
        els.playlistContent.innerHTML = "";

        const header = document.createElement("div");
        header.className = "playlist-detail-header";
        header.innerHTML = `
      <button class="back-btn" title="返回">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div>
        <h3 style="font-size:18px;font-weight:600;">${pl.name}</h3>
        <span style="font-size:12px;color:var(--text-muted)">${pl.tracks.length} 首歌曲</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button class="btn primary play-all">▶ 全部播放</button>
      </div>
    `;

        header.querySelector(".back-btn").addEventListener("click", () => {
            state.selectedPlaylist = null;
            renderPlaylistsGrid();
            renderSidebarPlaylists();
        });

        header.querySelector(".play-all").addEventListener("click", async () => {
            if (!state.selectedDevice) {
                toast("请先选择设备", "error");
                return;
            }
            try {
                await api.post(`/api/playlists/${pl.id}/play`, { deviceIP: state.selectedDevice });
                toast("播放列表已开始播放", "success");
                setTimeout(pollState, 500);
            } catch (err) {
                toast("播放失败: " + err.message, "error");
            }
        });

        els.playlistContent.appendChild(header);

        if (pl.tracks.length === 0) {
            els.playlistContent.innerHTML += `
        <div class="empty-state">
          <p>播放列表为空</p>
          <p class="hint">在音乐文件中点击"+ 列表"添加歌曲</p>
        </div>`;
            return;
        }

        const list = document.createElement("div");
        list.className = "playlist-track-list";

        pl.tracks.forEach((track, i) => {
            const el = document.createElement("div");
            el.className = "playlist-track";
            el.innerHTML = `
        <span class="track-number">${i + 1}</span>
        <span class="track-name">${track.name}</span>
        <span class="file-size">${formatSize(track.size)}</span>
        <button class="track-remove" data-idx="${i}" title="移除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
            list.appendChild(el);
        });

        els.playlistContent.appendChild(list);

        // Remove track
        list.querySelectorAll(".track-remove").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const idx = parseInt(btn.dataset.idx);
                pl.tracks.splice(idx, 1);
                try {
                    await api.put(`/api/playlists/${pl.id}`, { tracks: pl.tracks });
                    renderPlaylistDetail(pl);
                    renderSidebarPlaylists();
                    toast("已移除歌曲", "success");
                } catch (err) {
                    toast("移除失败: " + err.message, "error");
                }
            });
        });
    }

    // ─── Queue ───────────────────────────────────────────────────
    async function loadQueue() {
        if (!state.selectedDevice) {
            els.queueContent.innerHTML = '<div class="empty-state"><p>请先选择设备</p></div>';
            return;
        }
        try {
            const queue = await api.get(`/api/devices/${encodeURIComponent(state.selectedDevice)}/queue`);
            renderQueue(queue);
        } catch (err) {
            els.queueContent.innerHTML = '<div class="empty-state"><p>加载队列失败</p></div>';
        }
    }

    function renderQueue(queue) {
        const items = queue?.items || queue || [];
        if (!Array.isArray(items) || items.length === 0) {
            els.queueContent.innerHTML = '<div class="empty-state"><p>队列为空</p><p class="hint">播放音乐后会显示在这里</p></div>';
            return;
        }

        els.queueContent.innerHTML = items
            .map(
                (item, i) => `
      <div class="queue-item">
        <span class="queue-item-num">${i + 1}</span>
        <span class="queue-item-name">${item.title || item.Title || "未知"}</span>
        <span class="queue-item-artist">${item.artist || item.Artist || ""}</span>
      </div>`
            )
            .join("");
    }

    // ─── View Switching ──────────────────────────────────────────
    function switchView(view) {
        state.currentView = view;
        $$(".view").forEach((el) => el.classList.remove("active"));
        $(`#${view}View`).classList.add("active");
        $$(".nav-item").forEach((el) => el.classList.remove("active"));
        $$(`.nav-item[data-view="${view}"]`).forEach((el) => el.classList.add("active"));

        // Sync mobile bottom nav
        $$(".mobile-nav-item").forEach((el) => el.classList.remove("active"));
        $$(`.mobile-nav-item[data-view="${view}"]`).forEach((el) => el.classList.add("active"));

        // Show/hide sidebar playlists
        els.sidebarPlaylists.style.display = view === "playlists" ? "block" : "none";

        // Close mobile sidebar on navigation
        closeMobileSidebar();

        // Load view-specific data
        if (view === "playlists") {
            if (!state.selectedPlaylist) renderPlaylistsGrid();
        } else if (view === "queue") {
            loadQueue();
        }
    }

    // ─── Mobile Sidebar ──────────────────────────────────────────
    function openMobileSidebar() {
        $("#sidebar")?.classList.add("open");
        $("#sidebarBackdrop")?.classList.add("open");
    }

    function closeMobileSidebar() {
        $("#sidebar")?.classList.remove("open");
        $("#sidebarBackdrop")?.classList.remove("open");
    }

    // ─── Settings ────────────────────────────────────────────────
    async function loadConfig() {
        try {
            const cfg = await api.get("/api/config");
            els.musicDirInput.value = cfg.musicDir || "";
            els.serverAddr.textContent = `${location.hostname}:${location.port || 80}`;
        } catch { }
    }

    // ─── Event Bindings ──────────────────────────────────────────
    function bindEvents() {
        // Device selection
        els.deviceSelect.addEventListener("change", () => {
            state.selectedDevice = els.deviceSelect.value;
            if (state.selectedDevice) startPolling();
        });

        els.refreshDevices.addEventListener("click", () => loadDevices());

        // Navigation
        $$(".nav-item").forEach((btn) => {
            btn.addEventListener("click", () => switchView(btn.dataset.view));
        });

        // Player controls
        els.playPauseBtn.addEventListener("click", () => {
            const isPlaying = state.playState?.state === "playing";
            playerControl(isPlaying ? "pause" : "play");
        });
        els.prevBtn.addEventListener("click", () => playerControl("previous"));
        els.nextBtn.addEventListener("click", () => playerControl("next"));
        els.muteBtn.addEventListener("click", () => playerControl("mute"));

        // Volume
        let volumeDebounce;
        els.volumeBar.addEventListener("input", () => {
            clearTimeout(volumeDebounce);
            volumeDebounce = setTimeout(() => {
                playerControl("volume", { volume: parseInt(els.volumeBar.value) });
            }, 200);
        });

        // Progress seek (mouse + touch)
        let seeking = false;
        els.progressBar.addEventListener("mousedown", () => (seeking = true));
        els.progressBar.addEventListener("touchstart", () => (seeking = true), { passive: true });
        els.progressBar.addEventListener("mouseup", () => {
            seeking = false;
            playerControl("seek", { seconds: parseInt(els.progressBar.value) });
        });
        els.progressBar.addEventListener("touchend", () => {
            seeking = false;
            playerControl("seek", { seconds: parseInt(els.progressBar.value) });
        });
        els.progressBar.addEventListener("input", () => {
            if (seeking) {
                els.currentTime.textContent = formatTime(parseInt(els.progressBar.value));
            }
        });

        // ─── Mobile: sidebar toggle ──────────────────────────
        $("#mobileMenuBtn")?.addEventListener("click", () => {
            const sidebar = $("#sidebar");
            if (sidebar?.classList.contains("open")) {
                closeMobileSidebar();
            } else {
                openMobileSidebar();
            }
        });

        $("#sidebarBackdrop")?.addEventListener("click", closeMobileSidebar);

        // ─── Mobile: bottom nav ──────────────────────────────
        $$("#mobileBottomNav .mobile-nav-item[data-view]").forEach((btn) => {
            btn.addEventListener("click", () => switchView(btn.dataset.view));
        });

        // Mobile settings button
        $("#mobileSettingsBtn")?.addEventListener("click", () => {
            loadConfig();
            els.settingsModal.style.display = "flex";
        });

        // Settings modal
        els.settingsBtn.addEventListener("click", () => {
            loadConfig();
            els.settingsModal.style.display = "flex";
        });

        els.saveMusicDir.addEventListener("click", async () => {
            const dir = els.musicDirInput.value.trim();
            if (!dir) {
                toast("请输入目录路径", "error");
                return;
            }
            try {
                const res = await api.put("/api/config", { musicDir: dir });
                if (res.error) {
                    toast(res.error, "error");
                } else {
                    toast("音乐目录已更新", "success");
                    loadFiles();
                }
            } catch (err) {
                toast("保存失败: " + err.message, "error");
            }
        });

        // Create playlist modals
        const openCreateModal = () => {
            els.playlistNameInput.value = "";
            els.createPlaylistModal.style.display = "flex";
            setTimeout(() => els.playlistNameInput.focus(), 100);
        };

        $("#createPlaylistBtn")?.addEventListener("click", openCreateModal);
        $("#createPlaylistBtn2")?.addEventListener("click", openCreateModal);

        els.confirmCreatePlaylist.addEventListener("click", async () => {
            const name = els.playlistNameInput.value.trim();
            if (!name) {
                toast("请输入播放列表名称", "error");
                return;
            }
            try {
                const pl = await api.post("/api/playlists", { name });
                state.playlists.push(pl);
                renderSidebarPlaylists();
                if (state.currentView === "playlists") renderPlaylistsGrid();
                els.createPlaylistModal.style.display = "none";
                toast(`播放列表「${name}」已创建`, "success");
            } catch (err) {
                toast("创建失败: " + err.message, "error");
            }
        });

        // Enter key for playlist name
        els.playlistNameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") els.confirmCreatePlaylist.click();
        });

        // Close modals
        $$(".close-modal").forEach((btn) => {
            btn.addEventListener("click", () => {
                const modal = btn.dataset.modal;
                if (modal) $(`#${modal}`).style.display = "none";
            });
        });

        // Close modal on overlay click
        $$(".modal-overlay").forEach((overlay) => {
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) overlay.style.display = "none";
            });
        });

        // Clear queue
        els.clearQueueBtn.addEventListener("click", async () => {
            if (!state.selectedDevice) {
                toast("请先选择设备", "error");
                return;
            }
            try {
                await api.post(`/api/devices/${encodeURIComponent(state.selectedDevice)}/queue/clear`);
                toast("队列已清空", "success");
                loadQueue();
            } catch (err) {
                toast("清空失败: " + err.message, "error");
            }
        });
    }

    // ─── Init ────────────────────────────────────────────────────
    async function init() {
        bindEvents();
        await Promise.all([loadDevices(), loadFiles(), loadPlaylists(), loadConfig()]);
        if (state.selectedDevice) startPolling();
        switchView("files");
    }

    init();
})();
