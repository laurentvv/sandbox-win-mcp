using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

class Program
{
    [STAThread]
    static void Main()
    {
        var output = new TextBlock { Text = "Ready", FontSize = 24, Margin = new Thickness(12) };
        AutomationProperties.SetAutomationId(output, "Output");
        var button = new Button { Content = "Greet", Margin = new Thickness(12), Height = 48 };
        AutomationProperties.SetAutomationId(button, "Greet");
        button.Click += (_, _) => output.Text = "Hello from WPF";
        var panel = new StackPanel();
        panel.Children.Add(button);
        panel.Children.Add(output);
        new Application().Run(new Window { Title = "Sandbox WPF", Width = 480, Height = 240, Content = panel });
    }
}
