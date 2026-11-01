// Mirrors the windows of a desktop app (MATLAB, KiCad, LTspice, ...) into an E-IDE tab.
// Reads commands on stdin, one per line, and writes JSON lines on stdout:
//   list                          -> {"type":"windows","items":[...]}
//   attach <pid,pid,...>          -> streams {"type":"frame",...} for every visible window of those processes
//   fit <width> <height>          -> resizes the app's main window to the tab size
//   mouse <move|down|up|dbl|wheel> <x> <y> <button 0|1|2> <wheelDelta>   (x, y in frame pixels)
//   key <down|up> <virtualKey>    char <codepoint>    release   (lets go of held keys when the tab loses focus)
//   snap                          -> sends the next frame even if nothing changed
//   focus <hwnd>                  -> keyboard input goes to that window from now on (for the agent and reloads)
//   close <hwnd>                  -> asks that window to close, as its close button would
// Windows are captured with PrintWindow, so the app keeps rendering while the IDE covers it,
// and input is posted to the window under the pointer without moving the real mouse.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WinMirror
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
    const uint PW_RENDERFULLCONTENT = 2;

    static readonly object Gate = new object();
    static HashSet<uint> pids = new HashSet<uint>();
    static List<KeyValuePair<IntPtr, RECT>> layout = new List<KeyValuePair<IntPtr, RECT>>(); // top-most first
    static RECT canvas;
    static IntPtr focusTarget = IntPtr.Zero;
    static bool forceFrame;
    static long lastHash;
    static readonly HashSet<int> held = new HashSet<int>(); // keys pressed in the tab, guarded by Gate

    public static void Main()
    {
        SetProcessDPIAware();
        Console.OutputEncoding = new UTF8Encoding(false);
        new Thread(CaptureLoop) { IsBackground = true }.Start();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try { Handle(line.Trim().Split(' ')); }
            catch (Exception e) { Emit("{\"type\":\"error\",\"message\":" + Json(e.Message) + "}"); }
        }
    }

    static void Handle(string[] a)
    {
        switch (a[0])
        {
            case "list": Emit(ListWindows()); break;
            case "attach":
                lock (Gate)
                {
                    pids = new HashSet<uint>(a[1].Split(',').Select(uint.Parse));
                    forceFrame = true;
                }
                foreach (var w in WindowsOf(pids, true)) if (IsIconic(w)) ShowWindow(w, 4); // SW_SHOWNOACTIVATE
                break;
            case "fit": Fit(int.Parse(a[1]), int.Parse(a[2])); break;
            case "mouse": Mouse(a[1], int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5])); break;
            case "key": Key(a[1] == "down", int.Parse(a[2])); break;
            case "release": lock (Gate) held.Clear(); SyncKeys(focusTarget); break;
            case "char": if (focusTarget != IntPtr.Zero) PostMessage(focusTarget, 0x0102, (IntPtr)int.Parse(a[1]), (IntPtr)1); break;
            case "snap": lock (Gate) forceFrame = true; break;
            case "focus": Focus((IntPtr)long.Parse(a[1])); break;
            case "close": PostMessage((IntPtr)long.Parse(a[1]), 0x0010, IntPtr.Zero, IntPtr.Zero); break; // WM_CLOSE
        }
    }

    // Real app windows only: visible, not cloaked, big enough. Minimized windows are kept when asked so they can be restored.
    static List<IntPtr> WindowsOf(HashSet<uint> owners, bool includeMinimized = false)
    {
        var found = new List<IntPtr>();
        EnumWindows((h, p) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (owners != null && !owners.Contains(pid)) return true;
            if (!IsWindowVisible(h)) return true;
            int cloaked;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            if (IsIconic(h)) { if (includeMinimized) found.Add(h); return true; }
            RECT r;
            GetWindowRect(h, out r);
            if (r.R - r.L < 40 || r.B - r.T < 30) return true;
            if (owners == null && ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0 || Title(h).Length == 0)) return true;
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found; // EnumWindows walks top of the z-order first
    }

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ListWindows()
    {
        var items = new List<string>();
        foreach (var h in WindowsOf(null, true))
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (Title(h).Length == 0) continue;
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            items.Add("{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"process\":" + Json(proc) + ",\"title\":" + Json(Title(h)) + "}");
        }
        return "{\"type\":\"windows\",\"items\":[" + string.Join(",", items) + "]}";
    }

    // The largest window is the app's main window; size it to the tab so the mirror is 1:1.
    static void Fit(int w, int h)
    {
        HashSet<uint> owners;
        lock (Gate) owners = pids;
        IntPtr main = IntPtr.Zero;
        long best = 0;
        foreach (var win in WindowsOf(owners))
        {
            RECT r;
            GetWindowRect(win, out r);
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area > best) { best = area; main = win; }
        }
        if (main != IntPtr.Zero && w > 200 && h > 150) SetWindowPos(main, IntPtr.Zero, 0, 0, w, h, 0x0002 | 0x0004 | 0x0010); // NOMOVE|NOZORDER|NOACTIVATE
        lock (Gate) forceFrame = true;
    }

    static void CaptureLoop()
    {
        while (true)
        {
            var started = DateTime.UtcNow;
            try { CaptureOnce(); } catch (Exception e) { Emit("{\"type\":\"error\",\"message\":" + Json(e.Message) + "}"); }
            int spent = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            Thread.Sleep(Math.Max(15, 80 - spent)); // about 12 frames a second
        }
    }

    static void CaptureOnce()
    {
        HashSet<uint> owners;
        bool force;
        lock (Gate) { owners = pids; force = forceFrame; forceFrame = false; }
        if (owners.Count == 0) return;

        var wins = WindowsOf(owners);
        if (wins.Count == 0)
        {
            lock (Gate) layout = new List<KeyValuePair<IntPtr, RECT>>();
            Emit("{\"type\":\"gone\"}");
            Thread.Sleep(500);
            return;
        }

        var placed = new List<KeyValuePair<IntPtr, RECT>>();
        RECT box = new RECT { L = int.MaxValue, T = int.MaxValue, R = int.MinValue, B = int.MinValue };
        foreach (var h in wins)
        {
            RECT r;
            GetWindowRect(h, out r);
            placed.Add(new KeyValuePair<IntPtr, RECT>(h, r));
            box.L = Math.Min(box.L, r.L); box.T = Math.Min(box.T, r.T);
            box.R = Math.Max(box.R, r.R); box.B = Math.Max(box.B, r.B);
        }
        int width = Math.Min(box.R - box.L, 4096), height = Math.Min(box.B - box.T, 4096);

        using (var frame = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(frame))
            {
                g.Clear(Color.FromArgb(30, 30, 30));
                for (int i = placed.Count - 1; i >= 0; i--) // paint bottom-most first
                {
                    RECT r = placed[i].Value;
                    int w = r.R - r.L, h = r.B - r.T;
                    using (var shot = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                    {
                        using (var sg = Graphics.FromImage(shot))
                        {
                            IntPtr hdc = sg.GetHdc();
                            PrintWindow(placed[i].Key, hdc, PW_RENDERFULLCONTENT);
                            sg.ReleaseHdc(hdc);
                        }
                        g.DrawImageUnscaled(shot, r.L - box.L, r.T - box.T);
                    }
                }
            }
            lock (Gate) { layout = placed; canvas = box; }

            long hash = Fingerprint(frame);
            if (!force && hash == lastHash) return;
            lastHash = hash;

            using (var ms = new MemoryStream())
            {
                var enc = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                var prm = new EncoderParameters(1);
                prm.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                frame.Save(ms, enc, prm);
                Emit("{\"type\":\"frame\",\"width\":" + width + ",\"height\":" + height + ",\"title\":" + Json(Title(placed[IndexOfLargest(placed)].Key)) + ",\"jpeg\":\"" + Convert.ToBase64String(ms.ToArray()) + "\"}");
            }
        }
    }

    static int IndexOfLargest(List<KeyValuePair<IntPtr, RECT>> placed)
    {
        int best = 0;
        long area = -1;
        for (int i = 0; i < placed.Count; i++)
        {
            var r = placed[i].Value;
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > area) { area = a; best = i; }
        }
        return best;
    }

    // Cheap change detection: sample a grid of pixels instead of encoding every frame.
    static long Fingerprint(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            long hash = 1469598103934665603L ^ bmp.Width ^ ((long)bmp.Height << 20);
            int stride = data.Stride, rows = bmp.Height;
            byte[] row = new byte[stride];
            for (int y = 0; y < rows; y += 3)
            {
                Marshal.Copy(data.Scan0 + y * stride, row, 0, stride);
                for (int x = 0; x < stride; x += 7) hash = (hash ^ row[x]) * 1099511628211L;
            }
            return hash;
        }
        finally { bmp.UnlockBits(data); }
    }

    // Finds the deepest child window under a frame point, even while the app is covered by the IDE.
    static bool Target(int fx, int fy, out IntPtr target, out POINT client, out POINT screen)
    {
        target = IntPtr.Zero; client = new POINT(); screen = new POINT();
        List<KeyValuePair<IntPtr, RECT>> wins;
        RECT box;
        lock (Gate) { wins = layout; box = canvas; }
        screen = new POINT { X = box.L + fx, Y = box.T + fy };
        foreach (var w in wins)
        {
            RECT r = w.Value;
            if (screen.X < r.L || screen.X >= r.R || screen.Y < r.T || screen.Y >= r.B) continue;
            IntPtr h = w.Key;
            while (true)
            {
                POINT p = screen;
                ScreenToClient(h, ref p);
                IntPtr c = ChildWindowFromPointEx(h, p, 0x0001 | 0x0004); // skip invisible and transparent
                if (c == IntPtr.Zero || c == h) break;
                h = c;
            }
            client = screen;
            ScreenToClient(h, ref client);
            target = h;
            return true;
        }
        return false;
    }

    static IntPtr Pack(int lo, int hi) { return (IntPtr)((hi << 16) | (lo & 0xFFFF)); }

    static void Mouse(string kind, int x, int y, int button, int delta)
    {
        IntPtr h; POINT c, s;
        if (!Target(x, y, out h, out c, out s)) return;
        IntPtr lp = Pack(c.X, c.Y);
        int buttons = button == 0 ? 1 : button == 2 ? 2 : button == 1 ? 0x10 : 0; // MK_LBUTTON / MK_RBUTTON / MK_MBUTTON
        lock (Gate) { if (held.Contains(16)) buttons |= 4; if (held.Contains(17)) buttons |= 8; } // MK_SHIFT / MK_CONTROL for shift- and ctrl-clicks
        int mods = buttons & 0xC;
        uint down = button == 2 ? 0x0204u : button == 1 ? 0x0207u : 0x0201u;
        switch (kind)
        {
            case "move": PostMessage(h, 0x0200, (IntPtr)(button < 0 ? mods : buttons), lp); break;
            case "down":
                GiveFocus(h);
                PostMessage(h, 0x0200, (IntPtr)mods, lp);
                PostMessage(h, down, (IntPtr)buttons, lp);
                break;
            case "up": PostMessage(h, down + 1, (IntPtr)mods, lp); break;
            case "dbl": PostMessage(h, down + 2, (IntPtr)buttons, lp); break;
            case "wheel": PostMessage(h, 0x020A, (IntPtr)((delta << 16) | mods), Pack(s.X, s.Y)); break;
        }
        lock (Gate) forceFrame = true;
    }

    // Focuses the control in the middle of a window, which is the main content area in these apps.
    static void Focus(IntPtr top)
    {
        if (!IsWindow(top)) return;
        RECT r;
        GetWindowRect(top, out r);
        IntPtr h = top;
        while (true)
        {
            POINT p = new POINT { X = (r.L + r.R) / 2, Y = (r.T + r.B) / 2 };
            ScreenToClient(h, ref p);
            IntPtr c = ChildWindowFromPointEx(h, p, 0x0001 | 0x0004);
            if (c == IntPtr.Zero || c == h) break;
            h = c;
        }
        GiveFocus(h);
    }

    // Keyboard input goes to the focused control of the app's thread, so set focus there without activating the app.
    static void GiveFocus(IntPtr h)
    {
        uint pid, thread = GetWindowThreadProcessId(h, out pid), me = GetCurrentThreadId();
        if (AttachThreadInput(me, thread, true))
        {
            SetFocus(h);
            AttachThreadInput(me, thread, false);
        }
        focusTarget = h;
    }

    static readonly int[] ExtendedKeys = { 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 92, 93, 111, 144 };

    // Posted keys do not change the key state, so shortcuts like Ctrl+S would arrive as a plain S.
    // Write the held modifiers into the app thread's key state first, then post the key.
    static void Key(bool down, int vk)
    {
        IntPtr h = focusTarget;
        if (h == IntPtr.Zero || !IsWindow(h)) return;
        bool alt, repeat;
        lock (Gate)
        {
            repeat = down && held.Contains(vk);
            if (down) held.Add(vk); else held.Remove(vk);
            alt = held.Contains(18);
        }
        if (down) SyncKeys(h);
        bool modifier = vk == 16 || vk == 17 || vk == 18;
        bool sys = alt || vk == 18 || vk == 121; // Alt combinations and F10 are system keys (menus)
        long lp = 1 | ((long)MapVirtualKey((uint)vk, 0) << 16);
        if (Array.IndexOf(ExtendedKeys, vk) >= 0) lp |= 1L << 24;
        if (alt) lp |= 1L << 29;
        if (repeat) lp |= 1L << 30;
        if (!down) lp |= 3L << 30;
        uint msg = (sys ? 0x0104u : 0x0100u) + (down ? 0u : 1u); // WM_(SYS)KEYDOWN / WM_(SYS)KEYUP
        PostMessage(h, msg, (IntPtr)vk, (IntPtr)unchecked((int)lp));
        if (!down)
        {
            if (modifier) Thread.Sleep(120); // let the app handle the posted keys before the modifier leaves its key state
            SyncKeys(h);
        }
        lock (Gate) forceFrame = true;
    }

    static uint attachedThread; // the app thread whose key state we share while keys are held

    // Key state is only shared while the threads stay attached, so stay attached until every key is up.
    // Called from the command thread only, since attachment belongs to the calling thread.
    static void SyncKeys(IntPtr h)
    {
        uint me = GetCurrentThreadId(), pid, thread = h != IntPtr.Zero && IsWindow(h) ? GetWindowThreadProcessId(h, out pid) : 0;
        bool any;
        lock (Gate) any = held.Count > 0;
        if (attachedThread != 0 && attachedThread != thread)
        {
            AttachThreadInput(me, attachedThread, false);
            attachedThread = 0;
        }
        if (thread == 0) return;
        if (attachedThread == 0)
        {
            if (!AttachThreadInput(me, thread, true)) return;
            attachedThread = thread;
        }
        try
        {
            var state = new byte[256];
            GetKeyboardState(state);
            foreach (int k in new[] { 16, 17, 18, 160, 161, 162, 163, 164, 165 }) state[k] = 0;
            lock (Gate)
                foreach (int k in held)
                {
                    state[k & 0xFF] = 0x80;
                    if (k == 16) state[160] = 0x80; // VK_LSHIFT
                    if (k == 17) state[162] = 0x80; // VK_LCONTROL
                    if (k == 18) state[164] = 0x80; // VK_LMENU
                }
            SetKeyboardState(state);
        }
        finally
        {
            if (!any)
            {
                AttachThreadInput(me, thread, false);
                attachedThread = 0;
            }
        }
    }

    static readonly object OutGate = new object();
    static void Emit(string json) { lock (OutGate) { Console.Out.Write(json + "\n"); Console.Out.Flush(); } }

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in s ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.AppendFormat("\\u{0:x4}", (int)ch);
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }
}
