using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace TtsReader;

public static class WindowChrome
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_2004 = 19;

    public static void UseDarkTitleBar(Window window)
    {
        int useDarkMode = 1;
        var handle = new WindowInteropHelper(window).Handle;
        if (DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDarkMode, sizeof(int)) != 0)
            DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_2004, ref useDarkMode, sizeof(int));
    }

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int attributeValue, int attributeSize);
}
