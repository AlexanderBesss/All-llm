# LlmServerManager Guidelines

- Keep WPF controls aligned with the dark visual design; reuse the shared styles in `Styles/` (dark `ToolTip`, `TabControl`, `StyledScrollViewer`) and the `ModernButton`/`StartButton`/`StopButton` styles in `MainWindow.xaml` for new actions.
- Use `./build.ps1` to build and publish the app; pass `-Kill` when a running LlmServerManager instance must be closed forcefully before publishing.
- Server options come from scanning `llm-servers/**/scripts/start-*.ps1`; add a new start script there and the app picks it up — no app change needed.
