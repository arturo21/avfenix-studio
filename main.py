import os
import sys
import json
import asyncio
import threading
import websockets
import gi

# Initialize PyGObject bindings for GTK 3 and WebKit2
gi.require_version('Gtk', '3.0')
try:
    gi.require_version('WebKit2', '4.1')
except ValueError:
    gi.require_version('WebKit2', '4.0')

from gi.repository import Gtk, Gdk, Gio, GLib, WebKit2 as WebKit

from terminal_pty import TerminalPTY
from git_manager import GitManager
from ai_agent import AIAgent

class AVFenixStudioApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="org.avfenix.studio", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.win = None
        self.webview = None
        self.pty_terminal = None
        self.git_manager = GitManager()
        self.ai_agent = AIAgent()
        self.loop = None
        self.websocket_connections = set()

    def do_activate(self):
        """Initializes the desktop user interface using GTK 3."""
        if not self.win:
            self.win = Gtk.ApplicationWindow(application=self)
            self.win.set_default_size(1400, 900)
            self.win.set_title("AVFenix Studio IDE (GTK 3)")

            # Create vertical layout box
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            self.win.add(box)

            # WebKit WebView
            self.webview = WebKit.WebView()
            settings = self.webview.get_settings()
            settings.set_enable_developer_extras(True)
            try:
                settings.set_enable_write_console_messages_to_stdout(True)
            except AttributeError:
                pass

            box.pack_start(self.webview, True, True, 0)

            # Locate local HTML assets
            assets_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "assets", "index.html"))
            if not os.path.exists(assets_path):
                assets_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "index.html"))

            self.webview.load_uri(f"file://{assets_path}")
            self.win.show_all()

            # Start WebSocket server in a separate background thread
            threading.Thread(target=self.start_websocket_loop, daemon=True).start()

    def start_websocket_loop(self):
        """Prepares and runs the asyncio event loop in a background thread."""
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        
        self.git_manager.initialize_repo()
        
        async def run_server():
            async with websockets.serve(self.websocket_handler, "127.0.0.1", 8765):
                await asyncio.Future()

        self.loop.run_until_complete(run_server())

    async def websocket_handler(self, websocket):
        """Handles incoming messages and directs requests to terminal, git, or AI modules."""
        self.websocket_connections.add(websocket)
        try:
            async for message in websocket:
                # 1. Terminal stream handler
                if message.startswith("term_data:"):
                    raw_data = message[len("term_data:"):]
                    if self.pty_terminal:
                        await self.pty_terminal.write(raw_data)

                # 2. Terminal resize handler
                elif message.startswith("term_resize:"):
                    try:
                        cols, rows = map(int, message[len("term_resize:"):].split(","))
                        if self.pty_terminal:
                            self.pty_terminal.resize(rows, cols)
                    except ValueError:
                        pass

                # 3. JSON commands dispatcher
                else:
                    try:
                        data = json.loads(message)
                        action = data.get("action")
                        
                        if action == "init_pty":
                            if self.pty_terminal:
                                self.pty_terminal.stop()
                            self.pty_terminal = TerminalPTY()
                            self.pty_terminal.start(websocket, self.loop)
                        
                        elif action == "chat_msg":
                            user_text = data.get("message")
                            selected_model = data.get("model")
                            context_data = data.get("context")
                            
                            async def ws_send_callback(msg):
                                await websocket.send(msg)
                            
                            ai_reply = await self.ai_agent.chat(
                                user_message=user_text,
                                ws_callback=ws_send_callback,
                                model=selected_model,
                                context=context_data
                            )
                            await websocket.send(json.dumps({
                                "action": "chat_reply",
                                "message": ai_reply,
                                "context_file": context_data.get("filepath") if context_data else None
                            }))

                        elif action == "get_files":
                            files = self.list_files_flat(".")
                            await websocket.send(json.dumps({"action": "file_list", "files": files}))

                        elif action == "read_file":
                            filepath = data.get("filepath")
                            try:
                                with open(filepath, "r", encoding="utf-8") as f:
                                    content = f.read()
                                await websocket.send(json.dumps({
                                    "action": "file_content",
                                    "filepath": filepath,
                                    "content": content
                                }))
                            except Exception as e:
                                await websocket.send(json.dumps({"action": "error", "message": str(e)}))

                        elif action == "save_file":
                            filepath = data.get("filepath")
                            content = data.get("content")
                            try:
                                # Ensure directory exists
                                parent_dir = os.path.dirname(filepath)
                                if parent_dir and not os.path.exists(parent_dir):
                                    os.makedirs(parent_dir, exist_ok=True)
                                    
                                with open(filepath, "w", encoding="utf-8") as f:
                                    f.write(content)
                                await websocket.send(json.dumps({
                                    "action": "save_success",
                                    "filepath": filepath
                                }))
                            except Exception as e:
                                await websocket.send(json.dumps({"action": "error", "message": str(e)}))

                        elif action == "delete_file_confirm":
                            filepath = data.get("filepath")
                            try:
                                if os.path.exists(filepath):
                                    os.remove(filepath)
                                await websocket.send(json.dumps({
                                    "action": "delete_success",
                                    "filepath": filepath
                                }))
                            except Exception as e:
                                await websocket.send(json.dumps({"action": "error", "message": str(e)}))

                        elif action == "git_status":
                            status = self.git_manager.get_status()
                            await websocket.send(json.dumps({"action": "git_status", "status": status}))

                        elif action == "git_stage":
                            filepath = data.get("filepath")
                            res = self.git_manager.stage_file(filepath)
                            await websocket.send(json.dumps({"action": "git_result", "result": res}))

                        elif action == "git_stage_all":
                            res = self.git_manager.stage_all()
                            await websocket.send(json.dumps({"action": "git_result", "result": res}))

                        elif action == "git_commit":
                            msg = data.get("message")
                            res = self.git_manager.commit(msg)
                            await websocket.send(json.dumps({"action": "git_result", "result": res}))

                        elif action == "git_push":
                            res = self.git_manager.push()
                            await websocket.send(json.dumps({"action": "git_result", "result": res}))

                        elif action == "git_pull":
                            res = self.git_manager.pull()
                            await websocket.send(json.dumps({"action": "git_result", "result": res}))

                        elif action == "trigger_delete_dialog":
                            filepath = data.get("filepath")
                            GLib.idle_add(self.show_delete_modal, filepath, websocket)

                    except json.JSONDecodeError:
                        pass
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if websocket in self.websocket_connections:
                self.websocket_connections.remove(websocket)
            if self.pty_terminal:
                self.pty_terminal.stop()
                self.pty_terminal = None

    def list_files_flat(self, root_dir):
        """Lists workspace files excluding system and build dependencies."""
        tree = []
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", "venv", ".venv")]
            for file in files:
                rel_path = os.path.relpath(os.path.join(root, file), root_dir)
                if not rel_path.startswith("out/") and rel_path != "avfenix_studio_gtk4.zip":
                    tree.append(rel_path)
        return tree

    def show_delete_modal(self, filepath, websocket):
        """Summons a native GTK 3 confirmation dialog to verify deletion requests from the AI Agent."""
        dialog = Gtk.MessageDialog(
            transient_for=self.win,
            modal=True,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Confirmar Eliminación de Archivo"
        )
        dialog.format_secondary_text(
            f"El Agente de IA de AVFenix Studio ha sugerido eliminar el siguiente archivo:\n\n"
            f"'{filepath}'\n\n"
            f"¿Desea autorizar la eliminación de este archivo en su disco local?"
        )

        def on_response(dialog, response_id):
            if response_id == Gtk.ResponseType.YES:
                asyncio.run_coroutine_threadsafe(
                    websocket.send(json.dumps({"action": "delete_file_approved", "filepath": filepath})),
                    self.loop
                )
            else:
                asyncio.run_coroutine_threadsafe(
                    websocket.send(json.dumps({"action": "delete_file_denied", "filepath": filepath})),
                    self.loop
                )
            dialog.destroy()

        dialog.connect("response", on_response)
        dialog.show_all()

if __name__ == "__main__":
    app = AVFenixStudioApp()
    sys.exit(app.run(sys.argv))