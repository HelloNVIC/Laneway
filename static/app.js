/* ============================================================
   Laneway – 前端逻辑
   ============================================================ */

// ── 工具函数 ──────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + "/s";
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (h) parts.push(h + "时");
  if (m || h) parts.push(m + "分");
  parts.push(s + "秒");
  return "运行 " + parts.join("");
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    pdf: "📄", doc: "📝", docx: "📝", xls: "📊", xlsx: "📊", ppt: "📽️", pptx: "📽️",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️", bmp: "🖼️",
    mp4: "🎬", avi: "🎬", mkv: "🎬", mov: "🎬", webm: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵", aac: "🎵", ogg: "🎵",
    zip: "📦", rar: "📦", "7z": "📦", tar: "📦", gz: "📦",
    exe: "⚙️", msi: "⚙️", dmg: "⚙️", apk: "📱",
    py: "🐍", js: "🟨", ts: "🔷", html: "🌐", css: "🎨", json: "📋",
    txt: "📃", md: "📝", log: "📃", csv: "📊",
  };
  return map[ext] || "📎";
}

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ── DOM 引用 ──────────────────────────────────────────────────

const $online = document.getElementById("stat-online");
const $speed = document.getElementById("stat-speed");
const $active = document.getElementById("stat-active");
const $completed = document.getElementById("stat-completed");
const $totalBytes = document.getElementById("stat-total-bytes");
const $footerUptime = document.getElementById("footer-uptime");

const $dropZone = document.getElementById("drop-zone");
const $fileInput = document.getElementById("file-input");
const $uploadQueue = document.getElementById("upload-queue");

const $downloadFileList = document.getElementById("download-file-list");
const $uploadFileList = document.getElementById("upload-file-list");
const $downloadCount = document.getElementById("download-count");
const $uploadCount = document.getElementById("upload-count");
const $refreshBtn = document.getElementById("refresh-btn");

const $transferList = document.getElementById("transfer-list");
const $transferCount = document.getElementById("transfer-count");

const $lanUrl = document.getElementById("lan-url");
const $copyLanBtn = document.getElementById("copy-lan-btn");
let currentLanUrl = "";

// ── 局域网地址 ────────────────────────────────────────────────

async function loadAddress() {
  try {
    const resp = await fetch("/api/address");
    const data = await resp.json();
    currentLanUrl = data.lan_url;
    $lanUrl.textContent = currentLanUrl;
  } catch (err) {
    currentLanUrl = location.origin;
    $lanUrl.textContent = currentLanUrl;
  }
}

$copyLanBtn.addEventListener("click", async () => {
  const text = currentLanUrl || $lanUrl.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const input = document.createElement("input");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  const old = $copyLanBtn.textContent;
  $copyLanBtn.textContent = "已复制 ✓";
  $copyLanBtn.classList.add("copied");
  setTimeout(() => {
    $copyLanBtn.textContent = old;
    $copyLanBtn.classList.remove("copied");
  }, 1600);
});

loadAddress();

// ── 文件缓存 ──────────────────────────────────────────────────

let cachedFiles = { download: [], upload: [] };

// ── WebSocket 连接 ────────────────────────────────────────────

let ws;
let wsRetryDelay = 1000;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    wsRetryDelay = 1000;
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateStats(data);
    updateTransfers(data.transfers || []);
  };

  ws.onclose = () => {
    setTimeout(() => {
      wsRetryDelay = Math.min(wsRetryDelay * 1.5, 10000);
      connectWS();
    }, wsRetryDelay);
  };

  ws.onerror = () => ws.close();
}

connectWS();

// ── 状态更新 ──────────────────────────────────────────────────

function updateStats(data) {
  $online.textContent = data.online;
  $speed.textContent = formatSpeed(data.total_speed);
  $active.textContent = data.active_count;
  $completed.textContent = data.completed_count;
  $totalBytes.textContent = formatBytes(data.total_bytes);
  $footerUptime.textContent = formatUptime(data.uptime);
}

function updateTransfers(transfers) {
  $transferCount.textContent = transfers.length + " 个任务";

  if (transfers.length === 0) {
    $transferList.innerHTML = `
      <div class="empty-state small-empty">
        <span class="empty-icon">IDLE</span>
        <h3>通道空闲</h3>
        <p>上传或下载开始后，这里会显示文件名、速度和进度。</p>
      </div>`;
    return;
  }

  const existing = new Map();
  $transferList.querySelectorAll(".transfer-item").forEach((el) => {
    existing.set(el.dataset.id, el);
  });

  const fragment = document.createDocumentFragment();
  const used = new Set();

  for (const t of transfers) {
    used.add(t.id);
    let el = existing.get(t.id);
    if (el) {
      const fill = el.querySelector(".transfer-progress-fill");
      fill.style.width = t.percent.toFixed(1) + "%";
      el.querySelector(".transfer-stats").innerHTML =
        `<span>${t.percent.toFixed(1)}% · ${formatSpeed(t.speed)}</span>` +
        `<span>${formatBytes(t.transferred)} / ${formatBytes(t.total)}</span>`;
      fragment.appendChild(el);
    } else {
      el = document.createElement("div");
      el.className = "transfer-item";
      el.dataset.id = t.id;
      const dir = t.direction === "upload" ? "⬆️" : "⬇️";
      const cls = t.direction === "upload" ? "upload" : "download";
      el.innerHTML = `
        <span class="transfer-direction">${dir}</span>
        <div class="transfer-info">
          <div class="transfer-name">${escHtml(t.filename)}</div>
          <div class="transfer-progress-bar">
            <div class="transfer-progress-fill ${cls}" style="width:${t.percent.toFixed(1)}%"></div>
          </div>
          <div class="transfer-stats">
            <span>${t.percent.toFixed(1)}% · ${formatSpeed(t.speed)}</span>
            <span>${formatBytes(t.transferred)} / ${formatBytes(t.total)}</span>
          </div>
        </div>`;
      fragment.appendChild(el);
    }
  }

  $transferList.innerHTML = "";
  $transferList.appendChild(fragment);
}

