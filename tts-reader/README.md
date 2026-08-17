# TTS Reader

TTS Reader is a standalone Windows WPF document reader. It browses folders containing `.txt`, `.md`, `.markdown`, and text-based `.pdf` files. Markdown files are rendered in a caret-enabled preview with headings, emphasis, links, images, lists, blockquotes, code, tables, and common Mermaid flowcharts; speech follows the readable rendered content instead of the Markdown source syntax. Plain text and extracted PDF content remain available in the same editor, and speech starts from the current caret through the default audio device.

Use **Settings** to select between the built-in Windows speech processor and a downloadable local voice profile. A sample profile is bundled as the configured source, and the source can be changed to a file, HTTP, or HTTPS URI. Backend packages, configuration, and the active selection are stored under `%LOCALAPPDATA%\TtsReader`. Moving the caret while speech is active cancels the current utterance and immediately starts again from the new position.

Image-only PDFs require OCR and are intentionally not supported.

## Build and test

```powershell
dotnet build .\TtsReader.csproj
dotnet test .\tests\TtsReader.Tests.csproj
```
