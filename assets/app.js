// AVFenix Studio - GTK Frontend Controller
let socket;
let monacoEditor;
let monacoDiffEditor;
let activeFilePath = null;
let xterm;
let xtermFitAddon;
let fileTreeData = [];
let gitStatusData = null;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    initUIControls();
    initThemeToggle();
    initMonaco();
});

// 1. WebSocket Connectivity
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
        // Request workspace files list and git status
        socket.send(JSON.stringify({ action: "get_files" }));
        socket.send(JSON.stringify({ action: "git_status" }));
        // Request terminal PTY spawning
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
        // Try to reconnect every 3 seconds
        setTimeout(initWebSocket, 3000);
    };

    socket.onerror = (err) => {
        console.error("WebSocket connection error:", err);
    };

    socket.onmessage = async (event) => {
        const rawMsg = event.data;

        // Route terminal PTY data
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
                    showNotification(`Archivo '${msg.filepath}' guardado.`, "success");
                    socket.send(JSON.stringify({ action: "get_files" }));
                    socket.send(JSON.stringify({ action: "git_status" }));
                    break;

                case "delete_success":
                    showNotification(`Archivo '${msg.filepath}' eliminado.`, "info");
                    if (activeFilePath === msg.filepath) {
                        activeFilePath = null;
                        const label = document.getElementById("current-file-label");
                        if (label) label.textContent = "Sin archivo abierto";
                        const chatLabel = document.getElementById("chat-active-file-label");
                        if (chatLabel) chatLabel.textContent = "Sin archivo activo";
                        if (monacoEditor) monacoEditor.setValue("");
                    }
                    socket.send(JSON.stringify({ action: "get_files" }));
                    socket.send(JSON.stringify({ action: "git_status" }));
                    break;

                case "write_proposal":
                    // AI propose edit / new file -> Open Monaco Diff Editor
                    openDiffProposal(msg.filepath, msg.content);
                    break;

                case "delete_proposal":
                    // Send to backend main thread to prompt a native GTK Dialog
                    socket.send(JSON.stringify({
                        action: "trigger_delete_dialog",
                        filepath: msg.filepath
                    }));
                    break;

                case "delete_file_approved":
                    // User clicked yes on native dialog, proceed to delete
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
                    // AI responded with text
                    removeChatLoading();
                    addAIMessage(msg.message);
                    break;
            }
        } catch (e) {
            console.error("Error dispatching WS message:", e);
        }
    };
}

// 2. Monaco Editor & Diff Loader
function initMonaco() {
    if (typeof require === "undefined") return;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        const editorElem = document.getElementById('editor-container');
        if (editorElem) {
            monacoEditor = monaco.editor.create(editorElem, {
                value: [
                    '// Selecciona un archivo del explorador para comenzar a programar.',
                    '// AVFenix Studio se conectará dinámicamente con tu compilador y la terminal.'
                ].join('\n'),
                language: 'javascript',
                theme: 'vs-dark',
                automaticLayout: true,
                fontSize: 13,
                tabSize: 4,
                minimap: { enabled: true }
            });
        }

        const diffElem = document.getElementById('diff-editor-body');
        if (diffElem) {
            monacoDiffEditor = monaco.editor.createDiffEditor(diffElem, {
                theme: 'vs-dark',
                automaticLayout: true,
                readOnly: true,
                fontSize: 13
            });
        }
    });
}

// 3. Integrated Xterm.js Terminal
function initXterm() {
    if (xterm || typeof Terminal === "undefined") return;

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
    } else if (typeof WindotFitAddon !== 'undefined' && WindotFitAddon.FitAddon) {
        xtermFitAddon = new WindotFitAddon.FitAddon();
    }

    if (xtermFitAddon) {
        xterm.loadAddon(xtermFitAddon);
    }
    
    const termBody = document.getElementById('terminal-body');
    if (termBody) {
        xterm.open(termBody);
        if (xtermFitAddon && xtermFitAddon.fit) {
            try { xtermFitAddon.fit(); } catch(e) {}
        }
    }

    // Send input keystrokes through WS
    xterm.onData(data => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(`term_data:${data}`);
        }
    });

    // Notify window size changes
    window.addEventListener("resize", () => {
        if (xtermFitAddon && xtermFitAddon.fit) {
            try {
                xtermFitAddon.fit();
                const dims = xtermFitAddon.proposeDimensions();
                if (dims && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(`term_resize:${dims.cols},${dims.rows}`);
                }
            } catch(e) {}
        }
    });
}

