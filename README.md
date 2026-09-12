# AVFenix Studio GTK 3 — Manual de Instalación y Ejecución

AVFenix Studio es un entorno de desarrollo integrado (IDE) ligero, moderno y modular diseñado exclusivamente para Linux de escritorio. Esta versión utiliza un stack de interfaz gráfica ultra estable basado en **GTK 3** y **PyGObject (WebKit2GTK)** en Python, combinándose con terminales interactivas y asistentes de IA integrados con OpenRouter y captura de contexto de la pestaña activa.

---

## 🛠️ Requisitos del Sistema (Dependencias de Linux)

Antes de instalar las dependencias de Python, es fundamental instalar los bindings nativos y librerías del sistema de Linux correspondientes a GTK 3.

### En Ubuntu / Debian:
```bash
sudo apt update
sudo apt install -y python3-dev python3-venv python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.0 libgirepository1.0-dev build-essential libcairo2-dev git
```

### En Arch Linux:
```bash
sudo pacman -Syu
sudo pacman -S python pygobject3 gtk3 webkit2gtk cairo pkgconf git
```

---

## 🚀 Instalación y Puesta en Marcha

Sigue estos sencillos pasos para iniciar AVFenix Studio en tu máquina local:

1. **Crear una carpeta para el proyecto y descargar los archivos:**
   Ubica en un directorio vacío los archivos descargados de tu panel de **Studio**:
   - `main.py`
   - `terminal_pty.py`
   - `git_manager.py`
   - `ai_agent.py`
   - `requirements.txt`
   - `index_html.txt`
   - `styles_css.txt`
   - `app_js.txt`
   - `setup_studio.sh`

2. **Ejecutar el script de automatización:**
   ```bash
   chmod +x setup_studio.sh
   ./setup_studio.sh
   ```
   *Este script instalará las dependencias del sistema, ordenará los archivos de assets, creará el entorno virtual de Python (`venv`) e instalará los requisitos automáticamente.*

3. **Configurar las credenciales de Inteligencia Artificial (OpenRouter):**
   Para habilitar el Copiloto de IA, debes proveer tu API Key de OpenRouter mediante una variable de entorno:
   ```bash
   export OPENROUTER_API_KEY="sk-or-v1-tu-clave-de-openrouter"
   ```

4. **Ejecutar la aplicación nativa:**
   ```bash
   source venv/bin/activate
   python3 main.py
   ```

---

## 🤖 Módulo de Chatbot IA (OpenRouter & Captura de Pestaña Activa)

El asistente de IA integrado en AVFenix Studio cuenta con las siguientes capacidades avanzadas:

1. **Conexión Multimodelo a OpenRouter (`https://openrouter.ai/api/v1`):**
   - Soporte para parametrizar el modelo directamente desde el selector de la interfaz de chat (`openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `deepseek/deepseek-chat`, `google/gemini-2.0-flash-001`, `meta-llama/llama-3.3-70b-instruct`).
   - Manejo seguro de credenciales mediante `OPENROUTER_API_KEY`.
   - Control de errores de cuota (429), autenticación (401) y problemas de red.

2. **Captura Automática del Contexto de la Pestaña Activa:**
   - Detecta el archivo actualmente abierto en el Monaco Editor (`activeFilePath` y contenido del modelo).
   - Barra indicadora visual en el panel de chat con un switch para activar/desactivar el envío de contexto por consulta.
   - Inyección automática del código fuente y lenguaje en el payload de la llamada a la API de OpenRouter.

3. **Interfaz de Chat en Tiempo Real con Formato Markdown:**
   - Renderizado enriquecido mediante `Marked.js` y resaltado de sintaxis con `Highlight.js`.
   - Distintivo o insignia visual en las burbujas de chat para mostrar qué archivo se incluyó como contexto (`📌 Contexto: main.py`).

---

## 📂 Arquitectura del Proyecto

El IDE está estructurado bajo un patrón modular robusto que separa responsabilidades de la siguiente manera:

- **`main.py`**: El punto de entrada principal. Configura una ventana nativa en GTK 3 utilizando PyGObject, renderiza el componente `WebKit2.WebView` de alto rendimiento para el frontend local y levanta un servidor WebSocket local (`ws://localhost:8765`) en un hilo de fondo asíncrono para actuar como bus de mensajería (IPC).
- **`terminal_pty.py`**: Utiliza `ptyprocess` para crear y gestionar la shell interactiva de Linux de forma desacoplada y asíncrona, enrutando de manera óptima las entradas y salidas sin consumir CPU en reposo.
- **`git_manager.py`**: Implementa el panel de Git usando `GitPython`. Monitorea cambios locales, gestiona el flujo de staging, consolidación de versiones (commit) y sincronización remota con GitHub.
- **`ai_agent.py`**: Centraliza el comportamiento del copiloto integrado con la API de OpenRouter mediante Tool Calling y soporte para inyección de la pestaña activa.
- **`assets/`**: Contiene la interfaz gráfica que corre sobre el WebKit nativo de GTK 3 (`index.html`, `styles.css`, `app.js`).

---

## 🔒 Flujo de Seguridad y Confirmación de Cambios (Diff / Accept / Decline)

Como política estricta de seguridad del sistema, el copiloto de IA **nunca** modificará archivos directamente en tu disco sin tu supervisión expresa:

1. Cuando solicitas a la IA que cree o modifique un archivo, llama a la herramienta `write_file`.
2. El backend de Python intercepta este comando y, en lugar de guardarlo directamente, envía un payload de propuesta (`write_proposal`) al frontend.
3. El frontend oculta tu área de edición regular y despliega **Monaco Diff Editor** side-by-side: código original (izquierda) vs. propuesta del agente de IA (derecha).
4. Tienes el control absoluto gracias a los botones interactivos **[Aceptar Cambios]** y **[Rechazar Cambios]**:
   - **Aceptar**: Guarda físicamente el archivo en el disco y actualiza la vista.
   - **Rechazar**: Descarta los cambios e informa a la IA del rechazo para que pueda ajustar su propuesta.
5. Si la IA propone eliminar un archivo (`delete_file`), el sistema de backend gatilla un **Gtk.MessageDialog nativo de GTK 3** en el hilo principal de Linux solicitando confirmación física de borrado.