"""iPad Gamepad desktop app: the server, the dashboard window and a tray icon in one process.

Closing the window hides it to the tray. Only Quit (tray menu) stops everything: it releases every
held input, removes our virtual pads and stops the mouse smoothing thread. Starting a second copy
just shows the window of the one already running. `run.bat` is unchanged and still runs only the
server.
"""

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

HERE = Path(__file__).resolve().parent
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(HERE / "server"))  # the server modules import each other by plain name

from paths import data_dir, resource_root  # noqa: E402

TITLE = "iPad Gamepad"
DEFAULT_SIZE = (1280, 820)
MIN_SIZE = (480, 360)


def start_log() -> None:
    """A windowed exe has no console: send output to a log file in the data folder."""
    if getattr(sys, "frozen", False) or sys.stdout is None or os.environ.get("PAD_APP_LOG"):
        folder = data_dir()
        folder.mkdir(parents=True, exist_ok=True)
        log = open(folder / "app.log", "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log


def message_box(text: str) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, TITLE, 0x10)


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateMutexW.restype = wintypes.HANDLE
k32.CreateEventW.restype = wintypes.HANDLE
k32.SetEvent.argtypes = (wintypes.HANDLE,)
k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
k32.CloseHandle.argtypes = (wintypes.HANDLE,)
ERROR_ALREADY_EXISTS = 183


class SingleInstance:
    """A named mutex marks the running copy; a named event lets a second launch ask it to show itself."""

    def __init__(self, port: int):
        self.mutex = k32.CreateMutexW(None, False, f"Local\\iPadGamepad-{port}")
        self.first = ctypes.get_last_error() != ERROR_ALREADY_EXISTS
        self.event = k32.CreateEventW(None, False, False, f"Local\\iPadGamepad-show-{port}")
        self.quit_event = k32.CreateEventW(None, False, False, f"Local\\iPadGamepad-quit-{port}")
        self._stop = threading.Event()

    def ask_running_copy_to_show(self) -> None:
        k32.SetEvent(self.event)

    def ask_running_copy_to_quit(self) -> None:
        k32.SetEvent(self.quit_event)

    def listen(self, on_show, on_quit) -> None:
        def run() -> None:
            while not self._stop.is_set():
                if k32.WaitForSingleObject(self.event, 150) == 0:  # WAIT_OBJECT_0
                    on_show()
                if k32.WaitForSingleObject(self.quit_event, 150) == 0:
                    on_quit()

        threading.Thread(target=run, name="single-instance", daemon=True).start()

    def close(self) -> None:
        self._stop.set()

    def release(self) -> None:
        """Let go of the lock handles (a restarted copy retries until the old copy is gone)."""
        for h in (self.mutex, self.event, self.quit_event):
            k32.CloseHandle(h)


def load_geometry(screens) -> dict:
    """The saved window size and position, if it still fits on a screen (a monitor may be gone)."""
    try:
        g = json.loads((data_dir() / "window.json").read_text(encoding="utf-8"))
        w, h = int(g["width"]), int(g["height"])
        out = {"width": max(MIN_SIZE[0], w), "height": max(MIN_SIZE[1], h)}
        if "x" in g and "y" in g:
            x, y = int(g["x"]), int(g["y"])
            if any(x + 120 > s.x and x < s.x + s.width - 120 and y >= s.y - 10 and y < s.y + s.height - 80 for s in screens):
                out.update(x=x, y=y)
        return out
    except Exception:
        return {}