// 4. File Tree View Generation
function renderFileTree() {
    const container = document.getElementById("file-tree");
    if (!container) return;
    container.innerHTML = "";

    if (fileTreeData.length === 0) {
        container.innerHTML = `<div class="text-gray-500 italic text-center text-xs p-2">Sin archivos en el proyecto</div>`;
        return;
    }

    // Build hierarchical tree structures
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
            let html = `
                <div class="tree-node-folder flex flex-col">
                    <button class="w-full text-left px-2 py-1 rounded text-gray-300 font-bold flex items-center space-x-1.5 focus:outline-none" onclick="toggleFolderCollapse(this)">
                        <i class="fa-solid fa-chevron-down text-[10px] text-gray-500 transition-transform duration-100"></i>
                        <i class="fa-solid fa-folder text-amber-500 text-xs"></i>
                        <span class="truncate text-xs">${name}</span>
                    </button>
                    <div class="pl-4 flex flex-col space-y-1 tree-folder-content">
            `;
            for (const childName in node) {
                html += generateHTML(node[childName], childName, fullPath);
            }
            html += `</div></div>`;
            return html;
        } else {
            return `
                <button class="tree-node-file w-full text-left px-2 py-0.5 rounded text-gray-400 flex items-center space-x-2 focus:outline-none" onclick="openFile('${fullPath}')">
                    <i class="fa-regular fa-file text-[#e25c34] text-xs"></i>
                    <span class="truncate text-xs">${name}</span>
                </button>
            `;
        }
    }

    let treeHTML = "";
    for (const name in treeRoot) {
        treeHTML += generateHTML(treeRoot[name], name);
    }
    container.innerHTML = treeHTML;
}

function toggleFolderCollapse(btn) {
    const content = btn.nextElementSibling;
    const arrow = btn.querySelector(".fa-chevron-down");
    if (!content) return;
    if (content.classList.contains("hidden")) {
        content.classList.remove("hidden");
        if (arrow) arrow.style.transform = "rotate(0deg)";
    } else {
        content.classList.add("hidden");
        if (arrow) arrow.style.transform = "rotate(-90deg)";
    }
}

// 5. Open and Edit File Content
function openFile(filepath) {
    activeFilePath = filepath;
    const label = document.getElementById("current-file-label");
    if (label) label.textContent = filepath;
    const chatLabel = document.getElementById("chat-active-file-label");
    if (chatLabel) chatLabel.textContent = filepath;
    
    socket.send(JSON.stringify({ action: "read_file", filepath: filepath }));
}

function onFileContentLoaded(filepath, content) {
    if (!monacoEditor) return;
    
    // Guess language based on extension
    let language = 'javascript';
    if (filepath.endsWith('.py')) language = 'python';
    else if (filepath.endsWith('.html')) language = 'html';
    else if (filepath.endsWith('.css')) language = 'css';
    else if (filepath.endsWith('.json')) language = 'json';
    else if (filepath.endsWith('.sh')) language = 'shell';

    const model = monaco.editor.createModel(content, language);
    monacoEditor.setModel(model);
    
    // Listen to changes to enable quick CMD+S / CTRL+S saving
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveActiveFile();
    });
}

function saveActiveFile() {
    if (!activeFilePath || !monacoEditor) return;
    const content = monacoEditor.getValue();
    socket.send(JSON.stringify({
        action: "save_file",
        filepath: activeFilePath,
        content: content
    }));
}

