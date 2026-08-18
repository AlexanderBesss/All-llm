using TtsReader.Models;

namespace TtsReader.Services;

public sealed class DocumentCatalog : IDocumentCatalog
{
    public DocumentNode Build(string rootPath, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(rootPath))
            throw new DirectoryNotFoundException($"The folder does not exist: {rootPath}");

        cancellationToken.ThrowIfCancellationRequested();
        var directory = new DirectoryInfo(rootPath);
        return BuildDirectory(directory, isRoot: true, cancellationToken);
    }

    private static DocumentNode BuildDirectory(
        DirectoryInfo directory,
        bool isRoot,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
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
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    var child = BuildDirectory(childDirectory, isRoot: false, cancellationToken);
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
                          .Where(f => DocumentFormats.SupportedExtensions.Contains(f.Extension))
                         .OrderBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                cancellationToken.ThrowIfCancellationRequested();
                node.Children.Add(new DocumentNode { Name = file.Name, FullPath = file.FullName, IsFolder = false });
            }
        }
        catch (UnauthorizedAccessException) when (!isRoot)
        {
        }

        return node;
    }
}