// ── 文件列表 ──────────────────────────────────────────────────

async function loadFiles() {
  $refreshBtn.classList.add("spinning");
  try {
    const resp = await fetch("/api/files");
    const data = await resp.json();
    cachedFiles.download = data.download || [];
    cachedFiles.upload = data.upload || [];
    renderFileShelves();
  } finally {
    setTimeout(() => $refreshBtn.classList.remove("spinning"), 400);
  }
}

function renderFileShelves() {
  $downloadCount.textContent = cachedFiles.download.length + " 个文件";
  $uploadCount.textContent = cachedFiles.upload.length + " 个文件";
  renderFiles($downloadFileList, cachedFiles.download, "download");
  renderFiles($uploadFileList, cachedFiles.upload, "upload");
}

function renderFiles(container, files, kind) {
  if (files.length === 0) {
    const isDownload = kind === "download";
    container.innerHTML = `
      <div class="empty-state shelf-empty">
        <span class="empty-icon">${isDownload ? "DEPOT" : "INBOX"}</span>
        <h3>${isDownload ? "共享货架为空" : "还没有收到文件"}</h3>
        <p>${isDownload ? "把要分发的文件放进 download/ 文件夹，刷新后同网设备即可下载。" : "其他设备上传成功后，文件会出现在这里，并保存在 upload/ 文件夹。"}</p>
      </div>`;
    return;
  }

  container.innerHTML = files
    .map(
      (f) => `
    <div class="file-item">
      <div class="file-icon">${fileIcon(f.name)}</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
        <div class="file-meta">${formatBytes(f.size)} · ${formatTime(f.mtime)}</div>
      </div>
      <button class="file-action download-btn" data-url="${f.url}" data-name="${escHtml(f.name)}">
        下载文件
      </button>
    </div>`
    )
    .join("");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".download-btn");
  if (btn) {
    const a = document.createElement("a");
    a.href = btn.dataset.url;
    a.download = btn.dataset.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});

$refreshBtn.addEventListener("click", loadFiles);
loadFiles();

// ── 拖放上传 ──────────────────────────────────────────────────

$dropZone.addEventListener("click", () => $fileInput.click());
$dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $fileInput.click();
  }
});

$dropZone.addEventListener("dragenter", (e) => {
  e.preventDefault();
  $dropZone.classList.add("drag-over");
});
$dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  $dropZone.classList.add("drag-over");
});
$dropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  $dropZone.classList.remove("drag-over");
});
$dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  $dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) {
    uploadFiles(e.dataTransfer.files);
  }
});

$fileInput.addEventListener("change", () => {
  if ($fileInput.files.length) {
    uploadFiles($fileInput.files);
    $fileInput.value = "";
  }
});

// ── 上传逻辑 ──────────────────────────────────────────────────

function uploadFiles(fileList) {
  for (const file of fileList) {
    uploadOneFile(file);
  }
}

function uploadOneFile(file) {
  const el = document.createElement("div");
  el.className = "queue-item";
  el.innerHTML = `
    <div class="queue-item-header">
      <span class="queue-item-name">${escHtml(file.name)}</span>
      <span class="queue-item-size">${formatBytes(file.size)}</span>
      <span class="queue-item-status status-uploading">入站中</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" style="width:0%"></div>
    </div>
    <div class="queue-item-detail">
      <span class="queue-percent">0%</span>
      <span class="queue-speed"></span>
    </div>`;
  $uploadQueue.prepend(el);

  const xhr = new XMLHttpRequest();
  const started = Date.now();

  xhr.upload.addEventListener("progress", (e) => {
    if (!e.lengthComputable) return;
    const pct = (e.loaded / e.total) * 100;
    el.querySelector(".progress-bar-fill").style.width = pct.toFixed(1) + "%";
    el.querySelector(".queue-percent").textContent = pct.toFixed(1) + "%";
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed > 0.5) {
      el.querySelector(".queue-speed").textContent = formatSpeed(e.loaded / elapsed);
    }
  });

  xhr.addEventListener("load", () => {
    const status = el.querySelector(".queue-item-status");
    if (xhr.status >= 200 && xhr.status < 300) {
      status.textContent = "完成 ✓";
      status.className = "queue-item-status status-done";
      el.querySelector(".progress-bar-fill").style.width = "100%";
      el.querySelector(".queue-percent").textContent = "100%";
      loadFiles();
    } else {
      status.textContent = "失败 ✗";
      status.className = "queue-item-status status-error";
    }
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.4s";
      setTimeout(() => el.remove(), 400);
    }, 3000);
  });

  xhr.addEventListener("error", () => {
    const status = el.querySelector(".queue-item-status");
    status.textContent = "失败 ✗";
    status.className = "queue-item-status status-error";
  });

  xhr.open("POST", "/upload");
  const formData = new FormData();
  formData.append("file", file);
  xhr.send(formData);
}

// ── 定期刷新文件列表 ──────────────────────────────────────────
setInterval(loadFiles, 15000);
