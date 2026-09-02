using System.Windows;
using LlmServerManager.ViewModels;

namespace LlmServerManager;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        DataContext = new MainViewModel();
    }
}
