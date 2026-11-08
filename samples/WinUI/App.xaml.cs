using Microsoft.UI.Xaml;
using System.IO;

namespace HelloWinUI;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        UnhandledException += (_, args) => LogStartup($"UnhandledException: {args.Message}\n{args.Exception}");
        LogStartup("App constructor: loading App.xaml");
        try { InitializeComponent(); }
        catch (Exception exception) { LogStartup(exception.ToString()); throw; }
        LogStartup("App.xaml loaded");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            LogStartup("Creating MainWindow");
            _window = new MainWindow();
            LogStartup("Activating MainWindow");
            _window.Activate();
            LogStartup("MainWindow activated");
        }
        catch (Exception exception) { LogStartup(exception.ToString()); throw; }
    }

    private static void LogStartup(string message)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SandboxShowcase");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "startup.log"), $"{DateTimeOffset.UtcNow:O} {message}\n");
        }
        catch { /* Diagnostics must not replace the original startup exception. */ }
    }
}
