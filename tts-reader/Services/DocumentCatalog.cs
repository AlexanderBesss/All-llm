using TtsReader.Models;

namespace TtsReader.Services;

public sealed class DocumentCatalog
{
    public static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".md", ".markdown", ".pdf"
    };

    public DocumentNode Build(string rootPath)
    {
        if (!Directory.Exists(rootPath))
            throw new DirectoryNotFoundException($"The folder does not exist: {rootPath}");

        var directory = new DirectoryInfo(rootPath);
        return BuildDirectory(directory, isRoot: true);
    }

    private static DocumentNode BuildDirectory(DirectoryInfo directory, bool isRoot = false)
    {
        var node = new DocumentNode
        {
            Name = isRoot ? directory.FullName : directory.Name,
            FullPath = directory.FullName,
            IsFolder = true
        };

        try
        {
            foreach (var childDirectory in directory.EnumerateDirectories().OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                try
                {
                    var child = BuildDirectory(childDirectory);
                    if (child.Children.Count > 0)
                        node.Children.Add(child);
                }
                catch (UnauthorizedAccessException)
                {
                    // Inaccessible subfolders do not prevent browsing the rest of the root.
                }
                catch (IOException)
                {
                    // A disappearing or unreadable subfolder is skipped.
                }
            }

            foreach (var file in directory.EnumerateFiles()
                         .Where(f => SupportedExtensions.Contains(f.Extension))
                         .OrderBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                node.Children.Add(new DocumentNode { Name = file.Name, FullPath = file.FullName, IsFolder = false });
            }
        }
        catch (UnauthorizedAccessException) when (!isRoot)
        {
        }

        return node;
    }
}
