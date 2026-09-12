// AVFenix Studio - GTK 3 / WebKit Frontend Controller
let socket;
let monacoEditor;
let monacoDiffEditor;

// File Tree State
let fileTreeData = [];
let expandedFolders = new Set(); // Preserves expanded folder paths across re-renders

// Tab Manager State
let openTabs = [];
let activeTabId = null;
let tabCounter = 1;

let xterm;
let xtermFitAddon;
let gitStatusData = null;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    initUIControls();
    initMonaco();
    initMarked();
    initFileTreeDelegation();
});

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
        wsStatusIndicator.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span class="text-green-500">Conectado</span>
        `;
        socket.send(JSON.stringify({ action: "get_files" }));
        socket.send(JSON.stringify({ action: "git_status" }));
        socket.send(JSON.stringify({ action: "init_pty" }));
        initXterm();
    };

    socket.onclose = () => {
        wsStatusIndicator.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-red-500"></span>
            <span class="text-red-500">Desconectado</span>
        `;
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
                    fileTreeData = msg.files;
                    renderFileTree();
                    break;

                case "file_content":
                    onFileContentLoaded(msg.filepath, msg.content);
                    break;

                case "save_success":
                    onFileSavedSuccess(msg.filepath);
                    break;

                case "delete_success":
                    showNotification(`Archivo '${msg.filepath}' eliminado.`, "info");
                    closeTabByFilepath(msg.filepath);
                    socket.send(JSON.stringify({ action: "get_files" }));
                    socket.send(JSON.stringify({ action: "git_status" }));
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
                    if (msg.result.status === "success") {
                        showNotification(msg.result.message, "success");
                    } else {
                        showNotification(msg.result.message, "error");
                    }
                    socket.send(JSON.stringify({ action: "git_status" }));
                    break;

                case "chat_reply":
                    removeChatLoading();
                    addAIMessage(msg.message);
                    break;
            }
        } catch (e) {
            console.error("Error dispatching WS message:", e);
        }
    };
}

// 2. Monaco Editor Initialization & Tab Integration
function initMonaco() {
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

        // Listen for content changes in active tab
        monacoEditor.onDidChangeModelContent(() => {
            const tab = getActiveTab();
            if (tab && !tab.isDirtyLoading) {
                tab.isDirty = true;
                tab.content = monacoEditor.getValue();
                renderTabBar();
            }
        });

        // Global Keybindings for Save (Ctrl+S) and New (Ctrl+N)
        window.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveActiveFile();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                createNewTab();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
                e.preventDefault();
                if (activeTabId) closeTab(activeTabId);
            }
        });

        // Create initial default active tab "Sin título - 1"
        createNewTab();
    });
}

// 3. Integrated Terminal
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

// 4. File Tree View Generation & Event Delegation
function renderFileTree() {
    const container = document.getElementById("file-tree");
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
        const escapedPath = fullPath.replace(/"/g, "&quot;");
        const escapedName = name.replace(/</g, "&lt;").replace(/>/g, "&gt;");

        if (isFolder) {
            const isExpanded = expandedFolders.has(fullPath);
            const hiddenClass = isExpanded ? "" : "hidden";
            const arrowRotation = isExpanded ? "rotate(0deg)" : "rotate(-90deg)";

            let html = `
                <div class="tree-node-folder flex flex-col">
                    <button data-action="toggle-folder" data-path="${escapedPath}" class="w-full text-left px-2 py-1 rounded text-gray-300 font-bold flex items-center space-x-1.5 focus:outline-none hover:bg-[#2a2a2a]">
                        <i class="fa-solid fa-chevron-down text-[10px] text-gray-500 transition-transform duration-100" style="transform: ${arrowRotation}"></i>
                        <i class="fa-solid fa-folder text-amber-500 text-xs"></i>
                        <span class="truncate text-xs">${escapedName}</span>
                    </button>
                    <div class="pl-4 flex flex-col space-y-1 tree-folder-content ${hiddenClass}">
            `;
            const keys = Object.keys(node).sort((a, b) => {
                const aIsFolder = node[a] !== null;
                const bIsFolder = node[b] !== null;
                if (aIsFolder && !bIsFolder) return -1;
                if (!aIsFolder && bIsFolder) return 1;
                return a.localeCompare(b);
            });

            keys.forEach(childName => {
                html += generateHTML(node[childName], childName, fullPath);
            });
            html += `</div></div>`;
            return html;
        } else {
            return `
                <button data-action="open-file" data-path="${escapedPath}" class="tree-node-file w-full text-left px-2 py-0.5 rounded flex items-center space-x-2 focus:outline-none text-gray-400 hover:bg-[#2a2a2a]">
                    <i class="fa-regular fa-file text-[#e25c34] text-xs"></i>
                    <span class="truncate text-xs">${escapedName}</span>
                </button>
            `;
        }
    }

    let treeHTML = "";
    const rootKeys = Object.keys(treeRoot).sort((a, b) => {
        const aIsFolder = treeRoot[a] !== null;
        const bIsFolder = treeRoot[b] !== null;
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return a.localeCompare(b);
    });

    rootKeys.forEach(name => {
        treeHTML += generateHTML(treeRoot[name], name);
    });
    container.innerHTML = treeHTML;
}

