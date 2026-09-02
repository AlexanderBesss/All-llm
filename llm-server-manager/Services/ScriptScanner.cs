using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using LlmServerManager.Models;

namespace LlmServerManager.Services;

public sealed record UpdateDef(string Name, string Path);

public sealed record ServerTabDef(string Key, string Title, string[] ScriptsDirs, UpdateDef[] Updates);

public static class ScriptScanner
{
    private static readonly Dictionary<string, string> TitleOverrides = new(StringComparer.OrdinalIgnoreCase)
    {
        ["dflash"] = "DFlash",
        ["dspark"] = "DSpark",
        ["npu"] = "NPU (OpenVINO)",
        ["embedding"] = "Embedding",
        ["gemma"] = "Gemma",
    };

    public static ServerTabDef[] GetTabs(string repoRoot)
    {
        var llmServers = Path.Combine(repoRoot, "llm-servers");
        return new[]
        {
            new ServerTabDef(
                "beellama",
                "beellama",
                new[] { Path.Combine(llmServers, "beellama", "scripts") },
                new[] { new UpdateDef("Update binaries", Path.Combine(llmServers, "beellama", "update-beellama.ps1")) }),
            new ServerTabDef(
                "llama",
                "llama.cpp (Windows)",
                new[]
                {
                    Path.Combine(llmServers, "llama", "windows", "scripts"),
                    Path.Combine(llmServers, "llama", "windows", "NPU", "scripts"),
                },
                new[]
                {
                    new UpdateDef("Update binaries", Path.Combine(llmServers, "llama", "windows", "update-llama.ps1")),
                    new UpdateDef("Update NPU (OpenVINO)", Path.Combine(llmServers, "llama", "windows", "NPU", "update-npu.ps1")),
                }),
        };
    }

    public static List<ServerScriptOption> ScanTab(ServerTabDef tab)
    {
        var options = new List<ServerScriptOption>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var dir in tab.ScriptsDirs)
        {
            if (!Directory.Exists(dir))
                continue;

            foreach (var file in Directory.GetFiles(dir, "start-*.ps1").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                foreach (var option in ParseScript(file))
                {
                    var key = option.ScriptPath + "|" + string.Join(",", option.StartArgs);
                    if (seen.Add(key))
                        options.Add(option);
                }
            }
        }

        return options;
    }

    private static List<ServerScriptOption> ParseScript(string path)
    {
        var text = File.ReadAllText(path);
        var baseName = Path.GetFileNameWithoutExtension(path);
        var shortName = baseName.StartsWith("start-", StringComparison.OrdinalIgnoreCase)
            ? baseName["start-".Length..]
            : baseName;

        var modeChunks = ExtractModeChunks(text);
        if (modeChunks == null)
            return new List<ServerScriptOption> { BuildOption(TitleFor(shortName), path, Array.Empty<string>(), text, text) };

        return modeChunks
            .Select(modeChunk => BuildOption(
                TitleFor(shortName) + " (" + modeChunk.Mode + ")",
                path,
                new[] { "-" + modeChunk.ParameterName, modeChunk.Mode },
                text,
                modeChunk.Chunk))
            .ToList();
    }

    private static ServerScriptOption BuildOption(string title, string path, string[] args, string text, string body)
    {
        var model = ExtractModel(text);
        var ctx = ExtractInt(body, @"--ctx-size\s+(\d+)");
        var port = ExtractInt(body, @"--port\s+(\d+)");
        var kv = Extract(body, @"--cache-type-k\s+(\S+)");

        var badges = new List<string>();
        if (Regex.IsMatch(body, @"--mmproj")) badges.Add("VISION");
        if (Regex.IsMatch(body, @"--spec-type|--spec-draft-model")) badges.Add("SPEC");
        if (Regex.IsMatch(body, @"--device\s+NPU")) badges.Add("NPU");
        if (Regex.IsMatch(body, @"--embedding")) badges.Add("EMBED");

        var parts = new List<string>();
        if (model != null) parts.Add(model);
        if (ctx > 0) parts.Add("ctx " + FormatCtx(ctx));
        if (kv != null) parts.Add("KV " + kv);
        if (port > 0) parts.Add("port " + port);

        return new ServerScriptOption(
            title,
            string.Join("  ·  ", parts),
            badges.Count > 0 ? string.Join(" · ", badges) : "",
            path,
            args,
            port);
    }

    private static List<(string ParameterName, string Mode, string Chunk)>? ExtractModeChunks(string text)
    {
        var param = Regex.Match(text, @"\[ValidateSet\(\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)\]\s*\[string\]\$(\w+)");
        if (!param.Success)
            return null;

        var modes = Regex.Matches(param.Groups[1].Value, @"'([^']*)'").Select(m => m.Groups[1].Value).ToArray();
        if (modes.Length == 0)
            return null;
        var parameterName = param.Groups[2].Value;

        var labels = Regex.Matches(text, @"(?m)^\s*'([A-Za-z0-9_]+)'\s*\{")
            .Select(m => (Mode: m.Groups[1].Value, Index: m.Index, Length: m.Length))
            .Where(l => modes.Contains(l.Mode))
            .ToList();

        var chunks = new List<(string ParameterName, string Mode, string Chunk)>();
        for (var i = 0; i < labels.Count; i++)
        {
            var start = labels[i].Index + labels[i].Length;
            var end = i + 1 < labels.Count ? labels[i + 1].Index : text.Length;
            chunks.Add((parameterName, labels[i].Mode, text[start..end]));
        }
        return chunks;
    }

    private static string? ExtractModel(string text)
    {
        foreach (Match match in Regex.Matches(text, @"models[\\/][^\s'""|()]+\.gguf"))
        {
            var value = match.Value;
            if (value.Contains("mmproj", StringComparison.OrdinalIgnoreCase))
                continue;

            var idx = value.LastIndexOfAny(new[] { '\\', '/' });
            var fileName = idx >= 0 ? value[(idx + 1)..] : value;
            return Path.GetFileNameWithoutExtension(fileName);
        }
        return null;
    }

    private static string TitleFor(string shortName)
    {
        if (TitleOverrides.TryGetValue(shortName, out var title))
            return title;

        var spaced = shortName.Replace('-', ' ');
        return char.ToUpperInvariant(spaced[0]) + spaced[1..];
    }

    private static int ExtractInt(string body, string pattern)
    {
        var match = Regex.Match(body, pattern);
        return match.Success && int.TryParse(match.Groups[1].Value, out var value) ? value : 0;
    }

    private static string? Extract(string body, string pattern)
    {
        var match = Regex.Match(body, pattern);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string FormatCtx(int ctx) => ctx >= 1000 && ctx % 1000 == 0 ? ctx / 1000 + "k" : ctx.ToString();
}
