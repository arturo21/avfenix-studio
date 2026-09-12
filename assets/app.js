// AVFenix Studio - GTK 3 / WebKit Frontend Controller
let socket;
let monacoEditor;
let monacoDiffEditor;
let xterm;
let xtermFitAddon;
let fileTreeData = [];
let gitStatusData = null;
let expandedFolders = new Set();

// Tab Manager State
let tabs = [];
let activeTabId = null;
let activeFilePath = null;
let untitledCounter = 1;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    initUIControls();
    initMonaco();
    initMarked();
});

// Configure Marked.js
function initMarked() {
    if (window.marked) {
        marked.setOptions({
            highlight: function(code, lang) {
                if (window.hljs && lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return code;
            },
            breaks: true
        });
    }
}

// 1. WebSocket Connectivity
function initWebSocket() {
    const wsStatusIndicator = document.getElementById("ws-status");
    socket = new WebSocket("ws://127.0.0.1:8765");

    socket.onopen = () => {
        if (wsStatusIndicator) {
            wsStatusIndicator.innerHTML = `
                <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                <span class="text-green-500 font-medium">Conectado</span>
            `;
        }
        socket.send(JSON.stringify({ action: "get_files" }));
        socket.send(JSON.stringify({ action: "git_status" }));
        socket.send(JSON.stringify({ action: "init_pty" }));
        initXterm();
    };

    socket.onclose = () => {
        if (wsStatusIndicator) {
            wsStatusIndicator.innerHTML = `
                <span class="w-2 h-2 rounded-full bg-red-500"></span>
                <span class="text-red-500 font-medium">Desconectado</span>
            `;
        }
        setTimeout(initWebSocket, 3000);
    };

    socket.onerror = (err) => {
        console.error("WebSocket connection error:", err);
    };

    socket.onmessage = async (event) => {
        const rawMsg = event.data;

        if (rawMsg.startsWith("term_data:")) {
            const data = rawMsg.substring("term_data:".length);
            if (xterm) xterm.write(data);
            return;
        }

        try {
            const msg = jsonParseSafe(rawMsg);
            if (!msg) return;

            switch (msg.action) {
                case "file_list":
                    fileTreeData = msg.files || [];
                    renderFileTree();
                    break;

                case "file_content":
                    onFileContentLoaded(msg.filepath, msg.content);
                    break;

                case "save_success":
                    onSaveSuccess(msg.filepath);
                    break;

                case "delete_success":
                    onDeleteSuccess(msg.filepath);
                    break;

                case "write_proposal":
                    openDiffProposal(msg.filepath, msg.content);
                    break;

                case "delete_proposal":
                    socket.send(JSON.stringify({
                        action: "trigger_delete_dialog",
                        filepath: msg.filepath
                    }));
                    break;

                case "delete_file_approved":
                    socket.send(JSON.stringify({
                        action: "delete_file_confirm",
                        filepath: msg.filepath
                    }));
                    break;

                case "delete_file_denied":
                    showNotification(`Eliminación de ${msg.filepath} cancelada.`, "info");
                    addSystemMessage(`Eliminación de ${msg.filepath} cancelada por el usuario.`);
                    break;

                case "git_status":
                    gitStatusData = msg.status;
                    renderGitStatus();
                    break;

                case "git_result":
                    if (msg.result && msg.result.status === "success") {
                        showNotification(msg.result.message, "success");
                    } else if (msg.result) {
                        showNotification(msg.result.message, "error");
                    }
                    socket.send(JSON.stringify({ action: "git_status" }));
                    break;

                case "chat_reply":
                    removeChatLoading();
                    addAIMessage(msg.message);
                    break;

                case "error":
                    showNotification(`Error: ${msg.message}`, "error");
                    break;
            }
        } catch (e) {
            console.error("Error dispatching WS message:", e);
        }
    };
}

// 2. Monaco Editor & Tab System
function initMonaco() {
    if (typeof require === "undefined") return;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        monacoEditor = monaco.editor.create(document.getElementById('editor-container'), {
            value: '',
            language: 'javascript',
            theme: 'vs-dark',
            automaticLayout: true,
            fontSize: 13,
            tabSize: 4,
            minimap: { enabled: true }
        });

        monacoDiffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor-body'), {
            theme: 'vs-dark',
            automaticLayout: true,
            readOnly: true,
            fontSize: 13
        });

        initTabSystem();
    });
}

