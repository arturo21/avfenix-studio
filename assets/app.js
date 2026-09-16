// AVFenix Studio - GTK 3 / WebKit Frontend Controller
let socket;
let monacoEditor;
let monacoDiffEditor;
let xterm;
let xtermFitAddon;
let fileTreeData = [];
let gitStatusData = null;

// Multi-Tab Document State Manager
let tabs = [];
let activeTabId = null;
let tabCounter = 1;
let expandedFolders = new Set();

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    initUIControls();
    initMonaco();
    initMarked();
});

// Configure Marked.js for Markdown Rendering in Chat
function initMarked() {
    if (window.marked) {
        try {
            marked.setOptions({
                highlight: function(code, lang) {
                    if (window.hljs && lang && hljs.getLanguage(lang)) {
                        return hljs.highlight(code, { language: lang }).value;
                    }
                    return code;
                },
                breaks: true
            });
        } catch (e) {
            console.warn("Marked setup warning:", e);
        }
    }
}

// 1. WebSocket Connectivity & Dispatcher
function initWebSocket() {
    const wsStatusIndicator = document.getElementById("ws-status");
    socket = new WebSocket("ws://127.0.0.1:8765");

    socket.onopen = () => {
        if (wsStatusIndicator) {
            wsStatusIndicator.innerHTML = `
                <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                <span class="text-green-500">Conectado</span>
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
                <span class="text-red-500">Desconectado</span>
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
                    onFileContentLoaded(msg.filepath, msg.content || "");
                    break;

                case "save_success":
                    onSaveSuccess(msg.filepath);
                    break;

                case "delete_success":
                    showNotification(`Archivo '${msg.filepath}' eliminado.`, "info");
                    onFileDeleted(msg.filepath);
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
            }
        } catch (e) {
            console.error("Error handling WS message:", e);
        }
    };
}

// 2. Monaco Editor & Diff Setup
function initMonaco() {
    if (typeof require === 'undefined') return;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        monacoEditor = monaco.editor.create(document.getElementById('editor-container'), {
            value: [
                '// Bienvenido a AVFenix Studio IDE',
                '// Selecciona un archivo del explorador o crea una pestaña nueva para comenzar.'
            ].join('\n'),
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

        if (tabs.length === 0) {
            createNewUntitledTab();
        }
    });
}

// 3. Multi-Tab System
function createNewUntitledTab(initialContent = "") {
    const title = `Sin título - ${tabCounter++}`;
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const language = "javascript";

    let model = null;
    if (typeof monaco !== 'undefined' && monaco.editor) {
        model = monaco.editor.createModel(initialContent || "// Escribe tu código aquí...\n", language);
        attachModelListeners(model, tabId);
    }

    const tab = {
        id: tabId,
        filepath: null,
        title: title,
        content: initialContent,
        isNew: true,
        isDirty: false,
        language: language,
        model: model
    };

    tabs.push(tab);
    switchTab(tabId);
}

function attachModelListeners(model, tabId) {
    if (!model || model.hasChangeListener) return;
    model.hasChangeListener = true;
    model.onDidChangeContent(() => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            if (!tab.isDirty) {
                tab.isDirty = true;
                renderTabBar();
            }
            tab.content = model.getValue();
        }
    });
}

function switchTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    activeTabId = tabId;

    if (monacoEditor && tab.model) {
        monacoEditor.setModel(tab.model);
    }

    updateHeaderActiveLabels(tab);
    renderTabBar();
    renderFileTree();
}

function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tabToClose = tabs[idx];
    if (tabToClose.isDirty) {
        const confirmClose = confirm(`El archivo '${tabToClose.title}' tiene cambios no guardados. ¿Deseas cerrarlo de todos modos?`);
        if (!confirmClose) return;
    }

    if (tabToClose.model) {
        try { tabToClose.model.dispose(); } catch (e) {}
    }

    tabs.splice(idx, 1);

    if (tabs.length === 0) {
        activeTabId = null;
        createNewUntitledTab();
    } else {
        const nextTab = tabs[Math.max(0, idx - 1)];
        switchTab(nextTab.id);
    }
}

function closeTabByFilepath(filepath) {
    const tab = tabs.find(t => t.filepath === filepath);
    if (tab) closeTab(tab.id);
}

function renderTabBar() {
    const tabBar = document.getElementById("tab-bar");
    if (!tabBar) return;

    tabBar.innerHTML = "";
    tabs.forEach(tab => {
        const isActive = tab.id === activeTabId;
        const activeClass = isActive ? "bg-[#1e1e1e] text-[#e25c34] font-semibold border-t-2 border-[#e25c34]" : "bg-[#2a2a2a] text-gray-400 hover:bg-[#333333]";
        const dirtyIndicator = tab.isDirty ? `<span class="text-[#e25c34] font-bold ml-1">•</span>` : "";

        const tabElem = document.createElement("div");
        tabElem.className = `editor-tab flex items-center space-x-1.5 px-3 py-1 text-xs rounded-t font-mono cursor-pointer border-r border-[#1a1a1a] flex-shrink-0 transition-colors ${activeClass}`;
        
        tabElem.innerHTML = `
            <i class="fa-solid fa-file-code text-[11px] ${isActive ? 'text-[#e25c34]' : 'text-gray-500'}"></i>
            <span class="truncate max-w-[120px]">${escapeHTML(tab.title)}</span>
            ${dirtyIndicator}
            <button data-action="close-tab" data-tab-id="${tab.id}" class="ml-1 text-gray-500 hover:text-white text-xs rounded p-0.5 focus:outline-none" title="Cerrar (Ctrl+W)">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;

        tabElem.addEventListener("click", (e) => {
            if (e.target.closest('[data-action="close-tab"]')) {
                e.stopPropagation();
                closeTab(tab.id);
            } else {
                switchTab(tab.id);
            }
        });

        tabBar.appendChild(tabElem);
    });
}

function updateHeaderActiveLabels(tab) {
    const topLabel = document.getElementById("current-file-label");
    const activeTabLabel = document.getElementById("chat-active-file-label");

    const displayName = tab ? (tab.filepath || tab.title) : "Sin archivo abierto";

    if (topLabel) topLabel.textContent = displayName;
    if (activeTabLabel) {
        activeTabLabel.textContent = displayName;
        activeTabLabel.title = displayName;
    }
}

// 4. Opening and Saving Files
function openFile(filepath) {
    if (!filepath) return;

    const existingTab = tabs.find(t => t.filepath === filepath);
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }

    socket.send(JSON.stringify({ action: "read_file", filepath: filepath }));
}

function onFileContentLoaded(filepath, content) {
    const filename = filepath.split("/").pop();
    const language = getFileLanguage(filepath);

    let model = null;
    if (typeof monaco !== 'undefined' && monaco.editor) {
        model = monaco.editor.createModel(content, language);
    }

    const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    const newTab = {
        id: tabId,
        filepath: filepath,
        title: filename,
        content: content,
        isNew: false,
        isDirty: false,
        language: language,
        model: model
    };

    if (model) {
        attachModelListeners(model, tabId);
    }

    // Replace default untouched blank tab if open
    const currentTab = tabs.find(t => t.id === activeTabId);
    if (currentTab && currentTab.isNew && !currentTab.isDirty) {
        const val = currentTab.model ? currentTab.model.getValue() : "";
        if (val === "" || val.startsWith("// Bienvenido")) {
            if (currentTab.model) currentTab.model.dispose();
            const idx = tabs.findIndex(t => t.id === currentTab.id);
            if (idx !== -1) tabs.splice(idx, 1);
        }
    }

    tabs.push(newTab);
    switchTab(tabId);
}

function saveActiveFile() {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab || !monacoEditor) return;

    let filepath = activeTab.filepath;

    if (activeTab.isNew || !filepath) {
        const userPath = prompt("Ingresa la ruta o nombre para guardar el archivo:", activeTab.title.startsWith("Sin título") ? "nuevo_archivo.py" : activeTab.title);
        if (!userPath || !userPath.trim()) return;
        
        filepath = userPath.trim();
        activeTab.filepath = filepath;
        activeTab.title = filepath.split("/").pop();
        activeTab.isNew = false;

        const lang = getFileLanguage(filepath);
        activeTab.language = lang;
        if (activeTab.model && monaco.editor) {
            monaco.editor.setModelLanguage(activeTab.model, lang);
        }
    }

    const currentContent = activeTab.model ? activeTab.model.getValue() : monacoEditor.getValue();
    activeTab.content = currentContent;

    socket.send(JSON.stringify({
        action: "save_file",
        filepath: filepath,
        content: currentContent
    }));
}

function onSaveSuccess(filepath) {
    const tab = tabs.find(t => t.filepath === filepath);
    if (tab) {
        tab.isDirty = false;
        tab.isNew = false;
        renderTabBar();
        updateHeaderActiveLabels(tab);
    }

    showNotification(`Archivo '${filepath}' guardado en disco.`, "success");
    socket.send(JSON.stringify({ action: "get_files" }));
    socket.send(JSON.stringify({ action: "git_status" }));
}

function onFileDeleted(filepath) {
    const tab = tabs.find(t => t.filepath === filepath);
    if (tab) closeTab(tab.id);
}

// 5. File Tree View Generation & Event Delegation
function renderFileTree() {
    const container = document.getElementById("file-tree");
    if (!container) return;
    container.innerHTML = "";

    if (!fileTreeData || fileTreeData.length === 0) {
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
            if (current[part] !== null) {
                current = current[part];
            }
        });
    });

    function generateHTML(node, name, currentPath = "") {
        const fullPath = currentPath ? `${currentPath}/${name}` : name;
        const isFolder = node !== null;

        if (isFolder) {
            const isExpanded = expandedFolders.has(fullPath);
            return `
                <div class="tree-node-folder flex flex-col">
                    <button data-action="toggle-folder" data-path="${escapeAttr(fullPath)}" class="w-full text-left px-2 py-1 rounded text-gray-300 font-bold flex items-center space-x-1.5 focus:outline-none hover:bg-[#2a2a2a] transition-colors">
                        <i class="fa-solid fa-chevron-down text-[10px] text-gray-500 transition-transform duration-100" style="transform: ${isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'};"></i>
                        <i class="fa-solid fa-folder text-amber-500 text-xs"></i>
                        <span class="truncate text-xs">${escapeHTML(name)}</span>
                    </button>
                    <div class="pl-3 flex flex-col space-y-0.5 tree-folder-content ${isExpanded ? '' : 'hidden'}">
                        ${Object.keys(node).sort((a, b) => {
                            const aFolder = node[a] !== null;
                            const bFolder = node[b] !== null;
                            if (aFolder && !bFolder) return -1;
                            if (!aFolder && bFolder) return 1;
                            return a.localeCompare(b);
                        }).map(child => generateHTML(node[child], child, fullPath)).join('')}
                    </div>
                </div>
            `;
        } else {
            const activeTab = tabs.find(t => t.id === activeTabId);
            const isActive = activeTab && activeTab.filepath === fullPath;
            const activeClass = isActive ? "bg-[#2d2d2d] text-[#e25c34] font-semibold" : "text-gray-400 hover:bg-[#2a2a2a]";

            return `
                <button data-action="open-file" data-path="${escapeAttr(fullPath)}" class="tree-node-file w-full text-left px-2 py-0.5 rounded flex items-center space-x-2 focus:outline-none transition-colors ${activeClass}">
                    <i class="fa-regular fa-file text-[#e25c34] text-xs"></i>
                    <span class="truncate text-xs">${escapeHTML(name)}</span>
                </button>
            `;
        }
    }

    const rootKeys = Object.keys(treeRoot).sort((a, b) => {
        const aFolder = treeRoot[a] !== null;
        const bFolder = treeRoot[b] !== null;
        if (aFolder && !bFolder) return -1;
        if (!aFolder && bFolder) return 1;
        return a.localeCompare(b);
    });

    container.innerHTML = rootKeys.map(name => generateHTML(treeRoot[name], name)).join('');
}

// 6. Monaco Diff System (AI Proposal Review)
function openDiffProposal(filepath, newContent) {
    const diffContainer = document.getElementById("diff-editor-container");
    const diffLabel = document.getElementById("diff-file-label");
    
    if (diffLabel) diffLabel.textContent = filepath;
    if (diffContainer) diffContainer.classList.remove("hidden");

    let originalContent = "";
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.model) {
        originalContent = activeTab.model.getValue();
    } else if (monacoEditor) {
        originalContent = monacoEditor.getValue();
    }

    let language = getFileLanguage(filepath);

    // Dispose old diff models safely
    if (monacoDiffEditor) {
        const oldModels = monacoDiffEditor.getModel();
        if (oldModels) {
            if (oldModels.original) try { oldModels.original.dispose(); } catch(e) {}
            if (oldModels.modified) try { oldModels.modified.dispose(); } catch(e) {}
        }
    }

    const originalModel = monaco.editor.createModel(originalContent, language);
    const modifiedModel = monaco.editor.createModel(newContent, language);

    if (monacoDiffEditor) {
        monacoDiffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });
        monacoDiffEditor.layout();
    }

    const cleanupDiff = () => {
        if (diffContainer) diffContainer.classList.add("hidden");
        if (monacoDiffEditor) {
            monacoDiffEditor.setModel(null);
        }
        try { originalModel.dispose(); } catch(e) {}
        try { modifiedModel.dispose(); } catch(e) {}

        if (monacoEditor) {
            setTimeout(() => {
                monacoEditor.layout();
                monacoEditor.focus();
            }, 50);
        }
    };

    const btnAccept = document.getElementById("btn-diff-accept");
    if (btnAccept) {
        btnAccept.onclick = () => {
            socket.send(JSON.stringify({
                action: "save_file",
                filepath: filepath,
                content: newContent
            }));

            // Live update active tab or create tab
            let tabToUpdate = tabs.find(t => t.filepath === filepath);
            if (tabToUpdate) {
                tabToUpdate.content = newContent;
                tabToUpdate.isDirty = false;
                tabToUpdate.isNew = false;
                if (tabToUpdate.model) {
                    tabToUpdate.model.setValue(newContent);
                }
                switchTab(tabToUpdate.id);
            } else {
                const activeTab = tabs.find(t => t.id === activeTabId);
                if (activeTab && activeTab.isNew && !activeTab.isDirty && (!activeTab.model || activeTab.model.getValue().trim() === "")) {
                    activeTab.filepath = filepath;
                    activeTab.title = filepath.split("/").pop();
                    activeTab.content = newContent;
                    activeTab.isNew = false;
                    activeTab.isDirty = false;
                    if (activeTab.model) {
                        activeTab.model.setValue(newContent);
                    }
                    switchTab(activeTab.id);
                } else {
                    onFileContentLoaded(filepath, newContent);
                }
            }

            cleanupDiff();
            showNotification(`Propuesta del Copiloto aplicada a ${filepath}`, "success");
            addSystemMessage(`Cambios aceptados y escritos en: ${filepath}`);
        };
    }

    const btnDecline = document.getElementById("btn-diff-decline");
    if (btnDecline) {
        btnDecline.onclick = () => {
            cleanupDiff();
            showNotification("Cambios propuestos rechazados.", "info");
            addSystemMessage(`Cambios propuestos para ${filepath} rechazados.`);
        };
    }
}

// 7. Integrated Xterm.js Terminal
function initXterm() {
    if (xterm) return;

    try {
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

        const termContainer = document.getElementById('terminal-body');
        if (termContainer) {
            xterm.open(termContainer);
            if (xtermFitAddon && xtermFitAddon.fit) {
                xtermFitAddon.fit();
            }
        }

        xterm.onData(data => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(`term_data:${data}`);
            }
        });

        window.addEventListener("resize", () => {
            if (xtermFitAddon && xtermFitAddon.fit) {
                xtermFitAddon.fit();
                const dims = xtermFitAddon.proposeDimensions ? xtermFitAddon.proposeDimensions() : null;
                if (dims && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(`term_resize:${dims.cols},${dims.rows}`);
                }
            }
        });
    } catch (err) {
        console.error("Xterm initialization error:", err);
    }
}

// 8. Git Integration Panel
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

    if (gitStatusData.modified) gitStatusData.modified.forEach(file => filesList.appendChild(createGitFileRow(file, "modified")));
    if (gitStatusData.staged) gitStatusData.staged.forEach(file => filesList.appendChild(createGitFileRow(file, "staged")));
    if (gitStatusData.untracked) gitStatusData.untracked.forEach(file => filesList.appendChild(createGitFileRow(file, "untracked")));
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

// 9. Navigation & UI Controls (Delegated Events)
function initUIControls() {
    // Explorer Event Delegation
    const fileTreeContainer = document.getElementById("file-tree");
    if (fileTreeContainer) {
        fileTreeContainer.addEventListener("click", (e) => {
            const folderBtn = e.target.closest('[data-action="toggle-folder"]');
            if (folderBtn) {
                e.stopPropagation();
                const folderPath = folderBtn.getAttribute("data-path");
                if (expandedFolders.has(folderPath)) {
                    expandedFolders.delete(folderPath);
                } else {
                    expandedFolders.add(folderPath);
                }
                renderFileTree();
                return;
            }

            const fileBtn = e.target.closest('[data-action="open-file"]');
            if (fileBtn) {
                e.stopPropagation();
                const filePath = fileBtn.getAttribute("data-path");
                openFile(filePath);
                return;
            }
        });
    }

    // Action Buttons
    const btnNewFile = document.getElementById("btn-new-file");
    if (btnNewFile) btnNewFile.addEventListener("click", () => createNewUntitledTab());

    const btnNewFileExp = document.getElementById("btn-create-new-file");
    if (btnNewFileExp) btnNewFileExp.addEventListener("click", () => createNewUntitledTab());

    const btnSaveFile = document.getElementById("btn-save-file");
    if (btnSaveFile) btnSaveFile.addEventListener("click", saveActiveFile);

    const explorerBtn = document.getElementById("btn-nav-explorer");
    const gitBtn = document.getElementById("btn-nav-git");
    const explorerPanel = document.getElementById("panel-explorer");
    const gitPanel = document.getElementById("panel-git");

    if (explorerBtn && gitBtn) {
        explorerBtn.addEventListener("click", () => {
            explorerBtn.classList.add("bg-[#2d2d2d]", "text-[#e25c34]");
            gitBtn.classList.remove("bg-[#2d2d2d]", "text-[#e25c34]");
            gitBtn.classList.add("text-gray-400");
            if (explorerPanel) explorerPanel.classList.remove("hidden");
            if (gitPanel) gitPanel.classList.add("hidden");
        });

        gitBtn.addEventListener("click", () => {
            gitBtn.classList.add("bg-[#2d2d2d]", "text-[#e25c34]");
            explorerBtn.classList.remove("bg-[#2d2d2d]", "text-[#e25c34]");
            explorerBtn.classList.add("text-gray-400");
            if (gitPanel) gitPanel.classList.remove("hidden");
            if (explorerPanel) explorerPanel.classList.add("hidden");
        });
    }

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
                    file: activeTab.filepath || activeTab.title,
                    filepath: activeTab.filepath || activeTab.title,
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

// 10. Chat UI Messages & Utilities
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

    const msgId = "ai_msg_" + Date.now();
    const div = document.createElement("div");
    div.className = "flex space-x-2 items-start my-1";
    
    let parsedHTML = escapeHTML(text);
    if (typeof marked !== 'undefined') {
        try {
            parsedHTML = marked.parse(text);
        } catch (e) {
            console.error("Marked parsing error:", e);
        }
    }

    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34] border border-[#e25c34]/30 mt-0.5">
            <i class="fa-solid fa-robot text-[11px]"></i>
        </div>
        <div class="bg-[#242424] rounded-lg border border-[#333333] text-gray-200 max-w-[85%] text-xs shadow overflow-hidden flex flex-col">
            <div class="bg-[#1c1c1c] px-2.5 py-1 border-b border-[#333333] flex items-center justify-between text-[10px] text-gray-400">
                <span class="font-mono">AVFenix Copilot</span>
                <button class="hover:text-white flex items-center space-x-1 cursor-pointer transition-colors px-1 py-0.5 rounded bg-[#282828] hover:bg-[#333333]" title="Copiar mensaje" onclick="copyAIMessageText('${msgId}', this)">
                    <i class="fa-regular fa-copy text-[10px]"></i>
                    <span>Copiar</span>
                </button>
            </div>
            <div id="${msgId}" class="p-2.5 chat-markdown-body overflow-x-auto">
                ${parsedHTML}
            </div>
        </div>
    `;
    container.appendChild(div);

    if (typeof hljs !== 'undefined') {
        div.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });
    }

    container.scrollTop = container.scrollHeight;
}

function copyAIMessageText(elementId, btnElement) {
    const msgElement = document.getElementById(elementId);
    if (!msgElement) return;

    const textToCopy = msgElement.innerText || msgElement.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showCopyConfirmation(btnElement);
        }).catch(err => {
            console.error("Clipboard write error:", err);
            fallbackCopyText(textToCopy, btnElement);
        });
    } else {
        fallbackCopyText(textToCopy, btnElement);
    }
}

function fallbackCopyText(text, btnElement) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        showCopyConfirmation(btnElement);
    } catch (err) {
        console.error('Fallback copy failed:', err);
        showNotification("No se pudo copiar el texto", "error");
    }
    document.body.removeChild(textArea);
}

function showCopyConfirmation(btnElement) {
    if (btnElement) {
        const originalHTML = btnElement.innerHTML;
        btnElement.innerHTML = `<i class="fa-solid fa-check text-green-400 text-[10px]"></i><span class="text-green-400 font-semibold">¡Copiado!</span>`;
        setTimeout(() => {
            btnElement.innerHTML = originalHTML;
        }, 2000);
    }
    showNotification("Texto copiado al portapapeles", "success");
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