function initFileTreeDelegation() {
    const container = document.getElementById("file-tree");
    if (!container) return;

    container.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        
        const action = btn.getAttribute("data-action");
        const path = btn.getAttribute("data-path");

        if (action === "toggle-folder") {
            const content = btn.nextElementSibling;
            const arrow = btn.querySelector(".fa-chevron-down");
            if (content.classList.contains("hidden")) {
                content.classList.remove("hidden");
                if (arrow) arrow.style.transform = "rotate(0deg)";
                expandedFolders.add(path);
            } else {
                content.classList.add("hidden");
                if (arrow) arrow.style.transform = "rotate(-90deg)";
                expandedFolders.delete(path);
            }
        } else if (action === "open-file") {
            openFile(path);
        }
    });
}

// 5. Tab System Manager & File Operations
function createNewTab(filepath = null, content = "") {
    const isNew = !filepath;
    const tabName = filepath ? filepath.split("/").pop() : `Sin título - ${tabCounter++}`;
    const id = `tab_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    const newTab = {
        id: id,
        filepath: filepath || tabName,
        title: tabName,
        content: content,
        isNew: isNew,
        isDirty: false,
        isDirtyLoading: false,
        language: getFileLanguage(filepath || tabName)
    };

    openTabs.push(newTab);
    switchTab(id);
    renderTabBar();
    return newTab;
}

function switchTab(tabId) {
    const tab = openTabs.find(t => t.id === tabId);
    if (!tab) return;

    activeTabId = tabId;
    activeFilePath = tab.isNew ? null : tab.filepath;

    document.getElementById("current-file-label").textContent = tab.filepath;
    updateActiveContextLabel(tab.filepath);

    if (monacoEditor) {
        tab.isDirtyLoading = true;
        const model = monaco.editor.createModel(tab.content, tab.language);
        monacoEditor.setModel(model);
        tab.isDirtyLoading = false;
    }

    renderTabBar();
}

function closeTab(tabId) {
    const index = openTabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    openTabs.splice(index, 1);

    if (openTabs.length === 0) {
        createNewTab();
    } else {
        const nextActive = openTabs[Math.max(0, index - 1)];
        switchTab(nextActive.id);
    }
}

function closeTabByFilepath(filepath) {
    const tab = openTabs.find(t => t.filepath === filepath);
    if (tab) closeTab(tab.id);
}

function getActiveTab() {
    return openTabs.find(t => t.id === activeTabId);
}

function renderTabBar() {
    const container = document.getElementById("tab-bar");
    if (!container) return;
    container.innerHTML = "";

    openTabs.forEach(tab => {
        const isActive = tab.id === activeTabId;
        const activeClass = isActive ? "active" : "";
        const dirtyIndicator = tab.isDirty ? '<span class="text-[#e25c34] font-bold ml-1">•</span>' : '';
        const escapedTitle = tab.title.replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const tabDiv = document.createElement("div");
        tabDiv.className = `tab-item flex items-center space-x-1 px-3 py-1 text-xs cursor-pointer ${activeClass}`;
        tabDiv.innerHTML = `
            <i class="fa-regular fa-file text-[10px]"></i>
            <span class="truncate max-w-[120px]">${escapedTitle}</span>
            ${dirtyIndicator}
            <button data-close-tab="${tab.id}" class="tab-item-close ml-1.5 focus:outline-none">
                <i class="fa-solid fa-xmark text-[10px]"></i>
            </button>
        `;

        tabDiv.addEventListener("click", (e) => {
            if (e.target.closest("[data-close-tab]")) {
                e.stopPropagation();
                closeTab(tab.id);
            } else {
                switchTab(tab.id);
            }
        });

        container.appendChild(tabDiv);
    });
}

function openFile(filepath) {
    const existingTab = openTabs.find(t => t.filepath === filepath);
    if (existingTab) {
        switchTab(existingTab.id);
    } else {
        socket.send(JSON.stringify({ action: "read_file", filepath: filepath }));
    }
}

function onFileContentLoaded(filepath, content) {
    const activeTab = getActiveTab();
    if (activeTab && activeTab.isNew && !activeTab.isDirty && activeTab.content === "") {
        activeTab.filepath = filepath;
        activeTab.title = filepath.split("/").pop();
        activeTab.content = content;
        activeTab.isNew = false;
        activeTab.language = getFileLanguage(filepath);
        switchTab(activeTab.id);
    } else {
        const existingTab = openTabs.find(t => t.filepath === filepath);
        if (existingTab) {
            existingTab.content = content;
            switchTab(existingTab.id);
        } else {
            createNewTab(filepath, content);
        }
    }
}

function saveActiveFile() {
    const tab = getActiveTab();
    if (!tab) return;

    let targetPath = tab.filepath;
    if (tab.isNew) {
        const inputPath = prompt("Ingrese la ruta y nombre para guardar el archivo:", tab.title);
        if (!inputPath || !inputPath.trim()) return;
        targetPath = inputPath.trim();
    }

    const currentContent = monacoEditor.getValue();
    socket.send(JSON.stringify({
        action: "save_file",
        filepath: targetPath,
        content: currentContent
    }));
}

function onFileSavedSuccess(filepath) {
    showNotification(`Archivo '${filepath}' guardado.`, "success");
    const tab = openTabs.find(t => t.filepath === filepath || (t.isNew && t.id === activeTabId));
    if (tab) {
        tab.filepath = filepath;
        tab.title = filepath.split("/").pop();
        tab.isNew = false;
        tab.isDirty = false;
        tab.language = getFileLanguage(filepath);
        renderTabBar();
    }
    socket.send(JSON.stringify({ action: "get_files" }));
    socket.send(JSON.stringify({ action: "git_status" }));
}

function getFileLanguage(filepath) {
    if (!filepath) return 'javascript';
    if (filepath.endsWith('.py')) return 'python';
    if (filepath.endsWith('.html')) return 'html';
    if (filepath.endsWith('.css')) return 'css';
    if (filepath.endsWith('.json')) return 'json';
    if (filepath.endsWith('.sh')) return 'shell';
    if (filepath.endsWith('.md')) return 'markdown';
    return 'javascript';
}

function updateActiveContextLabel(filepath) {
    const label = document.getElementById("chat-active-file-label");
    if (label) {
        label.textContent = filepath ? `Contexto: ${filepath}` : "Sin archivo activo";
    }
}

// 6. Monaco Diff System
function openDiffProposal(filepath, newContent) {
    const diffContainer = document.getElementById("diff-editor-container");
    const diffLabel = document.getElementById("diff-file-label");
    
    if (diffLabel) diffLabel.textContent = filepath;
    if (diffContainer) diffContainer.classList.remove("hidden");

    let originalContent = "";
    if (monacoEditor) {
        originalContent = monacoEditor.getValue();
    }

    let language = getFileLanguage(filepath);
    const originalModel = monaco.editor.createModel(originalContent, language);
    const modifiedModel = monaco.editor.createModel(newContent, language);
    monacoDiffEditor.setModel({ original: originalModel, modified: modifiedModel });

    document.getElementById("btn-diff-accept").onclick = () => {
        socket.send(JSON.stringify({
            action: "save_file",
            filepath: filepath,
            content: newContent
        }));
        diffContainer.classList.add("hidden");
        showNotification(`Propuesta del Copiloto aplicada a ${filepath}`, "success");
        addSystemMessage(`Cambios aceptados y escritos en: ${filepath}`);
    };

    document.getElementById("btn-diff-decline").onclick = () => {
        diffContainer.classList.add("hidden");
        showNotification("Cambios propuestos rechazados.", "info");
        addSystemMessage(`Cambios propuestos para ${filepath} rechazados.`);
    };
}

// 7. Git Integration Panel View
function renderGitStatus() {
    const branchLabel = document.getElementById("git-branch");
    const aheadLabel = document.getElementById("git-ahead");
    const behindLabel = document.getElementById("git-behind");
    const filesList = document.getElementById("git-files-list");

    if (!gitStatusData || !gitStatusData.is_repo) {
        if (branchLabel) branchLabel.textContent = "No es un repositorio de Git";
        if (aheadLabel) aheadLabel.textContent = "0";
        if (behindLabel) behindLabel.textContent = "0";
        if (filesList) filesList.innerHTML = `<div class="text-gray-500 italic p-1">No hay inicializado ningún repositorio Git</div>`;
        return;
    }

    if (branchLabel) branchLabel.textContent = gitStatusData.branch;
    if (aheadLabel) aheadLabel.textContent = gitStatusData.ahead;
    if (behindLabel) behindLabel.textContent = gitStatusData.behind;
    if (filesList) filesList.innerHTML = "";

    const hasModified = gitStatusData.modified.length > 0;
    const hasStaged = gitStatusData.staged.length > 0;
    const hasUntracked = gitStatusData.untracked.length > 0;

    if (!hasModified && !hasStaged && !hasUntracked) {
        if (filesList) filesList.innerHTML = `<div class="text-gray-500 italic p-1">Sin modificaciones pendientes</div>`;
        return;
    }

    gitStatusData.modified.forEach(file => {
        filesList.appendChild(createGitFileRow(file, "modified"));
    });

    gitStatusData.staged.forEach(file => {
        filesList.appendChild(createGitFileRow(file, "staged"));
    });

    gitStatusData.untracked.forEach(file => {
        filesList.appendChild(createGitFileRow(file, "untracked"));
    });
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

    const escapedPath = filepath.replace(/"/g, "&quot;");

    div.innerHTML = `
        <span class="truncate pr-2 text-gray-300 font-mono text-[11px]" title="${escapedPath}">${filepath}</span>
        <div class="flex items-center space-x-2">
            <span class="git-file-status-badge ${badgeClass}">${statusChar}</span>
            ${status !== 'staged' ? `
            <button class="text-[10px] text-[#e25c34] hover:underline" data-stage="${escapedPath}">Prepa</button>
            ` : ''}
        </div>
    `;

    div.addEventListener("click", (e) => {
        const stageBtn = e.target.closest("[data-stage]");
        if (stageBtn) {
            stageFile(stageBtn.getAttribute("data-stage"));
        } else {
            openFile(filepath);
        }
    });

    return div;
}

function stageFile(filepath) {
    socket.send(JSON.stringify({ action: "git_stage", filepath: filepath }));
}

// 8. Navigation Controls
function initUIControls() {
    const explorerBtn = document.getElementById("btn-nav-explorer");
    const gitBtn = document.getElementById("btn-nav-git");
    const explorerPanel = document.getElementById("panel-explorer");
    const gitPanel = document.getElementById("panel-git");

    if (explorerBtn && gitBtn) {
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

    const btnNewTab = document.getElementById("btn-new-tab");
    if (btnNewTab) btnNewTab.addEventListener("click", () => createNewTab());

    const btnCreateExplorer = document.getElementById("btn-create-file-explorer");
    if (btnCreateExplorer) btnCreateExplorer.addEventListener("click", () => createNewTab());

    const btnSaveTab = document.getElementById("btn-save-tab");
    if (btnSaveTab) btnSaveTab.addEventListener("click", saveActiveFile);

    const btnStageAll = document.getElementById("btn-git-stage-all");
    if (btnStageAll) btnStageAll.addEventListener("click", () => socket.send(JSON.stringify({ action: "git_stage_all" })));

    const btnGitCommit = document.getElementById("btn-git-commit");
    if (btnGitCommit) {
        btnGitCommit.addEventListener("click", () => {
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

    const btnGitPull = document.getElementById("btn-git-pull");
    if (btnGitPull) btnGitPull.addEventListener("click", () => socket.send(JSON.stringify({ action: "git_pull" })));

    const btnGitPush = document.getElementById("btn-git-push");
    if (btnGitPush) btnGitPush.addEventListener("click", () => socket.send(JSON.stringify({ action: "git_push" })));

    const btnGitRefresh = document.getElementById("btn-git-refresh");
    if (btnGitRefresh) btnGitRefresh.addEventListener("click", () => socket.send(JSON.stringify({ action: "git_status" })));

    const btnRefreshFiles = document.getElementById("btn-refresh-files");
    if (btnRefreshFiles) btnRefreshFiles.addEventListener("click", () => socket.send(JSON.stringify({ action: "get_files" })));

    const btnTermClear = document.getElementById("btn-term-clear");
    if (btnTermClear) btnTermClear.addEventListener("click", () => { if (xterm) xterm.clear(); });

    // Chat form
    const chatForm = document.getElementById("chat-form");
    if (chatForm) {
        chatForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const chatInput = document.getElementById("chat-input");
            const userMsg = chatInput ? chatInput.value.trim() : "";
            if (!userMsg) return;

            addUserMessage(userMsg);
            if (chatInput) chatInput.value = "";

            const modelSelect = document.getElementById("chat-model-select");
            const selectedModel = modelSelect ? modelSelect.value : "openrouter/free";

            const sendContextCheck = document.getElementById("chat-context-checkbox");
            const sendContext = sendContextCheck ? sendContextCheck.checked : true;

            let contextPayload = null;
            if (sendContext && monacoEditor) {
                const activeTab = getActiveTab();
                contextPayload = {
                    filepath: activeFilePath || (activeTab ? activeTab.title : "Unsaved File"),
                    language: activeTab ? activeTab.language : "text",
                    content: monacoEditor.getValue()
                };
            }

            showChatLoading();
            socket.send(JSON.stringify({
                action: "chat_msg",
                message: userMsg,
                model: selectedModel,
                context: contextPayload
            }));
        });
    }
}

// 9. Chat UI Messages Helpers
function addUserMessage(text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "flex space-x-2 items-start justify-end";
    div.innerHTML = `
        <div class="bg-[#e25c34] text-white p-2.5 rounded-lg text-gray-200 max-w-[85%]">
            ${text}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addAIMessage(text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "flex space-x-2 items-start";

    let formattedText = text;
    if (window.marked) {
        try {
            formattedText = marked.parse(text);
        } catch (e) {
            formattedText = text;
        }
    }

    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34]">
            <i class="fa-solid fa-robot text-[11px]"></i>
        </div>
        <div class="bg-[#242424] p-2.5 rounded-lg border border-[#333333] text-gray-300 max-w-[85%] chat-markdown-body">
            ${formattedText}
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
            ${text}
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
    div.className = "flex space-x-2 items-start";
    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34]">
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
    toast.className = `fixed bottom-4 right-4 ${color} text-white text-xs px-4 py-2.5 rounded shadow-lg z-50 animate-bounce`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

function jsonParseSafe(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}