function initTabSystem() {
    if (tabs.length === 0) {
        createNewUntitledTab();
    }
}

function createNewUntitledTab(initialContent = "", language = "python") {
    const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const title = `Sin título - ${untitledCounter++}`;

    let model = null;
    if (window.monaco && monaco.editor) {
        model = monaco.editor.createModel(initialContent, language);
        model.onDidChangeContent(() => markTabDirty(tabId));
    }

    const tabObj = {
        id: tabId,
        filepath: null,
        title: title,
        isNew: true,
        isDirty: initialContent ? true : false,
        content: initialContent,
        model: model,
        language: language
    };

    tabs.push(tabObj);
    switchTab(tabId);
}

function markTabDirty(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (tab && !tab.isDirty) {
        tab.isDirty = true;
        renderTabBar();
    }
}

function switchTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    activeTabId = tabId;
    activeFilePath = tab.filepath;

    if (monacoEditor && tab.model) {
        monacoEditor.setModel(tab.model);
    }

    updateHeaderFileLabels();
    renderTabBar();
}

function closeTab(tabId, skipConfirmation = false) {
    const index = tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    const tab = tabs[index];
    if (tab.isDirty && !skipConfirmation) {
        if (!confirm(`¿Desea cerrar '${tab.title}' sin guardar los cambios?`)) {
            return;
        }
    }

    if (tab.model) {
        tab.model.dispose();
    }

    tabs.splice(index, 1);

    if (tabs.length === 0) {
        createNewUntitledTab();
    } else {
        const nextIndex = Math.max(0, index - 1);
        switchTab(tabs[nextIndex].id);
    }
}

