using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Windows.Graphics;

namespace HelloWinUI;

public sealed partial class MainWindow : Window
{
    private int _count;

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    public MainWindow()
    {
        InitializeComponent();
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        AppWindow.Resize(new SizeInt32((int)(520 * scale), (int)(400 * scale)));
    }

    private void GreetRequested(XamlUICommand sender, ExecuteRequestedEventArgs args)
    {
        var name = NameBox.Text.Trim();
        Output.Text = $"Hello, {(name.Length == 0 ? "Sandbox" : name)}!";
    }

    private void IncrementRequested(XamlUICommand sender, ExecuteRequestedEventArgs args) =>
        Counter.Text = $"Count: {++_count}";
}