class App:
    def __init__(self) -> None:
        import main  # the server module (plain name: server/ is on the path)
        import dashboard

        self.main = main
        self.runner = main.ServerThread()
        main.restart_hook = self.restart
        self.token = dashboard.DASH_TOKEN
        self.window = None
        self.icon = None
        self.quitting = False
        self._quit_lock = threading.Lock()
        self.quit_event = threading.Event()
        self.restart_requested = False
        self.geometry: dict = {}
        self._save_timer: threading.Timer | None = None

    # ---- window ----

    def show(self) -> None:
        w = self.window
        if w is None:
            return
        try:
            w.show()
            w.restore()
            w.evaluate_js("window.setActive && window.setActive(true)")
        except Exception as exc:
            print(f"[app] show failed: {exc}")

    def hide(self) -> None:
        w = self.window
        if w is None:
            return
        try:
            w.evaluate_js("window.setActive && window.setActive(false)")  # stop live sampling while hidden
            w.hide()
        except Exception as exc:
            print(f"[app] hide failed: {exc}")

    def show_pairing(self) -> None:
        self.show()
        try:
            self.window.evaluate_js("window.showPairing && window.showPairing()")
        except Exception:
            pass

    def on_resized(self, width, height) -> None:
        if width >= MIN_SIZE[0] and height >= MIN_SIZE[1]:
            self.geometry.update(width=int(width), height=int(height))
            self.schedule_save()

    def on_moved(self, x, y) -> None:
        if x > -10000 and y > -10000:  # a minimised window reports -32000
            self.geometry.update(x=int(x), y=int(y))
            self.schedule_save()

    def schedule_save(self) -> None:
        if self._save_timer is not None:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(0.8, self.save_geometry)
        self._save_timer.daemon = True
        self._save_timer.start()

    def save_geometry(self) -> None:
        if "width" not in self.geometry:
            return
        try:
            (data_dir() / "window.json").write_text(json.dumps(self.geometry), encoding="utf-8")
        except OSError:
            pass

    def on_closing(self):
        """The window's X button: hide to the tray instead of closing, unless we are quitting."""
        if self.quitting:
            return True
        # This runs on the window's UI thread: hide from another thread (evaluate_js would deadlock here).
        threading.Thread(target=self.hide, name="hide", daemon=True).start()
        return False

    # ---- tray ----

    def make_tray(self) -> None:
        import pystray
        from PIL import Image

        icon_path = resource_root() / "assets" / "icon.ico"
        image = Image.open(icon_path if icon_path.exists() else resource_root() / "web" / "icon-192.png")
        st = self.main.settings
        menu = pystray.Menu(
            pystray.MenuItem("Show dashboard", lambda *_: self.show(), default=True),
            pystray.MenuItem("Show pairing code", lambda *_: self.show_pairing()),
            pystray.MenuItem("KB/M only mode", lambda *_: self.toggle_kbm(), checked=lambda _i: st.forced or st.saved,
                             enabled=lambda _i: not st.forced),
            pystray.MenuItem("Restart now to apply KB/M change", lambda *_: self.restart(), visible=lambda _i: st.restart_required),
            pystray.MenuItem("Quit", lambda *_: self.quit()),
        )
        self.icon = pystray.Icon("iPadGamepad", image, TITLE, menu)
        self.icon.run_detached()

    def toggle_kbm(self) -> None:
        """Save the opposite KB/M only choice. It needs a restart; the dashboard and tray say so."""
        st = self.main.settings
        st.set_kbm_only(not st.saved)
        print(f"[app] KB/M only mode saved as {st.saved}; restart required: {st.restart_required}")
        if self.icon is not None:
            self.icon.update_menu()

    def restart(self) -> None:
        """Quit the normal way (inputs released, pads removed, smoother stopped), then start a new copy."""
        self.restart_requested = True
        self.quit()

    # ---- lifecycle ----

    def quit(self) -> None:
        """Stop everything. Safe to call from any thread, and more than once."""
        with self._quit_lock:
            if self.quitting:
                return
            self.quitting = True
        print("[app] quitting")
        self.save_geometry()
        if self.window is not None:
            try:
                self.window.destroy()  # ends webview.start() on the main thread
            except Exception:
                pass
        self.quit_event.set()  # releases tray-only mode (no window) if that is where we are

    def finish(self) -> None:
        """Release inputs, stop the server, remove our virtual pads, stop the smoother, remove the tray icon."""
        try:
            self.runner.stop()
        finally:
            if self.icon is not None:
                try:
                    self.icon.stop()
                except Exception:
                    pass

    def run(self) -> int:
        import webview

        port = self.main.PORT
        print(f"[app] starting; data in {data_dir()}")
        if not self.runner.start():
            message_box(self.runner.error or "The server could not start.")
            self.runner.stop()
            return 1
        self.make_tray()
        url = f"http://127.0.0.1:{port}/dashboard/?token={self.token}"
        self.geometry = load_geometry(webview.screens)
        size = {"width": DEFAULT_SIZE[0], "height": DEFAULT_SIZE[1], **self.geometry}
        self.window = webview.create_window(TITLE, url, min_size=MIN_SIZE, resizable=True, **size)
        self.window.events.closing += self.on_closing
        self.window.events.resized += self.on_resized
        self.window.events.moved += self.on_moved
        try:
            # A persistent profile (not pywebview's default private one) so the view, size and filter are remembered.
            webview.start(gui="edgechromium", private_mode=False, storage_path=str(data_dir() / "webview"))
        except Exception as exc:
            print(f"[app] window failed: {exc!r}")
            message_box("The dashboard window could not open. It needs the Microsoft Edge WebView2 runtime "
                        "(included with current Windows 10/11). The tray icon and server keep running until you choose Quit.")
            self.window = None
            self.quit_event.wait()  # tray-only mode until Quit
        self.finish()
        if self.restart_requested:
            self.spawn_new_copy()
        return 0

    @staticmethod
    def spawn_new_copy() -> None:
        cmd = [sys.executable, "--restarted"] if getattr(sys, "frozen", False) else [sys.executable, str(HERE / "app.py"), "--restarted"]
        flags = getattr(subprocess, "DETACHED_PROCESS", 8) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
        subprocess.Popen(cmd, creationflags=flags, close_fds=True, cwd=str(HERE))
        print("[app] started a new copy")


def main() -> int:
    port = int(os.environ.get("PAD_PORT") or 8000)  # same default as server/main.py
    instance = SingleInstance(port)
    if not instance.first and "--restarted" in sys.argv:
        # We were started by the copy that is quitting: wait for it to let go of the lock.
        for _ in range(100):
            instance.release()
            time.sleep(0.2)
            instance = SingleInstance(port)
            if instance.first:
                break
    if not instance.first:
        # A second launch only shows the running copy (or, with --quit, asks it to quit).
        (instance.ask_running_copy_to_quit if "--quit" in sys.argv else instance.ask_running_copy_to_show)()
        return 0
    if "--quit" in sys.argv:
        return 0  # nothing is running
    start_log()  # only the running copy writes the log (a second launch must not truncate it)
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("iPadGamepad.Dashboard")
    app = App()
    instance.listen(app.show, app.quit)
    try:
        return app.run()
    finally:
        instance.close()


if __name__ == "__main__":
    sys.exit(main())
