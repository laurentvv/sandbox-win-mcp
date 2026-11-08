using System;
using System.Drawing;
using System.Windows.Forms;

class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "Sandbox WinForms", ClientSize = new Size(480, 200) };
        var output = new Label { Name = "Output", Text = "Ready", Dock = DockStyle.Bottom, Height = 60 };
        var button = new Button { Name = "Greet", Text = "Greet", Dock = DockStyle.Top, Height = 48 };
        button.Click += (_, _) => output.Text = "Hello from WinForms";
        form.Controls.Add(button);
        form.Controls.Add(output);
        Application.Run(form);
    }
}
