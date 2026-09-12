#!/bin/bash

# ==============================================================================
# AVFenix Studio wxPython - Script de Automatización de Instalación y Arranque (v5)
# Desarrollado para entornos de escritorio Linux (GNOME/MATE/XFCE/KDE)
# ==============================================================================

set -e # Terminar inmediatamente si ocurre un error

# Colores para salida en consola
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # Sin color

echo -e "${BLUE}======================================================================${NC}"
echo -e "${GREEN}          Iniciando Configuración de AVFenix Studio (wxPython)        ${NC}"
echo -e "${BLUE}======================================================================${NC}"

# 1. Detectar gestor de paquetes e instalar dependencias del sistema operativo
echo -e "\n${YELLOW}[1/4] Comprobando e instalando dependencias del sistema...${NC}"

if [ -f /etc/debian_version ]; then
    echo -e "${BLUE}Sistema basado en Debian/Ubuntu detectado.${NC}"
    echo -e "Se requerirán privilegios de superusuario para instalar paquetes del sistema (sudo)."
    # Instalar wxPython precompilado del sistema si es posible, o dependencias de compresión
    sudo apt-get install -y \
        python3-dev \
        python3-venv \
        python3-wxgtk4.0 \
        libgtk-3-dev \
        libwebkit2gtk-4.0-dev \
        pkg-config \
        git
elif [ -f /etc/arch-release ]; then
    echo -e "${BLUE}Sistema basado en Arch Linux detectado.${NC}"
    echo -e "Se requerirán privilegios de superusuario para instalar paquetes del sistema (sudo)."
    # Arch Linux tiene bindings nativos empaquetados muy estables para wxPython
    sudo pacman -Sy --needed --noconfirm \
        python \
        python-pip \
        wxwidgets-gtk3 \
        python-wxpython \
        freeglut \
        git
else
    echo -e "${RED}Distribución no soportada automáticamente por este script.${NC}"
    echo -e "Asegúrate de instalar manualmente GTK3, WebKit2GTK y wxPython/wxWidgets."
fi

# 2. Reestructurar directorios y ubicar archivos de assets
echo -e "\n${YELLOW}[2/4] Creando estructura de directorios y renombrando archivos de assets...${NC}"

# Crear directorio de assets
mkdir -p assets

# Comprobar y renombrar index_html.txt o assets/index.html
if [ -f "index_html.txt" ]; then
    mv index_html.txt assets/index.html
    echo -e "-> index_html.txt movido a assets/index.html"
elif [ -f "assets/index.html" ]; then
    echo -e "-> assets/index.html ya existe."
else
    echo -e "${RED}Advertencia: No se encontró index_html.txt ni assets/index.html${NC}"
fi

# Comprobar y renombrar styles_css.txt o assets/styles.css
if [ -f "styles_css.txt" ]; then
    mv styles_css.txt assets/styles.css
    echo -e "-> styles_css.txt movido a assets/styles.css"
elif [ -f "assets/styles.css" ]; then
    echo -e "-> assets/styles.css ya existe."
else
    echo -e "${RED}Advertencia: No se encontró styles_css.txt ni assets/styles.css${NC}"
fi

# Comprobar y renombrar app_js.txt o assets/app.js
if [ -f "app_js.txt" ]; then
    mv app_js.txt assets/app.js
    echo -e "-> app_js.txt movido a assets/app.js"
elif [ -f "assets/app.js" ]; then
    echo -e "-> assets/app.js ya existe."
fi

# Procesar archivos de la nueva versión v5 (wxPython limpia de escapes)
if [ -f "main-v4.py" ]; then
    mv main-v4.py main.py
    echo -e "-> main-v4.py (wxPython) renombrado a main.py"
elif [ -f "main-v5.py" ]; then
    mv main-v5.py main.py
    echo -e "-> main-v5.py (wxPython limpia) renombrado a main.py"
elif [ -f "main.py" ]; then
    echo -e "-> main.py ya listo."
fi

if [ -f "requirements-v3.txt" ]; then
    mv requirements-v3.txt requirements.txt
    echo -e "-> requirements-v3.txt renombrado a requirements.txt"
fi

if [ -f "terminal_pty-v2.py" ]; then
    mv terminal_pty-v2.py terminal_pty.py
    echo -e "-> terminal_pty-v2.py (ptyprocess) renombrado a terminal_pty.py"
fi

# Respaldar este instalador
if [ -f "setup_studio-v5.sh" ]; then
    cp setup_studio-v5.sh setup_studio.sh
    echo -e "-> setup_studio-v5.sh respaldado como setup_studio.sh"
fi

# 3. Crear entorno virtual e instalar dependencias de Python
echo -e "\n${YELLOW}[3/4] Creando entorno virtual de Python e instalar dependencias de Python...${NC}"

# Siempre usamos --system-site-packages para wxPython en Linux para evitar compilación pesada de pip
if [ ! -d "venv" ]; then
    python3 -m venv --system-site-packages venv
    echo -e "-> Entorno virtual 'venv' creado con acceso a paquetes del sistema (--system-site-packages)."
else
    echo -e "-> El entorno virtual 'venv' ya existe."
fi

# Activar entorno virtual
source venv/bin/activate

# Actualizar pip e instalar dependencias
pip install --upgrade pip

if [ -f "requirements.txt" ]; then
    # Filtrar wxPython si ya está provisto por el sistema operativo
    if python3 -c "import wx" 2>/dev/null; then
        echo -e "-> wxPython ya está instalado a nivel de sistema. Saltando instalación vía pip..."
        grep -v "wxPython" requirements.txt > requirements_temp.txt || true
        pip install -r requirements_temp.txt
        rm requirements_temp.txt
    else
        pip install -r requirements.txt
    fi
    echo -e "${GREEN}-> Dependencias de Python instaladas correctamente.${NC}"
else
    echo -e "${RED}Error: No se encontró el archivo requirements.txt. No se pudieron instalar las librerías de Python.${NC}"
    exit 1
fi

# 4. Finalización e instrucciones de ejecución
echo -e "\n${YELLOW}[4/4] ¡Instalación completada con éxito!${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo -e "Para iniciar AVFenix Studio (wxPython), sigue estos pasos:"
echo -e "${BLUE}----------------------------------------------------------------------${NC}"
echo -e " 1. Configura tu API Key de OpenRouter:"
echo -e "    export OPENROUTER_API_KEY=\"tu-clave-aqui\""
echo -e ""
echo -e " 2. Activa tu entorno virtual:"
echo -e "    source venv/bin/activate"
echo -e ""
echo -e " 3. Ejecuta el IDE de escritorio:"
echo -e "    python3 main.py"
echo -e "${BLUE}======================================================================${NC}"
