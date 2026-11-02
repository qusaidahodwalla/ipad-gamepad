"""Mouse-look smoothing that preserves total movement exactly.

Aim deltas arrive in Wi-Fi-jittered bursts. Instead of injecting each one the moment it arrives,
every delta becomes a segment that drains linearly over the smoothing window, and a ~1 kHz thread
emits the drained amount through Injector.mouse_move (which keeps the fractional remainder, so
sub-pixel movement is never lost). A segment's final tick emits exactly what is left of it, so
over any drag: sum(output) + remainder == sum(input), up to float rounding.

Window 0 (Off) bypasses all of this and injects immediately, as before.
"""

import ctypes
import math
import sys
import threading
import time
from ctypes import wintypes

from injector import Injector

PERIOD = 0.001  # target output period, seconds
DEFAULT_WINDOW_MS = 8  # "Low"
MAX_WINDOW_MS = 100

_CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x2
_TIMER_ALL_ACCESS = 0x1F0003


class Ticker:
    """Absolute-deadline 1 ms pacing with the best timer Windows offers."""

    def __init__(self) -> None:
        self._timer = None
        self._period_raised = False
        self.mode = "time.sleep + spin"
        self._k32 = None
        if sys.platform == "win32":
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateWaitableTimerExW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD)
            k32.CreateWaitableTimerExW.restype = wintypes.HANDLE
            k32.SetWaitableTimer.argtypes = (
                wintypes.HANDLE, ctypes.POINTER(ctypes.c_longlong), wintypes.LONG,
                wintypes.LPVOID, wintypes.LPVOID, wintypes.BOOL,
            )
            k32.SetWaitableTimer.restype = wintypes.BOOL
            k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            k32.WaitForSingleObject.restype = wintypes.DWORD
            k32.CloseHandle.argtypes = (wintypes.HANDLE,)
            self._k32 = k32
            handle = k32.CreateWaitableTimerExW(None, None, _CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, _TIMER_ALL_ACCESS)
            if handle:  # needs Windows 10 1803+
                self._timer = handle
                self.mode = "high-resolution waitable timer"
            else:
                try:
                    ctypes.WinDLL("winmm").timeBeginPeriod(1)
                    self._period_raised = True
                    self.mode = "timeBeginPeriod(1) + spin"
                except OSError:
                    pass
        self._next = time.perf_counter() + PERIOD

    def reset(self) -> None:
        self._next = time.perf_counter() + PERIOD

    def wait(self) -> None:
        """Block until the next 1 ms deadline (returns immediately if we are already late)."""
        remaining = self._next - time.perf_counter()
        if remaining > 0:
            if self._timer:
                due = ctypes.c_longlong(-max(1, int(remaining * 1e7)))  # negative = relative, 100 ns units
                if self._k32.SetWaitableTimer(self._timer, ctypes.byref(due), 0, None, None, False):
                    self._k32.WaitForSingleObject(self._timer, 50)
            else:
                if remaining > 0.002:
                    time.sleep(remaining - 0.0015)
                while time.perf_counter() < self._next:
                    pass  # short spin for the last ~1.5 ms
        self._next += PERIOD
        now = time.perf_counter()
        if now - self._next > 0.05:  # fell far behind (stall/suspend): resume, don't burst
            self._next = now + PERIOD

    def close(self) -> None:
        if self._timer:
            self._k32.CloseHandle(self._timer)
            self._timer = None
        if self._period_raised:
            ctypes.WinDLL("winmm").timeEndPeriod(1)
            self._period_raised = False


def measure_loop(seconds: float = 0.5) -> tuple[float, float, str]:
    """Run the pacing loop with no output. Returns (average Hz, worst gap in ms, timer mode)."""
    ticker = Ticker()
    try:
        ticker.reset()
        stamps = []
        end = time.perf_counter() + seconds
        while True:
            ticker.wait()
            now = time.perf_counter()
            stamps.append(now)
            if now >= end:
                break
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        hz = (len(stamps) - 1) / (stamps[-1] - stamps[0]) if len(stamps) > 1 else 0.0
        return hz, (max(gaps) * 1000 if gaps else 0.0), ticker.mode
    finally:
        ticker.close()


class MouseSmoother:
    def __init__(self, injector: Injector, window_ms: int = DEFAULT_WINDOW_MS):
        self.injector = injector
        self.window_ms = window_ms
        self._lock = threading.Lock()  # guards _segments and every injector.mouse_move call
        self._segments: list[list[float]] = []  # [remaining_x, remaining_y, t_last, t_end]
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._warned = False
        self._thread = threading.Thread(target=self._run, name="mouse-output", daemon=True)

    # ---- lifecycle ----

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        """Stop the output thread and drop anything still buffered."""
        self._stop.set()
        self._wake.set()
        if self._thread.is_alive():
            self._thread.join(timeout=2)
        self.clear()

    # ---- input side (event loop thread) ----

    def set_window(self, ms) -> None:
        try:
            ms = int(ms)
        except (TypeError, ValueError):
            return
        ms = max(0, min(MAX_WINDOW_MS, ms))
        if ms == 0:
            self.flush()  # switching to Off: nothing stays buffered
        self.window_ms = ms

    def add(self, dx: float, dy: float) -> None:
        """Queue relative movement. Non-finite values are ignored so they cannot poison the sums."""
        if not (math.isfinite(dx) and math.isfinite(dy)):
            return
        window = self.window_ms
        if window <= 0:
            with self._lock:
                self.injector.mouse_move(dx, dy)
            return
        now = time.perf_counter()
        with self._lock:
            self._segments.append([dx, dy, now, now + window / 1000.0])
        self._wake.set()

    def flush(self) -> None:
        """Emit everything still buffered right now (finger lifted: no movement is lost)."""
        with self._lock:
            for seg in self._segments:
                self.injector.mouse_move(seg[0], seg[1])
            self._segments.clear()

    def clear(self) -> None:
        """Discard buffered movement and the sub-pixel remainder (release_all: no drift afterwards)."""
        with self._lock:
            self._segments.clear()
            self.injector.reset_remainder()

    # ---- output thread ----

    def _tick(self, now: float) -> None:
        with self._lock:
            ex = ey = 0.0
            keep = []
            for seg in self._segments:
                rx, ry, t_last, t_end = seg
                if now >= t_end:
                    ex += rx  # last tick of this segment: emit exactly what is left
                    ey += ry
                    continue
                frac = (now - t_last) / (t_end - t_last)
                ox, oy = rx * frac, ry * frac
                ex += ox
                ey += oy
                seg[0] = rx - ox
                seg[1] = ry - oy
                seg[2] = now
                keep.append(seg)
            self._segments = keep
            if ex or ey:
                self.injector.mouse_move(ex, ey)

    def _run(self) -> None:
        ticker = Ticker()
        try:
            while not self._stop.is_set():
                with self._lock:
                    idle = not self._segments
                    if idle:
                        self._wake.clear()
                if idle:
                    self._wake.wait()  # no CPU use while nothing is buffered
                    ticker.reset()
                    continue
                ticker.wait()
                try:
                    self._tick(time.perf_counter())
                except Exception as exc:  # e.g. SendInput refused; keep the thread alive
                    if not self._warned:
                        self._warned = True
                        print(f"[mouse] output error: {exc}")
        finally:
            ticker.close()
