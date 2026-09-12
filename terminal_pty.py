import os
import pty
import termios
import struct
import fcntl
import asyncio
import subprocess

class TerminalPTY:
    def __init__(self, shell="/bin/bash"):
        self.shell = shell
        self.fd = None
        self.pid = None
        self.read_task = None
        self.ws = None

    def start(self, ws, loop):
        """Spawns a shell under a pty and starts reading asynchronously."""
        self.ws = ws
        # Fork the process with pty
        self.pid, self.fd = pty.fork()

        if self.pid == 0:
            # Child process
            # Set environmental variables for clean terminal display
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            
            # Execute shell
            try:
                os.execl(self.shell, self.shell, "-l")
            except Exception as e:
                print(f"Failed to start shell: {e}")
                os._exit(1)
        else:
            # Parent process
            # Set fd to non-blocking
            fl = fcntl.fcntl(self.fd, fcntl.F_GETFL)
            fcntl.fcntl(self.fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
            
            # Register reader task
            self.read_task = loop.create_task(self.read_from_pty())

    async def read_from_pty(self):
        """Continuously reads from the PTY descriptor and forwards to the WebSocket client."""
        loop = asyncio.get_running_loop()
        while True:
            try:
                # Wait for data using loop.run_in_executor or standard selector read
                # Since the fd is non-blocking, we can read up to 1024 bytes when readable
                data = await self._async_read()
                if not data:
                    break
                # Send binary or text over websocket
                await self.ws.send(f"term_data:{data.decode('utf-8', errors='ignore')}")
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Error reading from PTY: {e}")
                break

    async def _async_read(self):
        """Wrapper to asynchronously read from a non-blocking FD."""
        loop = asyncio.get_running_loop()
        while True:
            try:
                return os.read(self.fd, 4096)
            except BlockingIOError:
                await asyncio.sleep(0.01)
            except OSError:
                return None

    async def write(self, data):
        """Writes data from the WebSocket client directly to the PTY."""
        if self.fd:
            # Write data to the master file descriptor of the PTY
            os.write(self.fd, data.encode('utf-8'))

    def resize(self, rows, cols):
        """Updates the window size (winsize) of the terminal to support responsive terminal layouts."""
        if self.fd:
            # Struct format for winsize: rows, cols, xpixel, ypixel
            size = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, size)

    def stop(self):
        """Terminates the shell session and cleans up file descriptors."""
        if self.read_task:
            self.read_task.cancel()
        if self.fd:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
        if self.pid:
            try:
                os.kill(self.pid, 9)
                os.waitpid(self.pid, 0)
            except OSError:
                pass
            self.pid = None