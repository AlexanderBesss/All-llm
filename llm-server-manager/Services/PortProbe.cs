using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Sockets;

namespace LlmServerManager.Services;

public static class PortProbe
{
    public static bool IsListening(int port)
    {
        try
        {
            using var client = new TcpClient();
            var asyncResult = client.BeginConnect("127.0.0.1", port, null, null);
            if (!asyncResult.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(400)))
                return false;
            client.EndConnect(asyncResult);
            return client.Connected;
        }
        catch
        {
            return false;
        }
    }
}