// 6. Sistema de Diff y Aprobación de la IA (Solución anti-congelamiento para WebKitGTK)
function openDiffProposal(filepath, newContent) {
    const diffContainer = document.getElementById("diff-editor-container");
    const diffLabel = document.getElementById("diff-file-label");
        
    if (diffLabel) diffLabel.textContent = filepath;
    if (diffContainer) diffContainer.classList.remove("hidden");

    // 1. Obtener contenido original seguro
    let originalContent = "";
    const activeTab = tabs.find(t => t.id === activeTabId || t.filepath === filepath);
    if (activeTab && activeTab.model) {
        originalContent = activeTab.model.getValue();
    } else if (monacoEditor) {
        originalContent = monacoEditor.getValue();
    }

    let language = getFileLanguage(filepath);

    // 2. Desvincular modelos anteriores del Diff Editor para liberar memoria
    if (monacoDiffEditor) {
        const currentDiffModel = monacoDiffEditor.getModel();
        monacoDiffEditor.setModel(null);
        if (currentDiffModel) {
            if (currentDiffModel.original) try { currentDiffModel.original.dispose(); } catch(e){}
            if (currentDiffModel.modified) try { currentDiffModel.modified.dispose(); } catch(e){}
        }
    }

    // 3. Crear modelos temporales para la comparación
    const originalModel = monaco.editor.createModel(originalContent, language);
    const modifiedModel = monaco.editor.createModel(newContent, language);

    if (monacoDiffEditor) {
        monacoDiffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });
        setTimeout(() => {
            if (monacoDiffEditor) monacoDiffEditor.layout();
        }, 20);
    }

    // 4. Limpieza diferida para evitar colapsar el hilo visual de WebKitGTK
    const closeDiffAndClean = () => {
        // Ocultar primero el panel comparativo
        if (diffContainer) diffContainer.classList.add("hidden");
        
        // Desvincular del Diff Editor antes de destruir los modelos
        if (monacoDiffEditor) {
            monacoDiffEditor.setModel(null);
        }

        // Destruir modelos temporales en el siguiente tick del event loop
        setTimeout(() => {
            try { originalModel.dispose(); } catch(e){}
            try { modifiedModel.dispose(); } catch(e){}
            
            // Recalcular dimensiones del editor principal tras el cambio de DOM
            if (monacoEditor) {
                monacoEditor.layout();
                monacoEditor.focus();
            }
        }, 50);
    };

    // 5. Eventos de los botones de acción
    const btnAccept = document.getElementById("btn-diff-accept");
    const btnDecline = document.getElementById("btn-diff-decline");

    if (btnAccept) {
        btnAccept.onclick = () => {
            // A. Guardar en disco vía WebSocket
            sendSafe({
                action: "save_file",
                filepath: filepath,
                content: newContent
            });

            // B. Actualizar el contenido de la pestaña y del editor principal
            const targetTab = tabs.find(t => t.filepath === filepath || t.id === activeTabId);
            if (targetTab) {
                targetTab.filepath = filepath;
                targetTab.title = filepath.split("/").pop();
                targetTab.content = newContent;
                targetTab.isDirty = false;
                targetTab.isNew = false;
                if (targetTab.model) {
                    targetTab.model.setValue(newContent);
                } else if (monacoEditor) {
                    monacoEditor.setValue(newContent);
                }
            } else if (monacoEditor) {
                monacoEditor.setValue(newContent);
            }

            // C. Cerrar y limpiar diferidamente
            closeDiffAndClean();
            showNotification(`Propuesta aplicada a ${filepath}`, "success");
            addSystemMessage(`Cambios aceptados y guardados en: ${filepath}`);
        };
    }

    if (btnDecline) {
        btnDecline.onclick = () => {
            closeDiffAndClean();
            showNotification("Cambios propuestos rechazados.", "info");
            addSystemMessage(`Cambios propuestos para ${filepath} rechazados.`);
        };
    }
}

