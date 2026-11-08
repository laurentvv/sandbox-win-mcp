// Tiny WinForms test app: type a name, click Greet, and it shows + writes a greeting to greeting.txt.
// Built on the host with the inbox .NET Framework compiler, so it runs on a clean Windows install.
// Run with --crash to make it throw an unhandled exception after it shows (to see crash detection work).
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class HelloSandbox : Form
{
    // Control names become UI Automation AutomationIds, so tests can find them without pixels.
    readonly TextBox name = new TextBox { Name = "NameBox", Dock = DockStyle.Top, Font = new Font("Segoe UI", 16) };
    readonly Label output = new Label { Name = "Output", Dock = DockStyle.Top, Height = 60, Font = new Font("Segoe UI", 16), Text = "Who are you?" };
    readonly Button greet = new Button { Name = "GreetButton", Dock = DockStyle.Fill, Text = "Greet", Font = new Font("Segoe UI", 18, FontStyle.Bold) };

    HelloSandbox(bool crash)
    {
        Text = "Hello Sandbox";
        ClientSize = new Size(480, 260);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(greet); Controls.Add(output); Controls.Add(name);
        AcceptButton = greet;
        greet.Click += (s, e) =>
        {
            output.Text = "Hello, " + name.Text + "!";
            File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "greeting.txt"), output.Text);
        };
        if (crash)
        {
            var t = new Timer { Interval = 1500 };
            t.Tick += (s, e) => { t.Stop(); throw new InvalidOperationException("HelloSandbox was asked to crash (--crash)."); };
            t.Start();
        }
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        Application.EnableVisualStyles();
        Application.Run(new HelloSandbox(Array.IndexOf(args, "--crash") >= 0));
    }
}
