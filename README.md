# AVFenix Studio GTK 3 — Manual de Instalación y Ejecución

AVFenix Studio es un entorno de desarrollo integrado (IDE) ligero, moderno y modular diseñado exclusivamente para Linux de escritorio. Utiliza un stack de interfaz gráfica ultra estable basado en **GTK 3** y **PyGObject (WebKit2GTK)** en Python, combinándose con terminales interactivas y asistentes de IA para un flujo de desarrollo ágil y seguro.

---

## 🛠️ Requisitos del Sistema (Dependencias de Linux)

Antes de instalar las dependencias de Python, es fundamental instalar los bindings nativos y librerías del sistema de Linux correspondientes a GTK 3.

### En Ubuntu / Debian:
```bash
sudo apt update
sudo apt install -y python3-dev python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.0 libgirepository1.0-dev build-essential libcairo2-dev git
```

### En Arch Linux:
```bash
sudo pacman -Syu
sudo pacman -S python pygobject3 gtk3 webkit2gtk cairo pkgconf git
```

---

## 🚀 Instalación y Puesta en Marcha

Sigue estos sencillos pasos para iniciar AVFenix Studio en tu máquina local:

1. **Crear una carpeta para el proyecto y ubicar los archivos:**
   Descarga los archivos desde el panel de **Studio**:
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

3. **Configurar las credenciales de Inteligencia Artificial:**
   Para habilitar el Copiloto de IA con modelos gratuitos de OpenRouter (`openrouter/free`), exporta tu API Key:
   ```bash
   export OPENROUTER_API_KEY="sk-or-v1-tu-clave-de-openrouter"
   ```

4. **Ejecutar la aplicación nativa:**
   ```bash
   source venv/bin/activate
   python3 main.py
   ```

---

## 📂 Arquitectura del Proyecto

- **`main.py`**: El punto de entrada principal. Configura una ventana nativa en GTK 3 utilizando PyGObject, renderiza el componente `WebKit2.WebView` de alto rendimiento para el frontend local y levanta un servidor WebSocket local (`ws://localhost:8765`) en un hilo de fondo asíncrono.
- **`terminal_pty.py`**: Utiliza `ptyprocess` para crear y gestionar la shell interactiva de Linux de forma desacoplada y asíncrona.
- **`git_manager.py`**: Implementa el panel de Git usando `GitPython`. Monitorea cambios locales, gestiona el flujo de staging, consolidación de versiones (commit) y sincronización remota con GitHub.
- **`ai_agent.py`**: Centraliza el comportamiento del copiloto integrado con la API de OpenRouter mediante Tool Calling, inyectando de forma automática el contexto del código activo en el editor.
- **`assets/`**: Contiene la interfaz gráfica que corre sobre el WebKit nativo de GTK 3 (`index.html`, `styles.css`, `app.js`).