function renderTabBar() {
    const bar = document.getElementById("tab-bar");
    if (!bar) return;
    bar.innerHTML = "";

    tabs.forEach(tab => {
        const isActive = tab.id === activeTabId;
        const dirtyDot = tab.isDirty ? '<span class="w-1.5 h-1.5 rounded-full bg-[#e25c34] inline-block ml-1" title="Cambios sin guardar"></span>' : '';
        const activeBg = isActive ? 'bg-[#1e1e1e] text-white border-t-2 border-[#e25c34]' : 'bg-[#222222] text-gray-400 hover:bg-[#282828] hover:text-gray-200';

        const el = document.createElement("div");
        el.className = `px-3 py-1 text-xs rounded-t flex items-center space-x-2 cursor-pointer border-r border-[#2d2d2d] flex-shrink-0 font-mono transition-all ${activeBg}`;
        el.innerHTML = `
            <i class="fa-regular fa-file-code text-[11px] ${isActive ? 'text-[#e25c34]' : 'text-gray-500'}"></i>
            <span class="truncate max-w-[120px]" title="${escapeAttr(tab.filepath || tab.title)}">${escapeHTML(tab.title)}</span>
            ${dirtyDot}
            <button class="ml-1 text-gray-500 hover:text-red-400 focus:outline-none text-[10px] p-0.5 rounded" title="Cerrar (Ctrl+W)" data-tab-close="${tab.id}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;

        el.addEventListener("click", (e) => {
            if (e.target.closest('[data-tab-close]')) {
                e.stopPropagation();
                closeTab(tab.id);
            } else {
                switchTab(tab.id);
            }
        });

        bar.appendChild(el);
    });
}

function updateHeaderFileLabels() {
    const topLabel = document.getElementById("current-file-label");
    const chatActiveLabel = document.getElementById("active-tab-label");
    const activeTab = tabs.find(t => t.id === activeTabId);

    const displayName = activeTab ? (activeTab.filepath || activeTab.title) : "Sin archivo activo";

    if (topLabel) topLabel.textContent = displayName;
    if (chatActiveLabel) {
        chatActiveLabel.textContent = displayName;
        chatActiveLabel.title = displayName;
    }
}

// 3. Opening & Saving Files
function openFile(filepath) {
    const existingTab = tabs.find(t => t.filepath === filepath);
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }

    socket.send(JSON.stringify({ action: "read_file", filepath: filepath }));
}

function onFileContentLoaded(filepath, content) {
    const filename = filepath.split('/').pop();
    const lang = getFileLanguage(filepath);

    let model = null;
    if (window.monaco && monaco.editor) {
        model = monaco.editor.createModel(content, lang);
    }

    const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    if (model) {
        model.onDidChangeContent(() => markTabDirty(tabId));
    }

    const newTab = {
        id: tabId,
        filepath: filepath,
        title: filename,
        isNew: false,
        isDirty: false,
        content: content,
        model: model,
        language: lang
    };

    const currentTab = tabs.find(t => t.id === activeTabId);
    if (currentTab && currentTab.isNew && !currentTab.isDirty) {
        const val = currentTab.model ? currentTab.model.getValue() : "";
        if (val === "") {
            closeTab(currentTab.id, true);
        }
    }

    tabs.push(newTab);
    switchTab(tabId);
}

function saveActiveFile() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    let targetPath = tab.filepath;
    const content = tab.model ? tab.model.getValue() : (monacoEditor ? monacoEditor.getValue() : "");

    if (tab.isNew || !targetPath) {
        let suggested = tab.title.startsWith("Sin título") ? "nuevo_archivo.py" : tab.title;
        let userInput = prompt("Guardar archivo como (ingrese ruta o nombre de archivo):", suggested);
        if (!userInput) return;
        userInput = userInput.trim();
        if (!userInput) return;

        targetPath = userInput;
        tab.filepath = targetPath;
        tab.title = targetPath.split('/').pop();
        tab.isNew = false;
        tab.language = getFileLanguage(targetPath);

        if (tab.model && window.monaco && monaco.editor) {
            monaco.editor.setModelLanguage(tab.model, tab.language);
        }

        activeFilePath = targetPath;
        updateHeaderFileLabels();
    }

    socket.send(JSON.stringify({
        action: "save_file",
        filepath: targetPath,
        content: content
    }));
}

function onSaveSuccess(filepath) {
    const tab = tabs.find(t => t.filepath === filepath);
    if (tab) {
        tab.isDirty = false;
        tab.isNew = false;
        renderTabBar();
    }

    showNotification(`Archivo '${filepath}' guardado correctamente.`, "success");
    socket.send(JSON.stringify({ action: "get_files" }));
    socket.send(JSON.stringify({ action: "git_status" }));
}

function onDeleteSuccess(filepath) {
    showNotification(`Archivo '${filepath}' eliminado.`, "info");
    const tab = tabs.find(t => t.filepath === filepath);
    if (tab) {
        closeTab(tab.id, true);
    }
    socket.send(JSON.stringify({ action: "get_files" }));
    socket.send(JSON.stringify({ action: "git_status" }));
}

// 4. Xterm.js Terminal
function initXterm() {
    if (xterm) return;

    xterm = new Terminal({
        cols: 80,
        rows: 24,
        theme: {
            background: '#141414',
            foreground: '#d4d4d4',
            cursor: '#e25c34'
        },
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'Courier New, monospace'
    });

    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
        xtermFitAddon = new FitAddon.FitAddon();
    } else if (typeof window.FitAddon !== 'undefined' && window.FitAddon.FitAddon) {
        xtermFitAddon = new window.FitAddon.FitAddon();
    }

    if (xtermFitAddon) {
        xterm.loadAddon(xtermFitAddon);
    }

    xterm.open(document.getElementById('terminal-body'));
    if (xtermFitAddon) xtermFitAddon.fit();

    xterm.onData(data => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(`term_data:${data}`);
        }
    });

    window.addEventListener("resize", () => {
        if (xtermFitAddon) {
            xtermFitAddon.fit();
            const dims = xtermFitAddon.proposeDimensions();
            if (dims && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(`term_resize:${dims.cols},${dims.rows}`);
            }
        }
    });
}

// 5. File Tree Rendering with Event Delegation & State Preservation
function renderFileTree() {
    const container = document.getElementById("file-tree");
    if (!container) return;
    container.innerHTML = "";

    if (fileTreeData.length === 0) {
        container.innerHTML = `<div class="text-gray-500 italic text-center text-xs p-2">Sin archivos en el proyecto</div>`;
        return;
    }

    const treeRoot = {};
    fileTreeData.forEach(path => {
        const parts = path.split("/");
        let current = treeRoot;
        parts.forEach((part, idx) => {
            if (!current[part]) {
                current[part] = idx === parts.length - 1 ? null : {};
            }
            current = current[part];
        });
    });

    function generateHTML(node, name, currentPath = "") {
        const fullPath = currentPath ? `${currentPath}/${name}` : name;
        const isFolder = node !== null;

        if (isFolder) {
            const isExpanded = expandedFolders.has(fullPath);
            const hiddenClass = isExpanded ? "" : "hidden";
            const rotation = isExpanded ? "rotate(0deg)" : "rotate(-90deg)";

            let html = `
                <div class="tree-node-folder flex flex-col">
                    <button data-action="toggle-folder" data-path="${escapeAttr(fullPath)}" class="tree-folder-btn w-full text-left px-2 py-1 rounded text-gray-300 font-bold flex items-center space-x-1.5 focus:outline-none hover:bg-[#2a2a2a] transition-colors">
                        <i class="fa-solid fa-chevron-down text-[10px] text-gray-500 transition-transform duration-100" style="transform: ${rotation};"></i>
                        <i class="fa-solid fa-folder text-amber-500 text-xs"></i>
                        <span class="truncate text-xs">${escapeHTML(name)}</span>
                    </button>
                    <div class="pl-4 flex flex-col space-y-1 tree-folder-content ${hiddenClass}">
            `;
            
            const keys = Object.keys(node).sort((a, b) => {
                const aFolder = node[a] !== null;
                const bFolder = node[b] !== null;
                if (aFolder && !bFolder) return -1;
                if (!aFolder && bFolder) return 1;
                return a.localeCompare(b);
            });

            keys.forEach(childName => {
                html += generateHTML(node[childName], childName, fullPath);
            });

            html += `</div></div>`;
            return html;
        } else {
            return `
                <button data-action="open-file" data-path="${escapeAttr(fullPath)}" class="tree-node-file w-full text-left px-2 py-0.5 rounded flex items-center space-x-2 focus:outline-none text-gray-400 hover:bg-[#2a2a2a] transition-colors">
                    <i class="fa-regular fa-file text-[#e25c34] text-xs"></i>
                    <span class="truncate text-xs">${escapeHTML(name)}</span>
                </button>
            `;
        }
    }

    let treeHTML = "";
    const rootKeys = Object.keys(treeRoot).sort((a, b) => {
        const aFolder = treeRoot[a] !== null;
        const bFolder = treeRoot[b] !== null;
        if (aFolder && !bFolder) return -1;
        if (!aFolder && bFolder) return 1;
        return a.localeCompare(b);
    });

    rootKeys.forEach(name => {
        treeHTML += generateHTML(treeRoot[name], name);
    });

    container.innerHTML = treeHTML;
}

// 6. Monaco Diff System
function openDiffProposal(filepath, newContent) {
    const diffContainer = document.getElementById("diff-editor-container");
    const diffLabel = document.getElementById("diff-file-label");
    
    if (diffLabel) diffLabel.textContent = filepath;
    if (diffContainer) diffContainer.classList.remove("hidden");

    let originalContent = "";
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.filepath === filepath) {
        originalContent = activeTab.model ? activeTab.model.getValue() : activeTab.content;
    }

    const language = getFileLanguage(filepath);
    let originalModel = null;
    let modifiedModel = null;

    if (window.monaco && monaco.editor) {
        originalModel = monaco.editor.createModel(originalContent, language);
        modifiedModel = monaco.editor.createModel(newContent, language);
        monacoDiffEditor.setModel({ original: originalModel, modified: modifiedModel });
    }

    document.getElementById("btn-diff-accept").onclick = () => {
        socket.send(JSON.stringify({
            action: "save_file",
            filepath: filepath,
            content: newContent
        }));
        diffContainer.classList.add("hidden");
        showNotification(`Propuesta del Copiloto aplicada a ${filepath}`, "success");
        addSystemMessage(`Cambios aceptados y guardados en: ${filepath}`);
    };

    document.getElementById("btn-diff-decline").onclick = () => {
        diffContainer.classList.add("hidden");
        showNotification("Cambios propuestos rechazados.", "info");
        addSystemMessage(`Cambios propuestos para ${filepath} rechazados.`);
    };
}

// 7. Git Integration View
function renderGitStatus() {
    const branchLabel = document.getElementById("git-branch");
    const aheadLabel = document.getElementById("git-ahead");
    const behindLabel = document.getElementById("git-behind");
    const filesList = document.getElementById("git-files-list");

    if (!filesList) return;

    if (!gitStatusData || !gitStatusData.is_repo) {
        if (branchLabel) branchLabel.textContent = "No es repositorio Git";
        if (aheadLabel) aheadLabel.textContent = "0";
        if (behindLabel) behindLabel.textContent = "0";
        filesList.innerHTML = `<div class="text-gray-500 italic p-1">Sin repositorio Git</div>`;
        return;
    }

    if (branchLabel) branchLabel.textContent = gitStatusData.branch;
    if (aheadLabel) aheadLabel.textContent = gitStatusData.ahead;
    if (behindLabel) behindLabel.textContent = gitStatusData.behind;
    filesList.innerHTML = "";

    const hasModified = gitStatusData.modified && gitStatusData.modified.length > 0;
    const hasStaged = gitStatusData.staged && gitStatusData.staged.length > 0;
    const hasUntracked = gitStatusData.untracked && gitStatusData.untracked.length > 0;

    if (!hasModified && !hasStaged && !hasUntracked) {
        filesList.innerHTML = `<div class="text-gray-500 italic p-1">Sin cambios pendientes</div>`;
        return;
    }

    if (gitStatusData.modified) gitStatusData.modified.forEach(f => filesList.appendChild(createGitFileRow(f, "modified")));
    if (gitStatusData.staged) gitStatusData.staged.forEach(f => filesList.appendChild(createGitFileRow(f, "staged")));
    if (gitStatusData.untracked) gitStatusData.untracked.forEach(f => filesList.appendChild(createGitFileRow(f, "untracked")));
}

function createGitFileRow(filepath, status) {
    const div = document.createElement("div");
    div.className = "flex items-center justify-between p-1 bg-[#1e1e1e] hover:bg-[#252525] rounded mb-1 border border-[#2b2b2b]";
    
    let badgeClass = "git-badge-modified";
    let statusChar = "M";
    if (status === "staged") {
        badgeClass = "git-badge-staged";
        statusChar = "A";
    } else if (status === "untracked") {
        badgeClass = "git-badge-untracked";
        statusChar = "?";
    }

    div.innerHTML = `
        <span class="truncate pr-2 text-gray-300 font-mono text-[11px]" title="${escapeAttr(filepath)}">${escapeHTML(filepath)}</span>
        <div class="flex items-center space-x-2">
            <span class="git-file-status-badge ${badgeClass}">${statusChar}</span>
            ${status !== 'staged' ? `
            <button class="text-[10px] text-[#e25c34] hover:underline" onclick="stageFile('${escapeAttr(filepath)}')">Prepa</button>
            ` : ''}
        </div>
    `;
    return div;
}

function stageFile(filepath) {
    socket.send(JSON.stringify({ action: "git_stage", filepath: filepath }));
}

// 8. Navigation & Controls Setup
function initUIControls() {
    const explorerBtn = document.getElementById("btn-nav-explorer");
    const gitBtn = document.getElementById("btn-nav-git");
    const explorerPanel = document.getElementById("panel-explorer");
    const gitPanel = document.getElementById("panel-git");

    if (explorerBtn && gitBtn && explorerPanel && gitPanel) {
        explorerBtn.addEventListener("click", () => {
            explorerBtn.classList.add("bg-[#2d2d2d]", "text-[#e25c34]");
            gitBtn.classList.remove("bg-[#2d2d2d]", "text-[#e25c34]");
            gitBtn.classList.add("text-gray-400");
            explorerPanel.classList.remove("hidden");
            gitPanel.classList.add("hidden");
        });

        gitBtn.addEventListener("click", () => {
            gitBtn.classList.add("bg-[#2d2d2d]", "text-[#e25c34]");
            explorerBtn.classList.remove("bg-[#2d2d2d]", "text-[#e25c34]");
            explorerBtn.classList.add("text-gray-400");
            gitPanel.classList.remove("hidden");
            explorerPanel.classList.add("hidden");
        });
    }

    // Delegated File Tree Event Listener
    const fileTreeContainer = document.getElementById("file-tree");
    if (fileTreeContainer) {
        fileTreeContainer.addEventListener("click", (e) => {
            const folderBtn = e.target.closest('[data-action="toggle-folder"]');
            if (folderBtn) {
                e.stopPropagation();
                const folderPath = folderBtn.getAttribute("data-path");
                const content = folderBtn.nextElementSibling;
                const arrow = folderBtn.querySelector(".fa-chevron-down");

                if (expandedFolders.has(folderPath)) {
                    expandedFolders.delete(folderPath);
                    if (content) content.classList.add("hidden");
                    if (arrow) arrow.style.transform = "rotate(-90deg)";
                } else {
                    expandedFolders.add(folderPath);
                    if (content) content.classList.remove("hidden");
                    if (arrow) arrow.style.transform = "rotate(0deg)";
                }
                return;
            }

            const fileBtn = e.target.closest('[data-action="open-file"]');
            if (fileBtn) {
                e.stopPropagation();
                const filePath = fileBtn.getAttribute("data-path");
                openFile(filePath);
            }
        });
    }

    // Editor Header Actions (Save & New File)
    const btnSave = document.getElementById("btn-save-file");
    if (btnSave) {
        btnSave.addEventListener("click", () => saveActiveFile());
    }

    const btnNewTab = document.getElementById("btn-new-file");
    if (btnNewTab) {
        btnNewTab.addEventListener("click", () => createNewUntitledTab());
    }

    const btnExplorerNewFile = document.getElementById("btn-explorer-new-file");
    if (btnExplorerNewFile) {
        btnExplorerNewFile.addEventListener("click", () => createNewUntitledTab());
    }

    // Git Sync Actions
    if (document.getElementById("btn-git-stage-all")) {
        document.getElementById("btn-git-stage-all").addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_stage_all" }));
        });
    }

    if (document.getElementById("btn-git-commit")) {
        document.getElementById("btn-git-commit").addEventListener("click", () => {
            const msgInput = document.getElementById("git-commit-message");
            const msg = msgInput ? msgInput.value.trim() : "";
            if (!msg) {
                showNotification("Debes escribir un mensaje de commit", "error");
                return;
            }
            socket.send(JSON.stringify({ action: "git_commit", message: msg }));
            if (msgInput) msgInput.value = "";
        });
    }

    if (document.getElementById("btn-git-pull")) {
        document.getElementById("btn-git-pull").addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_pull" }));
        });
    }

    if (document.getElementById("btn-git-push")) {
        document.getElementById("btn-git-push").addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_push" }));
        });
    }

    if (document.getElementById("btn-git-refresh")) {
        document.getElementById("btn-git-refresh").addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_status" }));
        });
    }

    if (document.getElementById("btn-refresh-files")) {
        document.getElementById("btn-refresh-files").addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "get_files" }));
        });
    }

    if (document.getElementById("btn-term-clear")) {
        document.getElementById("btn-term-clear").addEventListener("click", () => {
            if (xterm) xterm.clear();
        });
    }

    // Global Keyboard Shortcuts (Ctrl+S, Ctrl+N, Ctrl+W)
    window.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            saveActiveFile();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
            e.preventDefault();
            createNewUntitledTab();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
            e.preventDefault();
            if (activeTabId) closeTab(activeTabId);
        }
    });

    // Chat form submit
    const chatForm = document.getElementById("chat-form");
    if (chatForm) {
        chatForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const chatInput = document.getElementById("chat-input");
            const userMsg = chatInput ? chatInput.value.trim() : "";
            if (!userMsg) return;

            const selectedModel = document.getElementById("chat-model-select")?.value || "openrouter/free";
            const includeContext = document.getElementById("cb-include-context")?.checked ?? true;

            let contextObj = null;
            const activeTab = tabs.find(t => t.id === activeTabId);

            if (includeContext && activeTab) {
                const currentContent = activeTab.model ? activeTab.model.getValue() : activeTab.content;
                contextObj = {
                    filepath: activeTab.filepath,
                    content: currentContent,
                    language: activeTab.language || getFileLanguage(activeTab.filepath)
                };
            }

            addUserMessage(userMsg, contextObj ? contextObj.filepath : null);
            if (chatInput) chatInput.value = "";

            showChatLoading();
            socket.send(JSON.stringify({
                action: "chat_msg",
                message: userMsg,
                model: selectedModel,
                context: contextObj
            }));
        });
    }
}

// 9. Chat UI Helpers & Utilities
function addUserMessage(text, contextFile) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const div = document.createElement("div");
    div.className = "flex flex-col items-end space-y-1 my-1";
    
    let contextBadge = "";
    if (contextFile) {
        contextBadge = `
            <span class="text-[10px] bg-[#222222] text-[#e25c34] border border-[#e25c34]/30 px-2 py-0.5 rounded font-mono">
                <i class="fa-solid fa-file-code mr-1"></i>${escapeHTML(contextFile)}
            </span>
        `;
    }

    div.innerHTML = `
        ${contextBadge}
        <div class="bg-[#e25c34] text-white p-2.5 rounded-lg text-xs max-w-[85%] leading-relaxed shadow">
            ${escapeHTML(text)}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addAIMessage(text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const div = document.createElement("div");
    div.className = "flex space-x-2 items-start my-1";
    
    let parsedHTML = escapeHTML(text);
    if (window.marked) {
        try {
            parsedHTML = marked.parse(text);
        } catch (e) {
            console.error("Marked parsing error:", e);
        }
    }

    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34] border border-[#e25c34]/30">
            <i class="fa-solid fa-robot text-[11px]"></i>
        </div>
        <div class="bg-[#242424] p-2.5 rounded-lg border border-[#333333] text-gray-200 max-w-[85%] text-xs chat-markdown-body overflow-x-auto shadow">
            ${parsedHTML}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addSystemMessage(text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const div = document.createElement("div");
    div.className = "flex justify-center my-1";
    div.innerHTML = `
        <div class="bg-[#1c1c1c] text-gray-500 text-[10px] px-2 py-1 rounded border border-[#2d2d2d] font-mono italic">
            ${escapeHTML(text)}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function showChatLoading() {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const div = document.createElement("div");
    div.id = "chat-loading-bubble";
    div.className = "flex space-x-2 items-start my-1";
    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34] border border-[#e25c34]/30">
            <i class="fa-solid fa-robot text-[11px]"></i>
        </div>
        <div class="bg-[#242424] p-2.5 rounded-lg border border-[#333333] text-gray-300 chat-loading-dots">
            <span></span><span></span><span></span>
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function removeChatLoading() {
    const bubble = document.getElementById("chat-loading-bubble");
    if (bubble) bubble.remove();
}

function showNotification(msg, type = "info") {
    let color = "bg-blue-600";
    if (type === "success") color = "bg-green-600";
    else if (type === "error") color = "bg-red-600";

    const toast = document.createElement("div");
    toast.className = `fixed bottom-4 right-4 ${color} text-white text-xs px-4 py-2.5 rounded shadow-lg z-50 animate-bounce font-mono`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
}

function getFileLanguage(filepath) {
    if (!filepath) return "javascript";
    if (filepath.endsWith('.py')) return 'python';
    if (filepath.endsWith('.js')) return 'javascript';
    if (filepath.endsWith('.html')) return 'html';
    if (filepath.endsWith('.css')) return 'css';
    if (filepath.endsWith('.json')) return 'json';
    if (filepath.endsWith('.sh')) return 'shell';
    if (filepath.endsWith('.md')) return 'markdown';
    if (filepath.endsWith('.c') || filepath.endsWith('.h')) return 'c';
    if (filepath.endsWith('.cpp')) return 'cpp';
    return 'text';
}

function escapeHTML(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeAttr(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function jsonParseSafe(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}