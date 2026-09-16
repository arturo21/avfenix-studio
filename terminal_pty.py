import os
import asyncio
from ptyprocess import PtyProcessUnicode

class TerminalPTY:
    def __init__(self, shell=None):
        # Autodetect user's default shell with fallbacks
        self.shell = shell or os.environ.get("SHELL") or "/bin/bash"
        if not os.path.exists(self.shell):
            self.shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
            
        self.proc = None
        self.loop = None
        self.ws = None

    def start(self, ws, loop):
        """Spawns a shell using ptyprocess and starts reading asynchronously."""
        self.ws = ws
        self.loop = loop

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        try:
            self.proc = PtyProcessUnicode.spawn([self.shell, "-l"], env=env)
            self.loop.add_reader(self.proc.fileno(), self._on_readable)
        except Exception as e:
            print(f"Error spawning PTY process: {e}")

    def _on_readable(self):
        """Callback triggered when PTY descriptor is readable."""
        if not self.proc:
            return
        try:
            data = self.proc.read(4096)
            if not data:
                self.stop()
                return
            
            asyncio.run_coroutine_threadsafe(
                self.ws.send(f"term_data:{data}"),
                self.loop
            )
        except EOFError:
            self.stop()
        except Exception as e:
            print(f"Error reading from PTY: {e}")
            self.stop()

    async def write(self, data):
        """Writes data from WebSocket directly to PTY."""
        if self.proc:
            try:
                self.proc.write(data)
                self.proc.flush()
            except Exception as e:
                print(f"Error writing to PTY: {e}")

    def resize(self, rows, cols):
        """Updates terminal winsize for responsive layouts."""
        if self.proc:
            try:
                self.proc.setwinsize(rows, cols)
            except Exception as e:
                print(f"Error resizing PTY: {e}")

    def stop(self):
        """Terminates shell session and cleans up PTY resources."""
        if self.proc:
            try:
                self.loop.remove_reader(self.proc.fileno())
            except Exception:
                pass
            
            try:
                asyncio.run_coroutine_threadsafe(
                    self.ws.send("term_data:\r\n[Terminal finalizado]\r\n"),
                    self.loop
                )
            except Exception:
                pass

            try:
                self.proc.close(force=True)
            except Exception:
                pass

            self.proc = None