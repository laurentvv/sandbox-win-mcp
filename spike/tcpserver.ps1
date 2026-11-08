# Minimal line-protocol exec server: one PowerShell command per connection, returns output then "__EXIT__:<code>".
$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,5985); $l.Start()
while($true){ $c=$l.AcceptTcpClient(); $s=$c.GetStream(); $rd=[IO.StreamReader]::new($s); $w=[IO.StreamWriter]::new($s); $w.AutoFlush=$true
  $cmd=$rd.ReadLine(); $o=& powershell -NoProfile -Command $cmd 2>&1 | Out-String; $w.Write($o); $w.WriteLine("__EXIT__:$LASTEXITCODE"); $c.Close() }