function renderGitStatus() {
    const branchLabel = document.getElementById("git-branch");
    const aheadLabel = document.getElementById("git-ahead");
    const behindLabel = document.getElementById("git-behind");
    const filesList = document.getElementById("git-files-list");

    if (!filesList) return;

    if (!gitStatusData || !gitStatusData.is_repo) {
        if (branchLabel) branchLabel.textContent = "No es un repositorio de Git";
        if (aheadLabel) aheadLabel.textContent = "0";
        if (behindLabel) behindLabel.textContent = "0";
        filesList.innerHTML = `<div class="text-gray-500 italic p-1">No hay inicializado ningún repositorio Git</div>`;
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
        filesList.innerHTML = `<div class="text-gray-500 italic p-1">Sin modificaciones pendientes</div>`;
        return;
    }

    if (gitStatusData.modified) {
        gitStatusData.modified.forEach(file => {
            filesList.appendChild(createGitFileRow(file, "modified"));
        });
    }

    if (gitStatusData.staged) {
        gitStatusData.staged.forEach(file => {
            filesList.appendChild(createGitFileRow(file, "staged"));
        });
    }

    if (gitStatusData.untracked) {
        gitStatusData.untracked.forEach(file => {
            filesList.appendChild(createGitFileRow(file, "untracked"));
        });
    }
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
        <span class="truncate pr-2 text-gray-300 font-mono text-[11px]" title="${filepath}">${filepath}</span>
        <div class="flex items-center space-x-2">
            <span class="git-file-status-badge ${badgeClass}">${statusChar}</span>
            ${status !== 'staged' ? `
            <button class="text-[10px] text-[#e25c34] hover:underline" onclick="stageFile('${filepath}')">Prepa</button>
            ` : ''}
        </div>
    `;
    return div;
}

function stageFile(filepath) {
    socket.send(JSON.stringify({ action: "git_stage", filepath: filepath }));
}

// Función helper para envío seguro por WebSocket (previene InvalidStateError) 
function sendSafe(payload) { 
    if (socket && socket.readyState === WebSocket.OPEN) { 
        const data = typeof payload === "string" ? payload : JSON.stringify(payload); 
        socket.send(data); return true; } 
    else { 
        console.warn("WebSocket no está en estado OPEN. Envío cancelado."); 
        showNotification("No hay conexión con el servidor local. Reconectando...", "error"); 
        return false; 
    } 
}

// 8. Navigation Controls
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

    // Git Sync commands
    const btnStageAll = document.getElementById("btn-git-stage-all");
    if (btnStageAll) {
        btnStageAll.addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_stage_all" }));
        });
    }

    const btnCommit = document.getElementById("btn-git-commit");
    if (btnCommit) {
        btnCommit.addEventListener("click", () => {
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

    const btnPull = document.getElementById("btn-git-pull");
    if (btnPull) {
        btnPull.addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_pull" }));
        });
    }

    const btnPush = document.getElementById("btn-git-push");
    if (btnPush) {
        btnPush.addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_push" }));
        });
    }

    const btnGitRefresh = document.getElementById("btn-git-refresh");
    if (btnGitRefresh) {
        btnGitRefresh.addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "git_status" }));
        });
    }

    const btnRefreshFiles = document.getElementById("btn-refresh-files");
    if (btnRefreshFiles) {
        btnRefreshFiles.addEventListener("click", () => {
            socket.send(JSON.stringify({ action: "get_files" }));
        });
    }

    const btnTermClear = document.getElementById("btn-term-clear");
    if (btnTermClear) {
        btnTermClear.addEventListener("click", () => {
            if (xterm) xterm.clear();
        });
    }

    // Chat form handle with Model Selection and Active Tab Context
    const chatForm = document.getElementById("chat-form");
    if (chatForm) {
        chatForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const chatInput = document.getElementById("chat-input");
            const userMsg = chatInput ? chatInput.value.trim() : "";
            if (!userMsg) return;

            // Display user message in pane
            addUserMessage(userMsg);
            if (chatInput) chatInput.value = "";

            // Show loading animation
            showChatLoading();

            // Extract model choice
            const modelSelect = document.getElementById("chat-model-select");
            const selectedModel = modelSelect ? modelSelect.value : "openrouter/free";

            // Extract active tab context if enabled
            const contextCheckbox = document.getElementById("chat-context-checkbox");
            const includeContext = contextCheckbox ? contextCheckbox.checked : true;

            let contextPayload = null;
            if (includeContext && activeFilePath && monacoEditor) {
                let language = 'javascript';
                if (activeFilePath.endsWith('.py')) language = 'python';
                else if (activeFilePath.endsWith('.html')) language = 'html';
                else if (activeFilePath.endsWith('.css')) language = 'css';
                else if (activeFilePath.endsWith('.json')) language = 'json';
                else if (activeFilePath.endsWith('.sh')) language = 'shell';

                contextPayload = {
                    filepath: activeFilePath,
                    language: language,
                    content: monacoEditor.getValue()
                };
            }

            // Send payload via WebSocket
            sendSafe({ 
                action: "chat_msg", 
                message: userMsg, 
                model: selectedModel, 
                context: contextPayload 
            });
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
    
    // Parse markdown if marked is present
    let formattedText = text;
    if (typeof marked !== "undefined" && marked.parse) {
        formattedText = marked.parse(text);
    }

    div.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-[#e25c34]/20 flex items-center justify-center flex-shrink-0 text-[#e25c34]">
            <i class="fa-solid fa-robot text-[11px]"></i>
        </div>
        <div class="bg-[#242424] p-2.5 rounded-lg border border-[#333333] text-gray-300 max-w-[85%] prose prose-invert text-xs leading-relaxed">
            ${formattedText}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    // Highlight code blocks if hljs is present
    if (typeof hljs !== "undefined") {
        div.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });
    }
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

// 10. Notification and Helper functions
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


// Theme Switcher (Dark / Light Mode Toggle)
let currentTheme = 'dark';

function initThemeToggle() {
    const themeBtn = document.getElementById("btn-theme-toggle");
    if (!themeBtn) return;

    themeBtn.addEventListener("click", () => {
        toggleTheme();
    });
}

function toggleTheme() {
    const body = document.body;
    const themeIcon = document.getElementById("theme-icon");
    const themeText = document.getElementById("theme-text");

    if (currentTheme === 'dark') {
        currentTheme = 'light';
        body.classList.add("light-theme");
        
        if (themeIcon) {
            themeIcon.className = "fa-solid fa-sun text-amber-500";
        }
        if (themeText) {
            themeText.textContent = "Modo Oscuro";
        }

        if (window.monaco && monaco.editor) {
            monaco.editor.setTheme('vs');
        }
        showNotification("Modo Claro activado", "info");
    } else {
        currentTheme = 'dark';
        body.classList.remove("light-theme");
        
        if (themeIcon) {
            themeIcon.className = "fa-solid fa-moon text-amber-400";
        }
        if (themeText) {
            themeText.textContent = "Modo Claro";
        }

        if (window.monaco && monaco.editor) {
            monaco.editor.setTheme('vs-dark');
        }
        showNotification("Modo Oscuro activado", "info");
    }
}