$root = 'F:\fnf replay parser in osu'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:8765/')
$listener.Start()
Write-Host 'Serving on http://localhost:8765/'
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $name = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if (-not $name) { $name = 'index.html' }
  $path = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
  if (-not $path.StartsWith($root)) { $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue }
  if (-not [IO.File]::Exists($path)) { $ctx.Response.StatusCode = 404; $ctx.Response.Close(); continue }
  $ext = [IO.Path]::GetExtension($path).ToLower()
  $ctx.Response.ContentType = switch ($ext) {
    '.html' { 'text/html; charset=utf-8' }
    '.js'   { 'application/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    default { 'application/octet-stream' }
  }
  $bytes = [IO.File]::ReadAllBytes($path)
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
