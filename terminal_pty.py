import os
import asyncio
from ptyprocess import PtyProcessUnicode

class TerminalPTY:
    def __init__(self, shell="/bin/bash"):
        self.shell = shell
        self.proc = None
        self.loop = None
        self.ws = None

    def start(self, ws, loop):
        """Spawns a shell using ptyprocess and starts reading asynchronously."""
        self.ws = ws
        self.loop = loop

        # Set clean environmental variables for terminal display
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        # Spawn the process in a pseudo-terminal (PTY) using ptyprocess
        self.proc = PtyProcessUnicode.spawn([self.shell, "-l"], env=env)

        # Register non-blocking reader to the asyncio loop
        self.loop.add_reader(self.proc.fileno(), self._on_readable)

    def _on_readable(self):
        """Callback triggered when the PTY file descriptor is readable."""
        if not self.proc:
            return
        try:
            # Read up to 4096 characters (unicode string) from the PTY
            data = self.proc.read(4096)
            if not data:
                # EOF or closed channel
                self.stop()
                return
            
            # Forward terminal output to the WebSocket client asynchronously
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
        """Writes data from the WebSocket client directly to the PTY."""
        if self.proc:
            try:
                # PtyProcessUnicode.write accepts unicode strings and sends them to the process
                self.proc.write(data)
                # Flush the stream to make sure the terminal receives it immediately
                self.proc.flush()
            except Exception as e:
                print(f"Error writing to PTY: {e}")

    def resize(self, rows, cols):
        """Updates the terminal window size (winsize) for responsive layouts."""
        if self.proc:
            try:
                self.proc.setwinsize(rows, cols)
            except Exception as e:
                print(f"Error resizing PTY: {e}")

    def stop(self):
        """Terminates the shell session and cleans up PTY resources."""
        if self.proc:
            try:
                # Unregister the reader from the asyncio loop
                self.loop.remove_reader(self.proc.fileno())
            except Exception:
                pass
            
            try:
                # Send EOF message to frontend to signal termination
                asyncio.run_coroutine_threadsafe(
                    self.ws.send("term_data:\r\n[Terminal finalizado]\r\n"),
                    self.loop
                )
            except Exception:
                pass

            try:
                # Close the process and release the PTY descriptor
                self.proc.close(force=True)
            except Exception:
                pass

            self.proc = None