using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

// PS 5.1 / .NET Framework 4.8 transport: HKDF-SHA256, AES-CBC, then HMAC of the complete envelope.
public sealed class SbxProtocol
{
    const int Version = 2;
    readonly string epoch;
    readonly byte[] key;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 67108864 };
    readonly Dictionary<string, HashSet<long>> received = new Dictionary<string, HashSet<long>> {
        { "request", new HashSet<long>() }, { "response", new HashSet<long>() }
    };
    readonly Dictionary<string, long> highest = new Dictionary<string, long> { { "request", 0 }, { "response", 0 } };
    public SbxProtocol(string keyHex, string bootEpoch) {
        if (keyHex.Length != 64) throw new Exception("Invalid sandbox transport key");
        key = new byte[32];
        for (int i = 0; i < 32; i++) key[i] = Convert.ToByte(keyHex.Substring(i * 2, 2), 16);
        epoch = bootEpoch;
    }
    static byte[] Mac(byte[] k, byte[] text) { using (var h = new HMACSHA256(k)) return h.ComputeHash(text); }
    byte[] Derive(string direction, string purpose) {
        byte[] prk = Mac(Encoding.UTF8.GetBytes(epoch), key);
        return Mac(prk, Encoding.UTF8.GetBytes("sbx/v2/" + direction + "/" + purpose + "\x01"));
    }
    static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    static string Canonical(IDictionary<string, object> f) {
        var fields = new string[] { "version", "epoch", "direction", "counter", "timestamp", "iv", "ciphertext" };
        var parts = new List<string>();
        foreach (string field in fields) parts.Add(Convert.ToString(f[field], CultureInfo.InvariantCulture));
        return String.Join("\n", parts);
    }
    public string Seal(string plaintext, string direction, long counter) {
        if ((direction != "request" && direction != "response") || counter <= 0) throw new Exception("Invalid protocol direction/counter");
        byte[] cipher, iv;
        using (var aes = Aes.Create()) {
            aes.Key = Derive(direction, "encryption"); aes.GenerateIV(); iv = aes.IV;
            using (var encryptor = aes.CreateEncryptor()) {
                byte[] bytes = Encoding.UTF8.GetBytes(plaintext);
                cipher = encryptor.TransformFinalBlock(bytes, 0, bytes.Length);
            }
        }
        var f = new Dictionary<string, object> {
            { "version", Version }, { "epoch", epoch }, { "direction", direction }, { "counter", counter },
            { "timestamp", Now() }, { "iv", Convert.ToBase64String(iv) }, { "ciphertext", Convert.ToBase64String(cipher) }
        };
        f["mac"] = Convert.ToBase64String(Mac(Derive(direction, "authentication"), Encoding.UTF8.GetBytes(Canonical(f))));
        return json.Serialize(f);
    }
    public string Open(string line, string direction, long expectedCounter) {
        var f = json.Deserialize<Dictionary<string, object>>(line);
        if (Convert.ToInt32(f["version"]) != Version) throw new Exception("Sandbox protocol mismatch: expected 2. Start a new sandbox with matching agent files.");
        if (!String.Equals(f["epoch"] as string, epoch, StringComparison.Ordinal)) throw new Exception("The sandbox was restarted/replaced; start a new one.");
        if ((direction != "request" && direction != "response") || (string)f["direction"] != direction) throw new Exception("Invalid authenticated sandbox frame");
        long counter = Convert.ToInt64(f["counter"]), timestamp = Convert.ToInt64(f["timestamp"]);
        if (counter <= 0 || counter > 9007199254740991L) throw new Exception("Invalid sandbox counter");
        byte[] supplied = Convert.FromBase64String((string)f["mac"]);
        byte[] expected = Mac(Derive(direction, "authentication"), Encoding.UTF8.GetBytes(Canonical(f)));
        int diff = supplied.Length ^ expected.Length;
        for (int i = 0; i < expected.Length; i++) diff |= expected[i] ^ (i < supplied.Length ? supplied[i] : 0);
        if (diff != 0) throw new Exception("Sandbox frame authentication failed");
        if (Math.Abs(Now() - timestamp) > 300000) throw new Exception("Sandbox frame timestamp expired");
        var seen = received[direction];
        if ((expectedCounter > 0 && counter != expectedCounter) || seen.Contains(counter) || counter <= highest[direction] - 4096)
            throw new Exception("Sandbox frame replay/counter mismatch");
        string plaintext;
        using (var aes = Aes.Create()) {
            aes.Key = Derive(direction, "encryption"); aes.IV = Convert.FromBase64String((string)f["iv"]);
            using (var decryptor = aes.CreateDecryptor()) {
                byte[] cipher = Convert.FromBase64String((string)f["ciphertext"]);
                plaintext = Encoding.UTF8.GetString(decryptor.TransformFinalBlock(cipher, 0, cipher.Length));
            }
        }
        seen.Add(counter); highest[direction] = Math.Max(highest[direction], counter);
        seen.RemoveWhere(delegate(long n) { return n <= highest[direction] - 4096; });
        return plaintext;
    }
}
